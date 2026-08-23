import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const VERSION = 'MLB-OFFICIAL-GAMEDAY-WEATHER-RECONSTRUCTION-2026-08-v2.1.0';
const root = process.argv[2] || '/workspace/mlb-pit-data';
const manifestPath = `${root}/manifest.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const firstYear = Number(process.argv[3] || 2021);
const lastYear = Number(process.argv[4] || 2026);
const sha256File = async path => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};

async function fetchJson(url, attempts = 4) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(120000), headers: { 'User-Agent': 'Baseball-Positive-EV-Historical-Weather-v2' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 750 * 2 ** attempt));
    }
  }
  throw lastError;
}

for (let year = firstYear; year <= lastYear; year += 1) {
  const sourceSchedule = manifest.scheduleFiles?.[year];
  if (!sourceSchedule) throw new Error(`Missing source schedule for ${year}`);
  const url = new URL('https://statsapi.mlb.com/api/v1/schedule');
  for (const [key, value] of Object.entries({ sportId: '1', gameType: 'R', startDate: `${year}-01-01`, endDate: year === 2026 ? '2026-08-22' : `${year}-12-31`, hydrate: 'weather' })) url.searchParams.set(key, value);
  const payload = await fetchJson(url);
  const relative = `weather/${year}.json.gz`;
  const target = `${root}/${relative}`;
  await mkdir(`${root}/weather`, { recursive: true });
  const compressed = gzipSync(`${JSON.stringify(payload)}\n`, { level: 9 });
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, compressed);
  await rename(temporary, target);
  const games = (payload?.dates || []).flatMap(row => row?.games || []);
  manifest.weatherScheduleFiles ||= {};
  manifest.weatherScheduleFiles[year] = {
    version: VERSION,
    path: relative,
    sha256: await sha256File(target),
    compressedBytes: compressed.byteLength,
    source: url.toString(),
    fetchedAt: new Date().toISOString(),
    games: games.length,
    weatherGames: games.filter(game => game?.weather).length,
  };
  process.stdout.write(`WEATHER ${year} games=${games.length} weather=${manifest.weatherScheduleFiles[year].weatherGames}\n`);
}
const temporaryManifest = `${manifestPath}.${process.pid}.tmp`;
manifest.updatedAt = new Date().toISOString();
await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`);
await rename(temporaryManifest, manifestPath);
console.log(JSON.stringify({ version: VERSION, years: [firstYear, lastYear], manifestPath }, null, 2));
