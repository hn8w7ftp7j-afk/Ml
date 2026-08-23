import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

const root = process.argv[2] || '/workspace/mlb-pit-data';
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, 'utf8'));
const output = `${root}/normalized/game-index.jsonl`;
await mkdir(`${root}/normalized`, { recursive: true });
const games = [];

async function weatherByGame(year) {
  const descriptor = manifest.weatherScheduleFiles?.[year];
  if (!descriptor?.path) return new Map();
  const compressed = `${root}/${descriptor.path}`;
  const temporary = `/tmp/mlb-weather-${year}-${process.pid}.json`;
  await pipeline(createReadStream(compressed), createGunzip(), createWriteStream(temporary));
  const payload = JSON.parse(await readFile(temporary, 'utf8'));
  return new Map((payload?.dates || []).flatMap(row => row?.games || []).map(game => [Number(game?.gamePk || 0), game?.weather || null]));
}

for (const year of Object.keys(manifest.scheduleFiles || {}).sort()) {
  const weather = await weatherByGame(year);
  const compressed = `${root}/${manifest.scheduleFiles[year].path}`;
  const temporary = `/tmp/mlb-schedule-${year}-${process.pid}.json`;
  await pipeline(createReadStream(compressed), createGunzip(), createWriteStream(temporary));
  const payload = JSON.parse(await readFile(temporary, 'utf8'));
  for (const date of payload?.dates || []) {
    for (const game of date?.games || []) {
      if (game?.gameType !== 'R') continue;
      const start = String(game?.gameDate || '');
      const gamePk = Number(game?.gamePk || 0);
      const official = (game?.officials || []).find(row => row?.officialType === 'Home Plate')?.official || {};
      const row = {
        gamePk,
        officialDate: String(game?.officialDate || date?.date || ''),
        gameStart: start,
        season: Number(year),
        status: String(game?.status?.detailedState || ''),
        awayTeamId: Number(game?.teams?.away?.team?.id || 0),
        homeTeamId: Number(game?.teams?.home?.team?.id || 0),
        awayProbablePitcherId: Number(game?.teams?.away?.probablePitcher?.id || 0) || null,
        awayProbablePitcherName: String(game?.teams?.away?.probablePitcher?.fullName || ''),
        homeProbablePitcherId: Number(game?.teams?.home?.probablePitcher?.id || 0) || null,
        homeProbablePitcherName: String(game?.teams?.home?.probablePitcher?.fullName || ''),
        awayRuns: Number.isFinite(Number(game?.teams?.away?.score)) ? Number(game.teams.away.score) : null,
        homeRuns: Number.isFinite(Number(game?.teams?.home?.score)) ? Number(game.teams.home.score) : null,
        venueId: Number(game?.venue?.id || 0),
        weather: weather.get(gamePk),
        umpireId: Number(official?.id || 0) || null,
        umpireName: String(official?.fullName || ''),
        statcastFile: manifest.files?.[String(game?.officialDate || date?.date || '')]?.path || null,
      };
      if (gamePk && Number.isFinite(Date.parse(start))) games.push(row);
    }
  }
}

games.sort((left, right) => Date.parse(left.gameStart) - Date.parse(right.gameStart) || left.gamePk - right.gamePk);
const seen = new Set();
const unique = games.filter(row => !seen.has(row.gamePk) && seen.add(row.gamePk));
const temporaryOutput = `${output}.${process.pid}.tmp`;
await writeFile(temporaryOutput, unique.map(row => JSON.stringify(row)).join('\n') + '\n');
await rename(temporaryOutput, output);
const hash = createHash('sha256');
for await (const chunk of createReadStream(output)) hash.update(chunk);
const summary = {
  version: 'MLB-PIT-GAME-INDEX-2026-08-v2.0.0',
  games: unique.length,
  finalScoreGames: unique.filter(row => row.awayRuns != null && row.homeRuns != null).length,
  umpireGames: unique.filter(row => row.umpireId).length,
  statcastLinkedGames: unique.filter(row => row.statcastFile).length,
  seasons: Object.fromEntries([...new Set(unique.map(row => row.season))].map(year => [year, unique.filter(row => row.season === year).length])),
  sha256: hash.digest('hex'),
  output,
};
await writeFile(`${root}/normalized/game-index-summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
