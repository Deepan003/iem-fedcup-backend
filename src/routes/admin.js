import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import multer from 'multer';
import {
  AuditLog, Bid, Media, Player, Team, POSITIONS,
} from '../models.js';
import { requireAdmin, signToken } from '../lib/auth.js';
import {
  decrypt, decryptJson, encrypt, encryptJson, friendlyPassword, mask,
} from '../lib/crypto.js';
import { processLogo, processPlayerPhoto, describeImageError } from '../lib/images.js';
import { auctionService } from '../auction/service.js';
import { isOpenPhase } from '../auction/engine.js';
import {
  getSettingsDoc, resolveSections, SECTION_CLEANERS, ValidationError,
} from '../settings.js';
import {
  googleClient, parseServiceAccount, parseSheetId, listTabs, readSheet, explainGoogleError,
} from '../integrations/google.js';
import {
  configureStorage, deleteObject, isCompleteR2, putObject, storageMode, testR2, urlFor,
} from '../integrations/storage.js';
import {
  parseRows, previewImport, commitImport, startPhotoSync, photoJobStatus, retryPlayerPhoto,
} from '../integrations/importer.js';

const router = Router();
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

router.use(requireAdmin);

router.param('id', (req, res, next, id) => (mongoose.isValidObjectId(id) ? next() : res.status(404).json({ error: 'NOT_FOUND' })));

/* -------------------------------- settings -------------------------------- */

router.get('/settings', h(async (req, res) => {
  const doc = await getSettingsDoc();
  res.json(resolveSections(doc.toObject()));
}));

router.put('/settings/:section', h(async (req, res) => {
  const clean = SECTION_CLEANERS[req.params.section];
  if (!clean) return res.status(404).json({ error: 'UNKNOWN_SECTION' });
  const value = clean(req.body || {});
  const doc = await getSettingsDoc();
  doc.set(req.params.section, value);
  doc.markModified(req.params.section);
  await doc.save();
  await AuditLog.create({ type: 'settings', actor: 'admin', data: { section: req.params.section } });
  await auctionService.reload();
  return res.json(value);
}));

router.put('/portal-code', h(async (req, res) => {
  const code = String(req.body?.code || '').trim();
  if (code && code.length < 4) throw new ValidationError('Use at least 4 characters');
  const doc = await getSettingsDoc();
  doc.portalCodeEnc = code ? encrypt(code) : '';
  await doc.save();
  res.json({ ok: true, code: code ? mask(code) : '' });
}));

router.post('/password', h(async (req, res) => {
  const next = String(req.body?.next || '');
  if (next.length < 8) throw new ValidationError('The new password must have at least 8 characters');
  const doc = await getSettingsDoc();
  if (doc.adminPasswordHash && !(await bcrypt.compare(String(req.body?.current || ''), doc.adminPasswordHash))) {
    return res.status(401).json({ error: 'WRONG_PASSWORD' });
  }
  doc.adminPasswordHash = await bcrypt.hash(next, 12);
  doc.adminTokenVersion = (doc.adminTokenVersion ?? 0) + 1;
  await doc.save();
  auctionService.kickAdmins();
  return res.json({ token: signToken({ role: 'admin', tv: doc.adminTokenVersion }, '12h') });
}));

/* ------------------------------ integrations ------------------------------ */

function loadGoogle(doc) {
  const sa = decryptJson(doc.integrations?.googleEnc);
  return sa ? { sa, client: googleClient(sa) } : null;
}

router.get('/integrations', h(async (req, res) => {
  const doc = await getSettingsDoc();
  const sa = decryptJson(doc.integrations?.googleEnc);
  const r2 = decryptJson(doc.integrations?.r2Enc);
  res.json({
    google: sa ? { configured: true, email: sa.client_email, projectId: sa.project_id } : { configured: false },
    r2: r2
      ? {
        configured: isCompleteR2(r2),
        accountId: r2.accountId,
        accessKeyId: mask(r2.accessKeyId),
        secretAccessKey: mask(r2.secretAccessKey),
        bucket: r2.bucket,
        publicUrl: r2.publicUrl,
      }
      : { configured: false },
    sheet: { url: doc.integrations?.sheetUrl || '', tab: doc.integrations?.sheetTab || '' },
    portalCode: doc.portalCodeEnc ? mask(decrypt(doc.portalCodeEnc)) : '',
    storageMode: storageMode(),
  });
}));

