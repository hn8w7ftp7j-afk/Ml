// Lossless deterministic gzip chunks encoded as text for normal Git transport.
// This creates archives only; it never deletes or rewrites raw checkpoints.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { NHL_SHOT_ARCHIVE_VERSION, readNhlShotCheckpoint } from '../lib/nhl/shot-research-archive.js';
const args = process.argv.slice(2);
async function saveAtomic(destination, contents) {
  const temporary = `${destination}.tmp-${process.pid}`;
  await fs.writeFile(temporary, contents); await fs.rename(temporary, destination);
}
if (args.includes('--help')) { console.log('node scripts/nhl-shot-research-archive.mjs [--directory /absolute/xg-research] [--chunk-games100]\nNo network. Keeps all original checkpoints; verifies lossless round-trip and original official source hashes.'); process.exit(0); }
for (let i = 0; i < args.length; i += 2) if (!['--directory', '--chunk-games'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid archive arguments');
const value = (key, fallback) => args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const directory = value('--directory', path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/nhl/xg-research'));
const chunkGames = Number(value('--chunk-games', '100'));
if (!path.isAbsolute(directory) || !Number.isSafeInteger(chunkGames) || chunkGames < 1 || chunkGames > 100) throw new Error('Absolute directory and1–100games perchunk required');
const files = (await fs.readdir(directory)).filter(file => /^pbp-\d{10}\.json$/.test(file)).sort();
if (!files.length) throw new Error('No raw PBP checkpoints available for archiving');
const archiveDir = path.join(directory, 'archives'); await fs.mkdir(archiveDir, { recursive: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = { version: NHL_SHOT_ARCHIVE_VERSION, generatedAt: new Date().toISOString(), compression: 'GZIP_LEVEL9_BASE64_UTF8',
  originalCheckpointsRemoved: false, games: [], chunks: [] };
for (let index = 0; index < files.length; index += chunkGames) {
  const records = []; const entryRecords = []; const file = `pbp-${String(index / chunkGames).padStart(3, '0')}.json.gz.b64`;
  for (const sourceFile of files.slice(index, index + chunkGames)) {
    const checkpointUtf8 = await fs.readFile(path.join(directory, sourceFile), 'utf8');
    const response = JSON.parse(checkpointUtf8); const gameId = sourceFile.slice(4, 14);
    if (response?.ok !== true || String(response.data?.id) !== gameId || response.source?.provider !== 'NHL'
      || response.source.url !== `https://api-web.nhle.com/v1/gamecenter/${gameId}/play-by-play`
      || response.source.contentHash !== hash(JSON.stringify(response.data))) throw new Error(`Invalid original checkpoint: ${sourceFile}`);
    records.push({ gameId, checkpointUtf8 });
    entryRecords.push({ gameId, chunk: file, checkpointSha256: hash(checkpointUtf8), sourceContentHash: response.source.contentHash });
  }
  const payload = Buffer.from(JSON.stringify(records)); const compressed = gzipSync(payload, { level: 9 });
  const encoded = `${compressed.toString('base64')}\n`;
  if (encoded.length > 5_000_000) throw new Error('Archive chunk exceeds5MB; use a smaller explicit --chunk-games value');
  await saveAtomic(path.join(archiveDir, file), encoded);
  manifest.chunks.push({ file, games: records.length, fileBytes: encoded.length, payloadBytes: payload.length,
    compressedSha256: hash(compressed), payloadSha256: hash(payload) });
  manifest.games.push(...entryRecords);
}
await saveAtomic(path.join(archiveDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const entry of manifest.games) {
  const restored = readNhlShotCheckpoint(entry.gameId, { directory, allowRaw: false });
  if (restored.source.contentHash !== entry.sourceContentHash) throw new Error(`Round-trip failed: ${entry.gameId}`);
}
console.log(JSON.stringify({ version: manifest.version, archivedGames: manifest.games.length, chunks: manifest.chunks.length,
  archiveBytes: manifest.chunks.reduce((sum, chunk) => sum + chunk.fileBytes, 0), originalCheckpointsRemoved: false, roundTrip: 'PASS' }, null, 2));
