import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';

export const NHL_SHOT_ARCHIVE_VERSION = 'NHL-PBP-CHECKPOINT-ARCHIVE-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const cache = new Map();
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Local acquisition checkpoints remain untouched. Clean Git/CI installations
// can reconstruct those exact original UTF8 bytes from verified text archives.
export function readNhlShotCheckpoint(gameId, { directory, allowRaw = true } = {}) {
  if (!/^\d{10}$/.test(String(gameId)) || typeof directory !== 'string' || !path.isAbsolute(directory)) fail('NHL_SHOT_ARCHIVE_LOOKUP_INVALID');
  const id = String(gameId);
  const raw = path.join(directory, `pbp-${id}.json`);
  if (allowRaw && fs.existsSync(raw)) return JSON.parse(fs.readFileSync(raw, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'archives', 'manifest.json'), 'utf8'));
  if (manifest?.version !== NHL_SHOT_ARCHIVE_VERSION || !Array.isArray(manifest.games) || !Array.isArray(manifest.chunks)) fail('NHL_SHOT_ARCHIVE_MANIFEST_INVALID');
  const entries = manifest.games.filter(row => row.gameId === id);
  if (entries.length !== 1) fail('NHL_SHOT_ARCHIVE_GAME_NOT_UNIQUE');
  const entry = entries[0];
  const chunks = manifest.chunks.filter(row => row.file === entry.chunk);
  if (chunks.length !== 1 || !/^pbp-\d{3}\.json\.gz\.b64$/.test(entry.chunk)) fail('NHL_SHOT_ARCHIVE_CHUNK_IDENTITY_INVALID');
  const chunk = chunks[0]; const key = `${directory}:${entry.chunk}:${chunk.compressedSha256}`;
  let decoded = cache.get(key);
  if (!decoded) {
    const text = fs.readFileSync(path.join(directory, 'archives', entry.chunk), 'utf8');
    if (text.length !== chunk.fileBytes || text.length > 5_000_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\n?$/.test(text)) fail('NHL_SHOT_ARCHIVE_ENCODING_INVALID');
    const compressed = Buffer.from(text.trim(), 'base64');
    if (compressed.toString('base64') !== text.trim() || hash(compressed) !== chunk.compressedSha256) fail('NHL_SHOT_ARCHIVE_COMPRESSED_HASH_MISMATCH');
    const bytes = gunzipSync(compressed, { maxOutputLength: 64_000_000 });
    if (hash(bytes) !== chunk.payloadSha256 || bytes.length !== chunk.payloadBytes) fail('NHL_SHOT_ARCHIVE_PAYLOAD_HASH_MISMATCH');
    decoded = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(decoded) || decoded.length !== chunk.games || new Set(decoded.map(row => row.gameId)).size !== decoded.length) fail('NHL_SHOT_ARCHIVE_RECORDS_INVALID');
    cache.set(key, decoded);
    while (cache.size > 2) cache.delete(cache.keys().next().value);
  }
  const records = decoded.filter(row => row.gameId === id);
  if (records.length !== 1 || typeof records[0].checkpointUtf8 !== 'string' || hash(records[0].checkpointUtf8) !== entry.checkpointSha256) fail('NHL_SHOT_ARCHIVE_CHECKPOINT_HASH_MISMATCH');
  const response = JSON.parse(records[0].checkpointUtf8);
  if (response?.ok !== true || String(response.data?.id) !== id || response.source?.provider !== 'NHL'
    || response.source.url !== `https://api-web.nhle.com/v1/gamecenter/${id}/play-by-play`
    || hash(JSON.stringify(response.data)) !== response.source.contentHash || response.source.contentHash !== entry.sourceContentHash) fail('NHL_SHOT_ARCHIVE_OFFICIAL_SOURCE_HASH_MISMATCH');
  return response;
}