router.put('/integrations/google', h(async (req, res) => {
  const sa = parseServiceAccount(req.body?.json);
  const doc = await getSettingsDoc();
  doc.integrations.googleEnc = encryptJson(sa);
  await doc.save();
  await AuditLog.create({ type: 'integration', actor: 'admin', data: { google: sa.client_email } });
  res.json({ ok: true, email: sa.client_email });
}));

router.delete('/integrations/google', h(async (req, res) => {
  const doc = await getSettingsDoc();
  doc.integrations.googleEnc = '';
  await doc.save();
  res.json({ ok: true });
}));

router.put('/integrations/sheet', h(async (req, res) => {
  const url = String(req.body?.url || '').trim();
  if (url) parseSheetId(url);
  const doc = await getSettingsDoc();
  doc.integrations.sheetUrl = url;
  doc.integrations.sheetTab = String(req.body?.tab || '').trim();
  await doc.save();
  res.json({ ok: true });
}));

/** Checks the Google key can open the saved sheet; returns its tabs. */
router.post('/integrations/google/test', h(async (req, res) => {
  const doc = await getSettingsDoc();
  const g = loadGoogle(doc);
  if (!g) throw new ValidationError('Add the Google service-account key first');
  if (!doc.integrations.sheetUrl) {
    await g.client.authorize();
    return res.json({ ok: true, message: `Signed in as ${g.sa.client_email}. Now add the sheet link.` });
  }
  try {
    const info = await listTabs(g.client, parseSheetId(doc.integrations.sheetUrl));
    return res.json({ ok: true, ...info });
  } catch (err) {
    throw new ValidationError(explainGoogleError(err, g.sa));
  }
}));

