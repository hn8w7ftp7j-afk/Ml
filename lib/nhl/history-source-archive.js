import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { validateNhlIdentity } from './identity.js';

export const NHL_HISTORY_SOURCE_ARCHIVE_VERSION = 'NHL-OFFICIAL-SOURCE-CHECKPOINT-ARCHIVE-v1';
export const NHL_HISTORY_ARCHIVABLE_SOURCE = /^(?:standings-season-index|standings-\d{4}-\d{2}-\d{2}|schedule-[A-Z]{2,3}-\d{8}|landing-\d{10}|period-report-\d{8}-(?:page100-)?\d+)\.json$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const decodedCache = new Map();

// Shared gzip/base64 transport used by heterogeneous history sources and PBP
// archives. Identity-specific wrappers still verify each official source.
export function decodeNhlSourceArchiveChunk(text, chunk, { recordKey = 'file' } = {}) {
  const count = chunk?.records ?? chunk?.games;
  if (typeof text !== 'string' || !Number.isSafeInteger(chunk?.fileBytes) || text.length !== chunk.fileBytes || text.length > 5_000_000
    || !Number.isSafeInteger(chunk?.payloadBytes) || chunk.payloadBytes < 1 || chunk.payloadBytes > 64_000_000
    || !Number.isSafeInteger(count) || count < 1 || !sha(chunk.compressedSha256) || !sha(chunk.payloadSha256)
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?\n?$/.test(text)) fail('NHL_SOURCE_ARCHIVE_ENCODING_INVALID');
  const compressed = Buffer.from(text.trim(), 'base64');
  if (compressed.toString('base64') !== text.trim() || hash(compressed) !== chunk.compressedSha256) fail('NHL_SOURCE_ARCHIVE_COMPRESSED_HASH_MISMATCH');
  // Recheck compressed bytes on every read so a changed archive cannot hide
  // behind an earlier decoded-cache hit. Cache keys also bind all metadata.
  const cacheKey = `${chunk.compressedSha256}:${chunk.payloadSha256}:${chunk.payloadBytes}:${count}:${recordKey}`;
  let decoded = decodedCache.get(cacheKey);
  if (!decoded) {
    let bytes;
    try { bytes = gunzipSync(compressed, { maxOutputLength: 64_000_000 }); }
    catch { fail('NHL_SOURCE_ARCHIVE_GZIP_INVALID'); }
    if (bytes.length !== chunk.payloadBytes || hash(bytes) !== chunk.payloadSha256) fail('NHL_SOURCE_ARCHIVE_PAYLOAD_HASH_MISMATCH');
    try { decoded = JSON.parse(bytes.toString('utf8')); } catch { fail('NHL_SOURCE_ARCHIVE_PAYLOAD_JSON_INVALID'); }
    if (!Array.isArray(decoded) || decoded.length !== count || decoded.some(row => typeof row?.[recordKey] !== 'string' || !row[recordKey]
      || typeof row.checkpointUtf8 !== 'string') || new Set(decoded.map(row => row[recordKey])).size !== decoded.length) fail('NHL_SOURCE_ARCHIVE_RECORDS_INVALID');
    decodedCache.set(cacheKey, decoded);
    while (decodedCache.size > 2) decodedCache.delete(decodedCache.keys().next().value);
  }
  return structuredClone(decoded);
}

