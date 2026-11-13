import { Player, POSITIONS } from '../models.js';
import { driveFileId, downloadDriveFile } from './google.js';
import { processPlayerPhoto, describeImageError } from '../lib/images.js';
import { putObject, deleteObject } from './storage.js';

/* ------------------------------ sheet rows ----------------------------- */

const HEADER_ALIASES = {
  name: ['name', 'player name', 'full name', 'player'],
  position: ['position', 'pos', 'playing position', 'role'],
  tier: ['tier', 'category', 'grade'],
  photo: ['photo', 'picture', 'image', 'photo link', 'upload photo'],
  year: ['year', 'academic year', 'batch'],
};

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ');
export const playerKey = (name) => norm(name).toLowerCase();

export function normalizePosition(raw) {
  const s = norm(raw).toLowerCase();
  if (!s) return null;
  if (/^(gk|goal|keeper)/.test(s)) return 'Goalkeeper';
  if (/^(def|cb|lb|rb|back)/.test(s)) return 'Defender';
  if (/^(mid|cm|cdm|cam|dm|am)/.test(s)) return 'Midfielder';
  if (/^(for|fw|st|att|striker|wing|cf|lw|rw)/.test(s)) return 'Forward';
  const exact = POSITIONS.find((p) => p.toLowerCase() === s);
  return exact || null;
}

/**
 * Turns raw sheet values into player rows. Section-title rows (e.g. "DEFENDER" with no
 * position) and blank rows are skipped; duplicates are reported.
 */
export function parseRows(values) {
  const headerIdx = values.findIndex((r) => r.some((c) => HEADER_ALIASES.name.includes(norm(c).toLowerCase())));
  if (headerIdx === -1) throw new Error('Could not find a header row with a NAME column');
  const header = values[headerIdx].map((c) => norm(c));
  const col = {};
  header.forEach((h, i) => {
    const lower = h.toLowerCase();
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      if (col[field] == null && aliases.includes(lower)) col[field] = i;
    }
  });
  if (col.position == null) throw new Error('Could not find a POSITION column');
  const known = new Set(Object.values(col));

  const rows = [];
  const skipped = [];
  const seen = new Map();
  values.slice(headerIdx + 1).forEach((r, i) => {
    const rowNo = headerIdx + i + 2; // 1-based sheet row
    const name = norm(r[col.name]);
    const positionRaw = norm(r[col.position]);
    if (!name && !positionRaw) return;
    if (!positionRaw) {
      skipped.push({ row: rowNo, name, reason: 'Section heading / no position' });
      return;
    }
    if (!name) {
      skipped.push({ row: rowNo, name: '', reason: 'Missing name' });
      return;
    }
    const position = normalizePosition(positionRaw);
    if (!position) {
      skipped.push({ row: rowNo, name, reason: `Unknown position "${positionRaw}"` });
      return;
    }
    const key = playerKey(name);
    if (seen.has(key)) {
      skipped.push({ row: rowNo, name, reason: `Duplicate of row ${seen.get(key)}` });
      return;
    }
    seen.set(key, rowNo);
    const extra = {};
    header.forEach((h, j) => {
      if (h && !known.has(j) && norm(r[j])) extra[h] = norm(r[j]);
    });
    rows.push({
      row: rowNo,
      sheetKey: key,
      name,
      position,
      tier: col.tier != null ? norm(r[col.tier]) : '',
      year: col.year != null ? norm(r[col.year]) : '',
      photoSource: col.photo != null ? norm(r[col.photo]) : '',
      extra,
    });
  });
  return { rows, skipped };
}

/** Compares parsed rows with the DB. Nothing is written. */
export async function previewImport(rows) {
  const existing = await Player.find({ sheetKey: { $in: rows.map((r) => r.sheetKey) } }).lean();
  const byKey = new Map(existing.map((p) => [p.sheetKey, p]));
  const out = { create: [], update: [], unchanged: 0 };
  for (const r of rows) {
    const p = byKey.get(r.sheetKey);
    if (!p) {
      out.create.push(r);
      continue;
    }
    const changes = [];
    if (p.position !== r.position) changes.push(`position ${p.position} → ${r.position}`);
    if (r.tier && p.tier !== r.tier) changes.push(`tier ${p.tier || '—'} → ${r.tier}`);
    if (p.year !== r.year) changes.push(`year ${p.year || '—'} → ${r.year}`);
    if (p.photoSource !== r.photoSource) changes.push('photo link');
    if (p.name !== r.name) changes.push('name spelling');
    if (changes.length) out.update.push({ ...r, changes, status: p.status });
    else out.unchanged += 1;
  }
  return out;
}