router.put('/integrations/r2', h(async (req, res) => {
  const doc = await getSettingsDoc();
  const prev = decryptJson(doc.integrations?.r2Enc) || {};
  const b = req.body || {};
  const keep = (field) => (String(b[field] || '').includes('••••') || !b[field] ? prev[field] : String(b[field]).trim());
  const cfg = {
    accountId: String(b.accountId || '').trim(),
    accessKeyId: keep('accessKeyId'),
    secretAccessKey: keep('secretAccessKey'),
    bucket: String(b.bucket || '').trim(),
    publicUrl: String(b.publicUrl || '').trim().replace(/\/+$/, ''),
  };
  if (cfg.publicUrl && !/^https:\/\//.test(cfg.publicUrl)) throw new ValidationError('Public URL must start with https://');
  try {
    await testR2(cfg);
  } catch (err) {
    throw new ValidationError(`R2 test failed: ${err.message}`);
  }
  doc.integrations.r2Enc = encryptJson(cfg);
  await doc.save();
  configureStorage(cfg);
  await AuditLog.create({ type: 'integration', actor: 'admin', data: { r2: cfg.bucket } });
  await auctionService.reload();
  res.json({ ok: true, storageMode: storageMode() });
}));

router.delete('/integrations/r2', h(async (req, res) => {
  const doc = await getSettingsDoc();
  doc.integrations.r2Enc = '';
  await doc.save();
  configureStorage(null);
  await auctionService.reload();
  res.json({ ok: true, storageMode: storageMode() });
}));

/* --------------------------------- import --------------------------------- */

async function readConfiguredSheet() {
  const doc = await getSettingsDoc();
  const g = loadGoogle(doc);
  if (!g) throw new ValidationError('Add the Google service-account key in Integrations first');
  if (!doc.integrations.sheetUrl) throw new ValidationError('Add the sheet link in Integrations first');
  try {
    const values = await readSheet(g.client, parseSheetId(doc.integrations.sheetUrl), doc.integrations.sheetTab);
    return parseRows(values);
  } catch (err) {
    if (err instanceof ValidationError || /header row|POSITION column/.test(err.message)) throw new ValidationError(err.message);
    throw new ValidationError(explainGoogleError(err, g.sa));
  }
}

router.post('/import/preview', h(async (req, res) => {
  const { rows, skipped } = await readConfiguredSheet();
  const preview = await previewImport(rows);
  res.json({
    total: rows.length,
    create: preview.create,
    update: preview.update,
    unchanged: preview.unchanged,
    skipped,
  });
}));

router.post('/import/commit', h(async (req, res) => {
  const { rows } = await readConfiguredSheet();
  const lot = auctionService.engine.state.lot;
  const skipKeys = [];
  if (lot && isOpenPhase(lot.phase)) {
    const onBlock = await Player.findById(lot.playerId, { sheetKey: 1 }).lean();
    if (onBlock?.sheetKey) skipKeys.push(onBlock.sheetKey);
  }
  const preview = await previewImport(rows);
  const result = {
    ...(await commitImport(rows, { skipKeys })),
    total: rows.length,
    unchanged: preview.unchanged,
    skippedOnBlock: skipKeys.length,
  };
  await AuditLog.create({ type: 'import', actor: 'admin', data: result });
  await auctionService.reload();
  res.json(result);
}));

/** Import + photo status for the admin panel: counts, last runs, and how photos stand. */
router.get('/import/status', h(async (req, res) => {
  const [total, fromSheet, withLink, withPhoto, failed, lastImport, lastPhotos] = await Promise.all([
    Player.countDocuments(),
    Player.countDocuments({ sheetKey: { $exists: true, $ne: null } }),
    Player.countDocuments({ photoSource: { $ne: '' } }),
    Player.countDocuments({ photoKey: { $ne: '' } }),
    Player.countDocuments({ photoError: { $ne: '' } }),
    AuditLog.findOne({ type: 'import' }).sort({ at: -1 }).lean(),
    AuditLog.findOne({ type: 'photos' }).sort({ at: -1 }).lean(),
  ]);
  const job = photoJobStatus();
  res.json({
    players: { total, fromSheet },
    lastImport: lastImport ? { at: lastImport.at, ...lastImport.data } : null,
    photos: {
      total,
      withPhoto,
      withLink,
      failed,
      waiting: Math.max(0, withLink - withPhoto - failed),
      noLink: total - withLink,
      running: !!job?.running,
      lastSync: lastPhotos ? { at: lastPhotos.at, ...lastPhotos.data } : null,
    },
  });
}));

router.get('/import/photos', (req, res) => res.json(photoJobStatus()));

router.post('/import/photos', h(async (req, res) => {
  const doc = await getSettingsDoc();
  const g = loadGoogle(doc);
  let lastEmit = 0;
  const job = startPhotoSync({
    googleClient: g?.client || null,
    force: !!req.body?.force,
    onlyFailed: !!req.body?.onlyFailed,
    onProgress: (j) => {
      const now = Date.now();
      if (j.running && now - lastEmit < 400) return;
      lastEmit = now;
      auctionService.io?.to('admin').emit('job', { kind: 'photos', ...j });
      if (!j.running) {
        auctionService.reload().catch((err) => console.error('reload after photos', err));
        AuditLog.create({ type: 'photos', actor: 'admin', data: { total: j.total, ok: j.ok, failed: j.failed.length } }).catch(() => {});
      }
    },
  });
  res.status(202).json(job);
}));

/** Retry one player's photo from its Drive link (e.g. after an error). */
router.post('/players/:id/photo/retry', h(async (req, res) => {
  const doc = await getSettingsDoc();
  const g = loadGoogle(doc);
  let result;
  try {
    result = await retryPlayerPhoto(req.params.id, g?.client || null);
  } catch (err) {
    throw new ValidationError(err.message);
  }
  if (result.ok) await auctionService.reload();
  return res.json(result);
}));

/* -------------------------------- storage --------------------------------- */

const FREE_TIER_BYTES = 512 * 1024 * 1024; // MongoDB Atlas M0

/** How full the database is: whole cluster vs the free 512 MB, with a breakdown. */
router.get('/storage', h(async (req, res) => {
  const db = mongoose.connection.db;
  const own = await db.stats();
  const ownBytes = (own.dataSize || 0) + (own.indexSize || 0);
  const [media] = await Media.aggregate([{ $group: { _id: null, bytes: { $sum: '$size' }, count: { $sum: 1 } } }]);

  const databases = [];
  let totalBytes = ownBytes;
  try {
    const { databases: list } = await db.admin().listDatabases();
    totalBytes = 0;
    for (const d of list) {
      if (['admin', 'local', 'config'].includes(d.name)) continue;
      // eslint-disable-next-line no-await-in-loop
      const s = await mongoose.connection.client.db(d.name).stats();
      const bytes = (s.dataSize || 0) + (s.indexSize || 0);
      totalBytes += bytes;
      databases.push({ name: d.name, bytes, current: d.name === db.databaseName });
    }
  } catch {
    databases.push({ name: db.databaseName, bytes: ownBytes, current: true });
  }
  databases.sort((a, b) => b.bytes - a.bytes);

  res.json({
    limitBytes: FREE_TIER_BYTES,
    totalBytes,
    percent: Math.round((totalBytes / FREE_TIER_BYTES) * 1000) / 10,
    auction: { bytes: ownBytes, database: db.databaseName },
    images: { bytes: media?.bytes || 0, count: media?.count || 0, storedIn: storageMode() },
    databases,
  });
}));

/* ---------------------------------- teams --------------------------------- */

function teamOut(t) {
  return {
    id: String(t._id),
    name: t.name,
    shortName: t.shortName,
    color: t.color,
    logoUrl: urlFor(t.logoKey),
    captainName: t.captainName,
    captainPhotoUrl: urlFor(t.captainPhotoKey),
    budget: t.budget,
    frozen: t.frozen,
    order: t.order,
    hasPassword: !!t.captainPasswordEnc,
  };
}

function cleanTeam(b, partial = false) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = String(b.name || '').trim().slice(0, 60);
    if (!out.name) throw new ValidationError('Team name is required');
  }
  if (b.shortName !== undefined) out.shortName = String(b.shortName).trim().toUpperCase().slice(0, 5);
  if (b.color !== undefined) {
    if (!/^#[0-9a-f]{6}$/i.test(b.color)) throw new ValidationError('Colour must look like #e11d48');
    out.color = b.color;
  }
  if (b.captainName !== undefined) out.captainName = String(b.captainName).trim().slice(0, 60);
  if (b.budget !== undefined) {
    if (b.budget === null || b.budget === '') out.budget = null;
    else {
      const n = Number(b.budget);
      if (!Number.isInteger(n) || n < 0) throw new ValidationError('Budget must be a whole number');
      out.budget = n;
    }
  }
  if (b.frozen !== undefined) out.frozen = !!b.frozen;
  if (b.order !== undefined) out.order = Number(b.order) || 0;
  return out;
}

