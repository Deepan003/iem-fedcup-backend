import { JWT } from 'google-auth-library';

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

/** Validates a pasted service-account JSON key and returns the fields we keep. */
export function parseServiceAccount(raw) {
  let sa;
  try {
    sa = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('That is not valid JSON. Paste the whole key file downloaded from Google Cloud.');
  }
  if (sa?.type !== 'service_account' || !sa.client_email || !sa.private_key) {
    throw new Error('This JSON is not a service-account key (needs type, client_email and private_key).');
  }
  return { client_email: sa.client_email, private_key: sa.private_key, project_id: sa.project_id || '' };
}

export function googleClient(sa) {
  return new JWT({ email: sa.client_email, key: sa.private_key, scopes: SCOPES });
}

export function parseSheetId(urlOrId) {
  const s = String(urlOrId || '').trim();
  const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;
  throw new Error('Could not find a spreadsheet ID in that link');
}

export async function listTabs(client, sheetId) {
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}`,
    params: { fields: 'properties.title,sheets.properties.title' },
  });
  return { title: res.data.properties?.title, tabs: (res.data.sheets || []).map((s) => s.properties.title) };
}

/** Returns all cell values of a tab as a 2-D array of strings. */
export async function readSheet(client, sheetId, tab) {
  let range = tab;
  if (!range) range = (await listTabs(client, sheetId)).tabs[0];
  const res = await client.request({
    url: `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/${encodeURIComponent(range)}`,
    params: { valueRenderOption: 'FORMATTED_VALUE' },
  });
  return res.data.values || [];
}

/** Extracts a Drive file ID from open?id=, /file/d/<id>/, uc?id= links. */
export function driveFileId(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  const m = s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || s.match(/\/d\/([a-zA-Z0-9_-]{10,})/);
  return m ? m[1] : null;
}

const MAX_BYTES = 30 * 1024 * 1024;

/**
 * Downloads a Drive file. Uses the service account when available (works for files shared
 * with it); otherwise falls back to the public "anyone with the link" download URL.
 */
export async function downloadDriveFile(client, fileId) {
  if (client) {
    const meta = await client.request({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
      params: { fields: 'name,mimeType,size,thumbnailLink', supportsAllDrives: true },
    });
    const { mimeType = '', name = '', thumbnailLink } = meta.data;
    const size = Number(meta.data.size) || 0;
    const isHeif = /heic|heif/i.test(mimeType) || /\.(heic|heif)$/i.test(name);
    // Always prefer Google's rendered 1600px JPEG preview: a few hundred KB instead of a 5-20 MB
    // original, and no HEIC decoding. Keeps memory low on a 512 MB server.
    if (thumbnailLink) {
      const url = /=s\d+$/.test(thumbnailLink) ? thumbnailLink.replace(/=s\d+$/, '=s1600') : `${thumbnailLink}=s1600`;
      try {
        const th = await client.request({ url, responseType: 'arraybuffer' });
        const buf = Buffer.from(th.data);
        if (buf.length > 1000) return { buffer: buf, mimeType: 'image/jpeg', name };
      } catch {
        // fall through to the original file
      }
    }
    if (isHeif && size > 8 * 1024 * 1024) {
      throw new Error('This iPhone photo is too large to convert on the server and Google has no preview yet. Upload a JPG/PNG manually.');
    }
    if (size > MAX_BYTES) throw new Error('File is larger than 30 MB');
    const res = await client.request({
      url: `https://www.googleapis.com/drive/v3/files/${fileId}`,
      params: { alt: 'media', supportsAllDrives: true },
      responseType: 'arraybuffer',
    });
    return { buffer: Buffer.from(res.data), mimeType: meta.data.mimeType, name: meta.data.name };
  }
  const res = await fetch(`https://drive.google.com/uc?export=download&id=${fileId}`, { redirect: 'follow' });
  const type = res.headers.get('content-type') || '';
  if (!res.ok || !type.startsWith('image/')) {
    throw new Error('File is private. Add Google credentials or share the photo folder with the service account.');
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_BYTES) throw new Error('File is larger than 30 MB');
  return { buffer, mimeType: type, name: fileId };
}

/** Turns googleapis errors into something an organiser can act on. */
export function explainGoogleError(err, sa) {
  const status = err?.response?.status ?? err?.code;
  if (status === 403 || status === 404) {
    return `Google says "no access". Share the sheet/folder with ${sa?.client_email || 'the service account email'} (Viewer) and make sure the Sheets and Drive APIs are enabled.`;
  }
  if (status === 400) return 'Google rejected the request. Check the sheet link and tab name.';
  return err?.response?.data?.error?.message || err?.message || String(err);
}