/**
 * Upserts rows. Auction results (status/team/price) are never touched, and the tier is only
 * overwritten when the sheet actually has a value (so tiers set in the panel survive).
 */
export async function commitImport(rows, { skipKeys = [] } = {}) {
  const skip = new Set(skipKeys);
  const ops = rows.filter((r) => !skip.has(r.sheetKey)).map((r) => {
    const set = {
      name: r.name, position: r.position, year: r.year, photoSource: r.photoSource, extra: r.extra,
    };
    if (r.tier) set.tier = r.tier;
    return {
      updateOne: {
        filter: { sheetKey: r.sheetKey },
        update: { $set: set, $setOnInsert: { sheetKey: r.sheetKey, status: 'available' } },
        upsert: true,
      },
    };
  });
  if (!ops.length) return { created: 0, updated: 0 };
  const res = await Player.bulkWrite(ops, { ordered: false });
  return { created: res.upsertedCount, updated: res.modifiedCount };
}

/* ------------------------------ photo sync ----------------------------- */

let currentJob = null;

export const photoJobStatus = () => currentJob;

/** Downloads one player's Drive photo (HEIC is converted automatically) and stores it. */
async function syncOne(p, googleClient) {
  try {
    const id = driveFileId(p.photoSource);
    if (!id) throw new Error('Not a Google Drive link');
    const file = await downloadDriveFile(googleClient, id);
    const img = await processPlayerPhoto(file.buffer);
    const mainKey = await putObject(`players/${p._id}/${img.hash}.webp`, img.main, 'image/webp');
    const thumbKey = await putObject(`players/${p._id}/${img.hash}-thumb.webp`, img.thumb, 'image/webp');
    if (p.photoKey && p.photoKey !== mainKey) await deleteObject(p.photoKey);
    if (p.thumbKey && p.thumbKey !== thumbKey) await deleteObject(p.thumbKey);
    await Player.updateOne({ _id: p._id }, {
      $set: {
        photoKey: mainKey, thumbKey, photoSyncedFrom: p.photoSource, photoError: '',
      },
    });
    return { ok: true };
  } catch (err) {
    const reason = err?.response?.status === 404 || err?.response?.status === 403
      ? 'No access to this file. Share the photo folder with the service account.'
      : describeImageError(err);
    await Player.updateOne({ _id: p._id }, { $set: { photoError: reason } });
    return { ok: false, reason };
  }
}

/** Retry a single player's photo from its Drive link. */
export async function retryPlayerPhoto(playerId, googleClient) {
  const p = await Player.findById(playerId).lean();
  if (!p) throw new Error('Player not found');
  if (!p.photoSource) throw new Error('This player has no photo link in the sheet. Upload a photo instead.');
  return syncOne(p, googleClient);
}

/**
 * Downloads players' Drive photos, converts them to WebP and stores them.
 * Default: only players without a photo (or whose link changed) — so it also resumes an
 * interrupted sync. `onlyFailed` retries just the ones that errored; `force` redoes everything.
 * Runs in the background; progress is reported through `onProgress`.
 */
export function startPhotoSync({
  googleClient, force = false, onlyFailed = false, onProgress,
}) {
  if (currentJob?.running) throw new Error('A photo sync is already running');
  const job = {
    running: true, total: 0, done: 0, ok: 0, failed: [], skipped: 0, startedAt: Date.now(),
  };
  currentJob = job;

  (async () => {
    const players = await Player.find({ photoSource: { $ne: '' } }).lean();
    const todo = players.filter((p) => {
      if (onlyFailed) return !!p.photoError;
      return force || !p.photoKey || p.photoSyncedFrom !== p.photoSource;
    });
    job.total = todo.length;
    job.skipped = players.length - todo.length;
    onProgress?.(job);

    const worker = async () => {
      while (todo.length) {
        const p = todo.shift();
        const r = await syncOne(p, googleClient);
        if (r.ok) job.ok += 1;
        else job.failed.push({ playerId: String(p._id), name: p.name, reason: r.reason });
        job.done += 1;
        onProgress?.(job);
      }
    };
    // One at a time keeps memory low on a small (512 MB) server.
    await worker();
  })()
    .catch((err) => {
      job.error = err.message;
    })
    .finally(() => {
      job.running = false;
      job.finishedAt = Date.now();
      onProgress?.(job);
    });

  return job;
}