router.get('/teams', h(async (req, res) => {
  const teams = await Team.find().sort({ order: 1, name: 1 }).lean();
  res.json(teams.map(teamOut));
}));

router.post('/teams', h(async (req, res) => {
  const team = await Team.create(cleanTeam(req.body || {}));
  await auctionService.reload();
  res.status(201).json(teamOut(team));
}));

router.put('/teams/:id', h(async (req, res) => {
  const team = await Team.findByIdAndUpdate(req.params.id, { $set: cleanTeam(req.body || {}, true) }, { returnDocument: 'after' });
  if (!team) return res.status(404).json({ error: 'NOT_FOUND' });
  await auctionService.reload();
  return res.json(teamOut(team));
}));

router.delete('/teams/:id', h(async (req, res) => {
  const owned = await Player.countDocuments({ teamId: req.params.id, status: { $in: ['sold', 'retained'] } });
  if (owned) throw new ValidationError('This team owns players. Undo the sales / remove retained players first.');
  const team = await Team.findByIdAndDelete(req.params.id);
  if (team) {
    await deleteObject(team.logoKey);
    await deleteObject(team.captainPhotoKey);
    auctionService.kickTeam(req.params.id);
  }
  await auctionService.reload();
  res.json({ ok: true });
}));

async function saveTeamImage(req, res, field, folder) {
  if (!req.file) throw new ValidationError('Choose an image file');
  const team = await Team.findById(req.params.id);
  if (!team) return res.status(404).json({ error: 'NOT_FOUND' });
  let img;
  try {
    img = field === 'logoKey' ? await processLogo(req.file.buffer) : await processPlayerPhoto(req.file.buffer);
  } catch (err) {
    throw new ValidationError(describeImageError(err));
  }
  const key = await putObject(`teams/${team._id}/${folder}-${img.hash}.webp`, img.main, 'image/webp');
  if (team[field] && team[field] !== key) await deleteObject(team[field]);
  team[field] = key;
  await team.save();
  await auctionService.reload();
  return res.json(teamOut(team));
}