export function verifyNhlHistoryCheckpoint(response, file) {
  if (!NHL_HISTORY_ARCHIVABLE_SOURCE.test(file) || response?.ok !== true || !response.data || typeof response.data !== 'object' || Array.isArray(response.data)
    || response.source?.provider !== 'NHL' || !sha(response.source.contentHash) || response.source.contentHash !== hash(JSON.stringify(response.data))
    || typeof response.source.fetchedAt !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(response.source.fetchedAt)
    || !Number.isFinite(Date.parse(response.source.fetchedAt))) return false;
  let expectedUrl;
  if (file === 'standings-season-index.json') {
    expectedUrl = 'https://api-web.nhle.com/v1/standings-season';
    if (!Array.isArray(response.data.seasons)) return false;
  } else if (file.startsWith('standings-')) {
    const date = file.slice(10, -5);
    if (!Number.isFinite(Date.parse(`${date}T00:00:00Z`)) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) return false;
    expectedUrl = `https://api-web.nhle.com/v1/standings/${date}`;
    if (!Array.isArray(response.data.standings) || response.data.standings.some(row => row.date !== date)) return false;
  } else if (file.startsWith('schedule-')) {
    const [, team, season] = file.match(/^schedule-([A-Z]{2,3})-(\d{8})\.json$/);
    expectedUrl = `https://api-web.nhle.com/v1/club-schedule-season/${team}/${season}`;
    if (response.team !== team || !Array.isArray(response.data.games)
      || response.data.games.some(row => row.season !== Number(season) || ![row.awayTeam?.abbrev, row.homeTeam?.abbrev].includes(team))) return false;
  } else if (file.startsWith('landing-')) {
    const id = file.slice(8, -5);
    expectedUrl = `https://api-web.nhle.com/v1/gamecenter/${id}/landing`;
    if (String(response.data.id) !== id || !validateNhlIdentity(response.data).ok) return false;
  } else {
    const [, season, page100, start] = file.match(/^period-report-(\d{8})-(page100-)?(\d+)\.json$/);
    const params = new URLSearchParams({ isAggregate: 'false', isGame: 'true', start, limit: page100 ? '100' : '1000',
      sort: JSON.stringify([{ property: 'gameId', direction: 'ASC' }, { property: 'teamId', direction: 'ASC' }]),
      cayenneExp: `seasonId=${season} and gameTypeId=2` });
    expectedUrl = `https://api.nhle.com/stats/rest/en/team/goalsbyperiod?${params}`;
    if (response.start !== Number(start) || !Array.isArray(response.data.data) || !Number.isSafeInteger(response.data.total)
      || response.data.data.some(row => String(row.gameId).slice(0, 6) !== `${season.slice(0, 4)}02`)) return false;
  }
  return response.source.url === expectedUrl;
}

export function readNhlHistoryCheckpoint(file, { directory, allowRaw = true } = {}) {
  if (!NHL_HISTORY_ARCHIVABLE_SOURCE.test(String(file)) || typeof directory !== 'string' || !path.isAbsolute(directory)) fail('NHL_HISTORY_ARCHIVE_LOOKUP_INVALID');
  const raw = path.join(directory, file);
  if (allowRaw && fs.existsSync(raw)) {
    const response = JSON.parse(fs.readFileSync(raw, 'utf8'));
    if (!verifyNhlHistoryCheckpoint(response, file)) fail('NHL_HISTORY_ARCHIVE_RAW_SOURCE_INVALID');
    return response;
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'archives', 'manifest.json'), 'utf8'));
  if (manifest?.version !== NHL_HISTORY_SOURCE_ARCHIVE_VERSION || manifest.leagueId !== 'NHL'
    || !Array.isArray(manifest.records) || !Array.isArray(manifest.chunks)) fail('NHL_HISTORY_ARCHIVE_MANIFEST_INVALID');
  const entries = manifest.records.filter(row => row.file === file);
  if (entries.length !== 1) fail('NHL_HISTORY_ARCHIVE_SOURCE_NOT_UNIQUE');
  const entry = entries[0];
  if (!/^sources-\d{3}\.json\.gz\.b64$/.test(entry.chunk)) fail('NHL_HISTORY_ARCHIVE_CHUNK_IDENTITY_INVALID');
  const chunks = manifest.chunks.filter(row => row.file === entry.chunk);
  if (chunks.length !== 1) fail('NHL_HISTORY_ARCHIVE_CHUNK_IDENTITY_INVALID');
  const text = fs.readFileSync(path.join(directory, 'archives', entry.chunk), 'utf8');
  const decoded = decodeNhlSourceArchiveChunk(text, chunks[0]);
  const records = decoded.filter(row => row.file === file);
  if (records.length !== 1 || !sha(entry.checkpointSha256) || hash(records[0].checkpointUtf8) !== entry.checkpointSha256) fail('NHL_HISTORY_ARCHIVE_CHECKPOINT_HASH_MISMATCH');
  const response = JSON.parse(records[0].checkpointUtf8);
  if (!verifyNhlHistoryCheckpoint(response, file) || response.source.contentHash !== entry.sourceContentHash
    || response.source.url !== entry.sourceUrl || response.source.fetchedAt !== entry.sourceFetchedAt) fail('NHL_HISTORY_ARCHIVE_OFFICIAL_SOURCE_HASH_MISMATCH');
  return response;
}
