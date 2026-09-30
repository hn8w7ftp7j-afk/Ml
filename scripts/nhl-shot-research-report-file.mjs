// Lossless report storage: full-season training IDs repeat across held-out folds.
// Hash the original JSON bytes and verify them before any report is consumed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';

export const NHL_SHOT_REPORT_FILE = 'research-report.archive.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const invalid = () => { throw new Error('NHL_SHOT_REPORT_ARCHIVE_INVALID'); };

export function encodeNhlShotResearchReport(report) {
  const bytes = Buffer.from(JSON.stringify(report));
  const compressed = gzipSync(bytes, { level: 9 });
  return { format: 'NHL-SHOT-REPORT-GZIP-v1', payloadBytes: bytes.length,
    payloadSha256: hash(bytes), compressedSha256: hash(compressed), gzipBase64: compressed.toString('base64') };
}

export function decodeNhlShotResearchReport(archive) {
  if (archive?.format !== 'NHL-SHOT-REPORT-GZIP-v1' || !Number.isSafeInteger(archive.payloadBytes)
    || archive.payloadBytes < 1 || archive.payloadBytes > 256_000_000
    || typeof archive.gzipBase64 !== 'string' || archive.gzipBase64.length > 32_000_000) invalid();
  const compressed = Buffer.from(archive.gzipBase64, 'base64');
  if (compressed.toString('base64') !== archive.gzipBase64 || hash(compressed) !== archive.compressedSha256) invalid();
  const bytes = gunzipSync(compressed, { maxOutputLength: archive.payloadBytes });
  if (bytes.length !== archive.payloadBytes || hash(bytes) !== archive.payloadSha256) invalid();
  return JSON.parse(bytes.toString('utf8'));
}

export function readNhlShotResearchReport(directory) {
  return decodeNhlShotResearchReport(JSON.parse(fs.readFileSync(path.join(directory, NHL_SHOT_REPORT_FILE), 'utf8')));
}