router.post('/teams/:id/logo', upload.single('file'), h((req, res) => saveTeamImage(req, res, 'logoKey', 'logo')));
router.post('/teams/:id/captain-photo', upload.single('file'), h((req, res) => saveTeamImage(req, res, 'captainPhotoKey', 'captain')));

/** Generates a new captain password; all devices logged in with the old one are logged out. */
router.post('/teams/:id/password', h(async (req, res) => {
  const custom = String(req.body?.password || '').trim();
  if (custom && custom.length < 6) throw new ValidationError('Use at least 6 characters');
  const password = custom || friendlyPassword();
  const team = await Team.findByIdAndUpdate(
    req.params.id,
    { $set: { captainPasswordEnc: encrypt(password) }, $inc: { tokenVersion: 1 } },
    { returnDocument: 'after' },
  );
  if (!team) return res.status(404).json({ error: 'NOT_FOUND' });
  auctionService.kickTeam(String(team._id));
  await AuditLog.create({ type: 'captain_password', actor: 'admin', data: { teamId: String(team._id) } });
  return res.json({ password });
}));

router.get('/teams/:id/password', h(async (req, res) => {
  const team = await Team.findById(req.params.id, { captainPasswordEnc: 1 }).lean();
  if (!team) return res.status(404).json({ error: 'NOT_FOUND' });
  return res.json({ password: team.captainPasswordEnc ? decrypt(team.captainPasswordEnc) : null });
}));

/** Mark a player as retained by a team (existing player by id, or a new one). */
router.post('/teams/:id/retained', h(async (req, res) => {
  const team = await Team.findById(req.params.id).lean();
  if (!team) return res.status(404).json({ error: 'NOT_FOUND' });
  const b = req.body || {};
  const isCaptain = !!b.isCaptain;
  const price = isCaptain ? 0 : Number(b.price);
  if (!Number.isInteger(price) || price < 0) throw new ValidationError('Retention price must be a whole number');
  const extra = { department: String(b.department || '').trim().slice(0, 60), isCaptain };
  let player;
  if (b.playerId) {
    if (!mongoose.isValidObjectId(b.playerId)) throw new ValidationError('Unknown player');
    if (auctionService.isOnBlock(b.playerId)) throw new ValidationError('That player is on the block right now');
    const set = { status: 'retained', teamId: team._id, price, isCaptain };
    if (extra.department) set.department = extra.department;
    player = await Player.findOneAndUpdate(
      { _id: b.playerId, status: { $in: ['available', 'unsold', 'withheld'] } },
      { $set: set },
      { returnDocument: 'after' },
    );
    if (!player) throw new ValidationError('Player not found or already sold/retained');
  } else {
    const position = POSITIONS.includes(b.position) ? b.position : null;
    const name = String(b.name || '').trim();
    if (!name || !position) throw new ValidationError('Name and position are required');
    player = await Player.create({
      name, position, year: String(b.year || ''), status: 'retained', teamId: team._id, price, ...extra,
    });
  }
  if (isCaptain) await setCaptain(team._id, player);
  await AuditLog.create({ type: 'retained', actor: 'admin', data: { teamId: String(team._id), playerId: String(player._id), price, isCaptain } });
  await auctionService.reload();
  return res.status(201).json({ ok: true, playerId: String(player._id) });
}));

/** One captain per team; the captain's name is mirrored onto the team. */
async function setCaptain(teamId, player) {
  await Player.updateMany({ teamId, _id: { $ne: player._id }, isCaptain: true }, { $set: { isCaptain: false } });
  await Team.updateOne({ _id: teamId }, { $set: { captainName: player.name } });
}

