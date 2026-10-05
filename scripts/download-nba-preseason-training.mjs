import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { normalizeGame } from '../lib/nba/data.js';
const exec = promisify(execFile);
const root = process.argv[2];
if (!root) throw Error('provide archive directory');
await mkdir(root, { recursive: true });
const sources = [], excluded = [], games = new Map();
const requests = [2024, 2025, 2026].flatMap(year => [1, 2].flatMap(type => Array.from({ length: 30 }, (_, i) => ({ year: type === 2 ? year - 1 : year, type, team: i + 1 }))));
async function download(url, key) {
  const path = `${root}/${key}.json`;
  let text;
  try { text = await readFile(path, 'utf8'); } catch {
    const response = await exec('curl', ['-fsS', '--retry', '2', '--max-time', '30', url], { maxBuffer: 8 * 1024 * 1024 });
    text = response.stdout; JSON.parse(text); await writeFile(path, text);
  }
  sources.push({ url, hash: createHash('sha256').update(text).digest('hex') });
  return JSON.parse(text);
}
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < requests.length) {
    const { year, type, team } = requests[next++];
    const raw = await download(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${team}/schedule?season=${year}&seasontype=${type}`, `schedule-${year}-${type}-${team}`);
    if (String(raw.team?.id) !== String(team) || raw.requestedSeason?.year !== year || raw.requestedSeason?.type !== type || !Array.isArray(raw.events)) throw Error('schedule scope mismatch');
    for (const event of raw.events) {
      const competitors = event.competitions?.[0]?.competitors || [];
      if (competitors.some(value => !/^(?:[1-9]|[12]\d|30)$/.test(value.team?.id || ''))) { excluded.push({ id: event.id, reason: 'non_NBA_opponent' }); continue; }
      const game = normalizeGame(event, raw.requestedSeason);
      if (game.season.year !== year || game.seasonType !== (type === 1 ? 'preseason' : 'regular')) throw Error('event season mismatch');
      if (!game.completed) continue;
      const row = { gameId: game.id, date: game.taipeiDate, startTime: game.startTime, year, seasonType: game.seasonType, homeId: game.home.id, awayId: game.away.id, homeScore: game.home.score, awayScore: game.away.score, neutralSite: game.neutralSite };
      const old = games.get(row.gameId);
      if (old && JSON.stringify(old) !== JSON.stringify(row)) throw Error('conflicting duplicated result');
      games.set(row.gameId, row);
    }
    if (next % 30 === 0) console.log(`schedule sources ${sources.length}/${requests.length}`);
  }
}));
const preseason = [...games.values()].filter(row => row.seasonType === 'preseason');
next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < preseason.length) {
    const row = preseason[next++], id = row.gameId.split(':').at(-1);
    const raw = await download(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${id}`, `summary-${id}`);
    const game = normalizeGame(raw.header);
    if (game.id !== row.gameId || game.taipeiDate !== row.date || game.startTime !== row.startTime || game.season.year !== row.year || game.neutralSite !== row.neutralSite || !game.completed || game.seasonType !== 'preseason' || game.home.id !== row.homeId || game.away.id !== row.awayId || game.home.score !== row.homeScore || game.away.score !== row.awayScore) throw Error('summary mismatch');
    for (const side of ['home', 'away']) {
      const periods = game[side].periodScores;
      if (periods.length < 4 || periods.reduce((a, b) => a + b.score, 0) !== game[side].score) throw Error('quarter totals mismatch');
      row[`${side}Half`] = periods[0].score + periods[1].score;
    }
    if (next % 30 === 0) console.log(`quarter sources ${next}/${preseason.length}`);
  }
}));
const data = { kind: 'NBA_VERIFIED_PRESEASON_ARCHIVE', retrievedAt: new Date().toISOString(), sourceRole: 'ESPN_secondary_not_official_pregame_archive', sources: sources.sort((a, b) => a.url.localeCompare(b.url)), excluded: [...new Map(excluded.map(row => [row.id, row])).values()], history: [...games.values()].sort((a, b) => a.date.localeCompare(b.date) || a.gameId.localeCompare(b.gameId)) };
await writeFile(`${root}/training.json`, JSON.stringify(data));
console.log(JSON.stringify({ sources: sources.length, preseason: preseason.length, regular: data.history.length - preseason.length, excluded: data.excluded.length }));
