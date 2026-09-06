// Deterministic, lossless archives. Original source files are never removed.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { NHL_HISTORY_SOURCE_ARCHIVE_VERSION, NHL_HISTORY_ARCHIVABLE_SOURCE,
  verifyNhlHistoryCheckpoint, readNhlHistoryCheckpoint } from '../lib/nhl/history-source-archive.js';

export async function archiveNhlHistorySources(directory, { chunkRecords = 25 } = {}) {
  if (!path.isAbsolute(directory) || !Number.isSafeInteger(chunkRecords) || chunkRecords < 1 || chunkRecords > 100) throw new Error('NHL_HISTORY_ARCHIVE_SCOPE_INVALID');
  const files = (await fs.readdir(directory)).filter(file => NHL_HISTORY_ARCHIVABLE_SOURCE.test(file)).sort();
  if (!files.length) throw new Error('NHL_HISTORY_ARCHIVE_SOURCES_MISSING');
  const archiveDirectory = path.join(directory, 'archives'); await fs.mkdir(archiveDirectory, { recursive: true });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const manifest = { version: NHL_HISTORY_SOURCE_ARCHIVE_VERSION, leagueId: 'NHL', compression: 'GZIP_LEVEL9_BASE64_UTF8',
    originalCheckpointsRemoved: false, records: [], chunks: [] };
  for (let offset = 0; offset < files.length; offset += chunkRecords) {
    const records = []; const chunk = `sources-${String(offset / chunkRecords).padStart(3, '0')}.json.gz.b64`;
    for (const file of files.slice(offset, offset + chunkRecords)) {
      const checkpointUtf8 = await fs.readFile(path.join(directory, file), 'utf8');
      const response = JSON.parse(checkpointUtf8);
      if (!verifyNhlHistoryCheckpoint(response, file)) throw new Error(`NHL_HISTORY_ARCHIVE_INVALID_SOURCE:${file}`);
      records.push({ file, checkpointUtf8 });
      manifest.records.push({ file, chunk, checkpointSha256: hash(checkpointUtf8), sourceContentHash: response.source.contentHash,
        sourceUrl: response.source.url, sourceFetchedAt: response.source.fetchedAt });
    }
    const payload = Buffer.from(JSON.stringify(records)); const compressed = gzipSync(payload, { level: 9 });
    const encoded = `${compressed.toString('base64')}\n`;
    if (encoded.length > 5_000_000 || payload.length > 64_000_000) throw new Error('NHL_HISTORY_ARCHIVE_CHUNK_TOO_LARGE');
    await fs.writeFile(path.join(archiveDirectory, chunk), encoded);
    manifest.chunks.push({ file: chunk, records: records.length, fileBytes: encoded.length, payloadBytes: payload.length,
      compressedSha256: hash(compressed), payloadSha256: hash(payload) });
  }
  await fs.writeFile(path.join(archiveDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of manifest.records) {
    const restored = readNhlHistoryCheckpoint(entry.file, { directory, allowRaw: false });
    const original = JSON.parse(await fs.readFile(path.join(directory, entry.file), 'utf8'));
    if (JSON.stringify(restored) !== JSON.stringify(original)) throw new Error(`NHL_HISTORY_ARCHIVE_ROUNDTRIP_FAILED:${entry.file}`);
  }
  return { version: manifest.version, records: manifest.records.length, chunks: manifest.chunks.length,
    archiveBytes: manifest.chunks.reduce((sum, chunk) => sum + chunk.fileBytes, 0), originalCheckpointsRemoved: false, roundTrip: 'PASS' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('node scripts/nhl-history-source-archive.mjs [--directory /absolute/history-expanded] [--chunk-records 25]\nNo network; no raw checkpoint deletion; deterministic lossless gzip/base64 and official source identity verification.');
  else {
    const options = {}; const seen = new Set();
    for (let i = 0; i < args.length; i += 2) {
      if (!['--directory', '--chunk-records'].includes(args[i]) || seen.has(args[i]) || !args[i + 1]) throw new Error('NHL_HISTORY_ARCHIVE_ARGUMENT_INVALID');
      seen.add(args[i]); options[args[i]] = args[i + 1];
    }
    const directory = options['--directory'] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/nhl/history-expanded');
    console.log(JSON.stringify(await archiveNhlHistorySources(directory, { chunkRecords: Number(options['--chunk-records'] || 25) })));
  }
}