/** Edit a retained player or captain; the team purse updates automatically. */
router.put('/teams/:id/retained/:playerId', h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.playerId)) return res.status(404).json({ error: 'NOT_FOUND' });
  const b = req.body || {};
  const set = {};
  if (b.name !== undefined) { set.name = String(b.name).trim().slice(0, 80); if (!set.name) throw new ValidationError('Name is required'); }
  if (b.position !== undefined) { if (!POSITIONS.includes(b.position)) throw new ValidationError('Unknown position'); set.position = b.position; }
  if (b.department !== undefined) set.department = String(b.department).trim().slice(0, 60);
  if (b.year !== undefined) set.year = String(b.year).trim().slice(0, 30);
  if (b.isCaptain !== undefined) set.isCaptain = !!b.isCaptain;
  if (set.isCaptain) set.price = 0;
  else if (b.price !== undefined) {
    const n = Number(b.price);
    if (!Number.isInteger(n) || n < 0) throw new ValidationError('Price must be a whole number');
    set.price = n;
  }
  const p = await Player.findOneAndUpdate({ _id: req.params.playerId, teamId: req.params.id, status: 'retained' }, { $set: set }, { returnDocument: 'after' });
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  if (p.isCaptain) await setCaptain(p.teamId, p);
  await auctionService.reload();
  return res.json({ ok: true });
}));

router.delete('/teams/:id/retained/:playerId', h(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.playerId)) return res.status(404).json({ error: 'NOT_FOUND' });
  const p = await Player.findOneAndUpdate(
    { _id: req.params.playerId, teamId: req.params.id, status: 'retained' },
    { $set: { status: 'available', teamId: null, price: null, isCaptain: false } },
  );
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  await auctionService.reload();
  return res.json({ ok: true });
}));

/* --------------------------------- players -------------------------------- */

function playerOut(p) {
  return {
    id: String(p._id),
    name: p.name,
    position: p.position,
    tier: p.tier,
    year: p.year,
    basePrice: p.basePrice,
    order: p.order,
    status: p.status,
    teamId: p.teamId ? String(p.teamId) : null,
    price: p.price,
    photoUrl: urlFor(p.photoKey),
    thumbUrl: urlFor(p.thumbKey) || urlFor(p.photoKey),
    photoSource: p.photoSource,
    department: p.department || '',
    isCaptain: !!p.isCaptain,
    photoError: p.photoError,
    attributes: p.attributes || {},
    extra: p.extra || {},
  };
}

function cleanPlayer(b, partial) {
  const out = {};
  if (!partial || b.name !== undefined) {
    out.name = String(b.name || '').trim().slice(0, 80);
    if (!out.name) throw new ValidationError('Name is required');
  }
  if (!partial || b.position !== undefined) {
    if (!POSITIONS.includes(b.position)) throw new ValidationError(`Position must be one of ${POSITIONS.join(', ')}`);
    out.position = b.position;
  }
  if (b.tier !== undefined) out.tier = String(b.tier).trim().slice(0, 30);
  if (b.year !== undefined) out.year = String(b.year).trim().slice(0, 30);
  if (b.department !== undefined) out.department = String(b.department).trim().slice(0, 60);
  if (b.order !== undefined) out.order = Number(b.order) || 0;
  if (b.basePrice !== undefined) {
    if (b.basePrice === null || b.basePrice === '') out.basePrice = null;
    else {
      const n = Number(b.basePrice);
      if (!Number.isInteger(n) || n <= 0) throw new ValidationError('Base price must be a positive whole number');
      out.basePrice = n;
    }
  }
  if (b.withheld !== undefined) out.withheld = !!b.withheld;
  if (b.attributes !== undefined) {
    const attrs = {};
    for (const [k, v] of Object.entries(b.attributes || {}).slice(0, 12)) {
      const n = Number(v);
      if (/^[a-z][a-z0-9 _-]{0,20}$/i.test(k) && Number.isFinite(n)) attrs[k] = Math.max(0, Math.min(99, Math.round(n)));
    }
    out.attributes = attrs;
  }
  return out;
}

router.get('/players', h(async (req, res) => {
  const players = await Player.find().sort({ position: 1, order: 1, name: 1 }).lean();
  res.json(players.map(playerOut));
}));

router.post('/players', h(async (req, res) => {
  const { withheld, ...data } = cleanPlayer(req.body || {}, false);
  const p = await Player.create({ ...data, status: withheld ? 'withheld' : 'available' });
  await auctionService.reload();
  res.status(201).json(playerOut(p));
}));

