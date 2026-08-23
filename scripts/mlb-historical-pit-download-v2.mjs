import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { gzipSync } from 'node:zlib';

const VERSION = 'MLB-HISTORICAL-PIT-RAW-2026-08-v2.0.0';
const args = Object.fromEntries(process.argv.slice(2).map((value, index, all) => value.startsWith('--') ? [value.slice(2), all[index + 1]] : null).filter(Boolean));
const start = String(args.start || '2022-03-01');
const end = String(args.end || '2026-08-22');
const outputRoot = String(args.out || 'data/mlb-pit-v2');
const concurrency = Math.max(1, Math.min(4, Number(args.concurrency) || 2));
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));
if (!validDate(start) || !validDate(end) || start > end) throw new Error('Usage: --start YYYY-MM-DD --end YYYY-MM-DD [--out path] [--concurrency 1..4]');

const manifestPath = `${outputRoot}/manifest.json`;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const dateRange = (from, through) => {
  const rows = [];
  const cursor = new Date(`${from}T00:00:00Z`);
  const last = new Date(`${through}T00:00:00Z`);
  while (cursor <= last) { rows.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return rows;
};

async function officialSchedule(from, through, manifest) {
  const output = new Set();
  for (let year = Number(from.slice(0, 4)); year <= Number(through.slice(0, 4)); year += 1) {
    const rangeStart = `${year}-01-01` < from ? from : `${year}-01-01`;
    const rangeEnd = `${year}-12-31` > through ? through : `${year}-12-31`;
    const url = new URL('https://statsapi.mlb.com/api/v1/schedule');
    for (const [key, value] of Object.entries({ sportId: '1', gameType: 'R', startDate: rangeStart, endDate: rangeEnd })) url.searchParams.set(key, value);
    url.searchParams.set('hydrate', 'officials,team,venue,probablePitcher,linescore');
    const response = await fetchResponse(url);
    const payload = await response.json();
    const relative = `schedule/${year}.json.gz`;
    const target = `${outputRoot}/${relative}`;
    await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
    const compressed = gzipSync(`${JSON.stringify(payload)}\n`, { level: 9 });
    const temporary = `${target}.part`;
    await writeFile(temporary, compressed);
    await rename(temporary, target);
    manifest.scheduleFiles ||= {};
    manifest.scheduleFiles[year] = {
      path: relative,
      sha256: await sha256File(target),
      compressedBytes: compressed.byteLength,
      source: url.toString(),
      fetchedAt: new Date().toISOString(),
    };
    for (const row of payload?.dates || []) if (validDate(row?.date)) output.add(row.date);
  }
  return [...output].sort();
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function loadManifest() {
  try { return JSON.parse(await readFile(manifestPath, 'utf8')); }
  catch { return { version: VERSION, start, end, files: {}, failures: {}, createdAt: new Date().toISOString() }; }
}

let manifestWrite = Promise.resolve();
function saveManifest(manifest) {
  manifestWrite = manifestWrite.catch(() => {}).then(async () => {
    manifest.updatedAt = new Date().toISOString();
    const temporary = `${manifestPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(temporary, manifestPath);
  });
  return manifestWrite;
}

async function fetchResponse(url, attempts = 4) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'Baseball-Positive-EV-Historical-PIT-v2' }, signal: AbortSignal.timeout(120000) });
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
      return response;
    } catch (error) {
      last = error;
      if (attempt < attempts) await sleep(1000 * 2 ** attempt);
    }
  }
  throw last;
}

function statcastUrl(date) {
  const url = new URL('https://baseballsavant.mlb.com/statcast_search/csv');
  for (const [key, value] of Object.entries({ all: 'true', type: 'details', player_type: 'batter', game_date_gt: date, game_date_lt: date, game_type: 'R' })) url.searchParams.set(key, value);
  return url;
}

async function downloadDay(date, manifest) {
  const relative = `statcast/${date.slice(0, 4)}/${date}.csv.gz`;
  const target = `${outputRoot}/${relative}`;
  const previous = manifest.files[date];
  if (previous?.sha256 && existsSync(target) && previous.sha256 === await sha256File(target)) return { date, skipped: true };
  await mkdir(target.slice(0, target.lastIndexOf('/')), { recursive: true });
  const temporary = `${target}.part`;
  const response = await fetchResponse(statcastUrl(date));
  await pipeline(Readable.fromWeb(response.body), createGzip({ level: 9 }), createWriteStream(temporary, { flags: 'w' }));
  await rename(temporary, target);
  const file = await stat(target);
  const sha256 = await sha256File(target);
  manifest.files[date] = { path: relative, sha256, compressedBytes: file.size, source: statcastUrl(date).toString(), fetchedAt: new Date().toISOString() };
  delete manifest.failures[date];
  await saveManifest(manifest);
  return { date, bytes: file.size };
}

await mkdir(outputRoot, { recursive: true });
const manifest = await loadManifest();
const dates = args['all-calendar-days'] === 'true' ? dateRange(start, end) : await officialSchedule(start, end, manifest);
await saveManifest(manifest);
let cursor = 0;
let completed = 0;
let skipped = 0;
let failed = 0;
async function worker() {
  while (cursor < dates.length) {
    const date = dates[cursor++];
    try {
      const result = await downloadDay(date, manifest);
      completed += result.skipped ? 0 : 1;
      skipped += result.skipped ? 1 : 0;
      process.stdout.write(`${result.skipped ? 'SKIP' : 'DONE'} ${date} ${result.bytes || 0}\n`);
    } catch (error) {
      failed += 1;
      manifest.failures[date] = { error: String(error?.message || error), at: new Date().toISOString() };
      await saveManifest(manifest);
      process.stdout.write(`FAIL ${date} ${manifest.failures[date].error}\n`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));
await saveManifest(manifest);
console.log(JSON.stringify({ version: VERSION, start, end, completed, skipped, failed, manifestPath }, null, 2));
if (failed) process.exitCode = 2;