router.put('/players/:id', h(async (req, res) => {
  if (auctionService.isOnBlock(req.params.id)) throw new ValidationError('This player is on the block. Finish or withdraw the lot first.');
  const { withheld, ...data } = cleanPlayer(req.body || {}, true);
  const p = await Player.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  Object.assign(p, data);
  if (withheld !== undefined) {
    if (withheld && ['available', 'unsold'].includes(p.status)) p.status = 'withheld';
    if (!withheld && p.status === 'withheld') p.status = 'available';
  }
  await p.save();
  await auctionService.reload();
  return res.json(playerOut(p));
}));

router.post('/players/bulk', h(async (req, res) => {
  const ids = (req.body?.ids || []).filter((id) => mongoose.isValidObjectId(id) && !auctionService.isOnBlock(id));
  const set = {};
  if (req.body?.tier !== undefined) set.tier = String(req.body.tier).trim().slice(0, 30);
  if (req.body?.basePrice !== undefined) set.basePrice = req.body.basePrice === null ? null : Number(req.body.basePrice);
  if (!ids.length || !Object.keys(set).length) throw new ValidationError('Nothing to update');
  const r = await Player.updateMany({ _id: { $in: ids } }, { $set: set });
  await auctionService.reload();
  res.json({ updated: r.modifiedCount });
}));

router.delete('/players/:id', h(async (req, res) => {
  if (auctionService.isOnBlock(req.params.id)) throw new ValidationError('This player is on the block');
  const p = await Player.findOneAndDelete({ _id: req.params.id, status: { $in: ['available', 'unsold', 'withheld'] } });
  if (!p) throw new ValidationError('Only players who are not sold or retained can be deleted');
  await deleteObject(p.photoKey);
  await deleteObject(p.thumbKey);
  await auctionService.reload();
  return res.json({ ok: true });
}));

router.post('/players/:id/photo', upload.single('file'), h(async (req, res) => {
  if (!req.file) throw new ValidationError('Choose an image file');
  const p = await Player.findById(req.params.id);
  if (!p) return res.status(404).json({ error: 'NOT_FOUND' });
  let img;
  try {
    img = await processPlayerPhoto(req.file.buffer);
  } catch (err) {
    throw new ValidationError(describeImageError(err));
  }
  const mainKey = await putObject(`players/${p._id}/${img.hash}.webp`, img.main, 'image/webp');
  const thumbKey = await putObject(`players/${p._id}/${img.hash}-thumb.webp`, img.thumb, 'image/webp');
  if (p.photoKey && p.photoKey !== mainKey) await deleteObject(p.photoKey);
  if (p.thumbKey && p.thumbKey !== thumbKey) await deleteObject(p.thumbKey);
  Object.assign(p, {
    photoKey: mainKey, thumbKey, photoError: '', photoSyncedFrom: p.photoSource,
  });
  await p.save();
  await auctionService.reload();
  return res.json(playerOut(p));
}));

/** Random order within each position block (fair, unpredictable queue). */
router.post('/players/shuffle', h(async (req, res) => {
  const position = POSITIONS.includes(req.body?.position) ? req.body.position : null;
  const filter = { status: 'available', ...(position ? { position } : {}) };
  const players = await Player.find(filter, { _id: 1 }).lean();
  const ops = players.map((p) => ({ updateOne: { filter: { _id: p._id }, update: { $set: { order: crypto.randomInt(1, 1_000_000) } } } }));
  if (ops.length) await Player.bulkWrite(ops);
  await AuditLog.create({ type: 'shuffle', actor: 'admin', data: { position, count: ops.length } });
  await auctionService.reload();
  res.json({ shuffled: ops.length });
}));

/* --------------------------------- auction -------------------------------- */

router.post('/auction/reset', h(async (req, res) => {
  if (req.body?.confirm !== 'RESET') throw new ValidationError('Type RESET to confirm');
  await auctionService.resetAuction();
  res.json({ ok: true });
}));

router.get('/bids', h(async (req, res) => {
  const filter = req.query.lotSeq ? { lotSeq: Number(req.query.lotSeq) } : {};
  const bids = await Bid.find(filter).sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 200, 1000)).lean();
  res.json(bids);
}));

router.get('/logs', h(async (req, res) => {
  const filter = req.query.type ? { type: String(req.query.type) } : {};
  const logs = await AuditLog.find(filter).sort({ at: -1 }).limit(Math.min(Number(req.query.limit) || 200, 1000)).lean();
  res.json(logs);
}));

router.get('/export.xlsx', h(async (req, res) => {
  const ExcelJS = (await import('exceljs')).default;
  const [players, teams, doc] = await Promise.all([Player.find().sort({ position: 1, name: 1 }).lean(), Team.find().sort({ order: 1, name: 1 }).lean(), getSettingsDoc()]);
  const { auction } = resolveSections(doc.toObject());
  const wb = new ExcelJS.Workbook();
  wb.creator = 'IEM FED Cup';
  const head = (ws, color = 'FF0B0B0C') => {
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  };
  const role = (p) => (p.isCaptain ? 'Captain' : p.status === 'retained' ? 'Retained' : 'Bought');
  const sum = wb.addWorksheet('Summary');
  sum.columns = [{ header: 'Team', key: 'team', width: 26 }, { header: 'Captain', key: 'cap', width: 22 }, { header: 'Players', key: 'n', width: 10 }, { header: 'Budget', key: 'budget', width: 12 }, { header: 'Spent', key: 'spent', width: 12 }, { header: 'Purse left', key: 'left', width: 12 }];
  head(sum);
  for (const t of teams) {
    const squad = players.filter((p) => String(p.teamId) === String(t._id) && ['sold', 'retained'].includes(p.status));
    const spent = squad.reduce((s, p) => s + (p.price || 0), 0);
    const budget = t.budget ?? auction.teamBudget;
    sum.addRow({ team: t.name, cap: t.captainName, n: squad.length, budget, spent, left: budget - spent });
    const ws = wb.addWorksheet(t.name.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31));
    ws.columns = [{ header: '#', key: 'i', width: 5 }, { header: 'Name', key: 'name', width: 26 }, { header: 'Position', key: 'pos', width: 13 }, { header: 'Department', key: 'dept', width: 16 }, { header: 'Year', key: 'year', width: 10 }, { header: 'Role', key: 'role', width: 11 }, { header: 'Price', key: 'price', width: 10 }];
    head(ws, `FF${(t.color || '#0b0b0c').replace('#', '').toUpperCase()}`);
    squad.sort((a, b) => (b.isCaptain - a.isCaptain) || ((b.price || 0) - (a.price || 0)));
    squad.forEach((p, i) => ws.addRow({ i: i + 1, name: p.name, pos: p.position, dept: p.department, year: p.year, role: role(p), price: p.price || 0 }));
    const total = ws.addRow({ name: 'Total', price: spent });
    total.font = { bold: true };
  }
  const all = wb.addWorksheet('All players');
  all.columns = [{ header: 'Name', key: 'name', width: 26 }, { header: 'Position', key: 'pos', width: 13 }, { header: 'Department', key: 'dept', width: 16 }, { header: 'Year', key: 'year', width: 10 }, { header: 'Tier', key: 'tier', width: 10 }, { header: 'Status', key: 'status', width: 11 }, { header: 'Team', key: 'team', width: 24 }, { header: 'Price', key: 'price', width: 10 }];
  head(all);
  const teamName = new Map(teams.map((t) => [String(t._id), t.name]));
  for (const p of players) all.addRow({ name: p.name, pos: p.position, dept: p.department, year: p.year, tier: p.tier, status: p.isCaptain ? 'captain' : p.status, team: p.teamId ? teamName.get(String(p.teamId)) : '', price: p.price ?? '' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', `attachment; filename="fedcup-auction-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

router.get('/export.csv', h(async (req, res) => {
  const [players, teams] = await Promise.all([
    Player.find().sort({ position: 1, name: 1 }).lean(),
    Team.find().lean(),
  ]);
  const teamName = new Map(teams.map((t) => [String(t._id), t.name]));
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Name', 'Position', 'Year', 'Tier', 'Status', 'Team', 'Price', 'Lot'].map(cell).join(',')];
  for (const p of players) {
    lines.push([p.name, p.position, p.year, p.tier, p.status, p.teamId ? teamName.get(String(p.teamId)) : '', p.price ?? '', p.lotSeq ?? '']
      .map(cell).join(','));
  }
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="fedcup-auction-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`﻿${lines.join('\r\n')}`);
}));

export default router;
