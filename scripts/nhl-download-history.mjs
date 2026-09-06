// Official NHL history downloader with resumable local checkpoints. No mirror,
// proxy, synthetic fallback, credentials or MoneyPuck scraping is used.
// node scripts/nhl-download-history.mjs --season 20232024 --teams TOR,BOS --out /absolute/path
import fs from 'node:fs/promises';
import path from 'node:path';
import { fetchNhlClubSchedule, fetchNhlGame } from '../lib/nhl/data.js';
import { validateNhlIdentity } from '../lib/nhl/identity.js';

const args = process.argv.slice(2);
const usage = 'Usage: node scripts/nhl-download-history.mjs --season 20232024 --teams TOR,BOS --out /absolute/path [--max-games 10000] [--details]\n\nDownloads the official published club schedules and completed regular-season games.\nResumes valid per-game checkpoints. Preseason and playoffs are excluded.\n403/429 stop the provider for this run; failures stay explicit in manifest.json.\nA selected set of clubs is not complete league coverage or archived pregame PIT data.\n--details adds official boxscore and play-by-play reads.\n--help prints this message without making requests.';
if (args.includes('--help')) { console.log(usage); process.exit(0); }
const valuedFlags = new Set(['--season', '--teams', '--out', '--max-games']);
const usedFlags = new Set();
for (let i = 0; i < args.length; i += 1) {
  const flag = args[i];
  if (usedFlags.has(flag) || (!valuedFlags.has(flag) && flag !== '--details') || (valuedFlags.has(flag) && (!args[i + 1] || args[i + 1].startsWith('--')))) { console.error(`Invalid, missing or duplicate argument: ${flag}\n${usage}`); process.exit(2); }
  usedFlags.add(flag);
  if (valuedFlags.has(flag)) i += 1;
}
const option = (name, fallback) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : fallback; };
const season = option('--season', null);
const teams = [...new Set(String(option('--teams', '')).split(',').map(s => s.trim().toUpperCase()).filter(Boolean))];
const directory = option('--out', null);
const maxGames = Number(option('--max-games', '10000'));
if (!/^\d{8}$/.test(String(season)) || Number(String(season).slice(4)) !== Number(String(season).slice(0, 4)) + 1 || !teams.length || teams.some(t => !/^[A-Z]{2,3}$/.test(t)) || !directory || !path.isAbsolute(directory) || !Number.isSafeInteger(maxGames) || maxGames < 1) {
  console.error(`Invalid season, teams, output path or game limit.\n${usage}`); process.exit(2);
}
await fs.mkdir(directory, { recursive: true });
const run = { leagueId: 'NHL', startedAt: new Date().toISOString(), season: Number(season), teams, source: 'NHL_OFFICIAL_API', scheduleSources: [], attempts: [], completeLeagueCoverage: false, pregamePointInTimeSnapshots: false, calibrationValidated: false, requestedGames: 0, savedGames: 0, invalidGames: [], blocked: false };
const ids = new Set();
function validCheckpoint(result, gameId) {
  const game = result?.game;
  if (result?.ok !== true || game?.gameId !== gameId || game?.gameType !== 2 || game?.season !== Number(season) || !validateNhlIdentity(game).ok || game?.qa?.canUseHistoricalPeriods !== true || !Array.isArray(game.periods) || game.periods.length !== 3 || game?.source?.url !== `https://api-web.nhle.com/v1/gamecenter/${gameId}/landing` || !Number.isFinite(Date.parse(game.source.fetchedAt))) return false;
  const validScore = score => score && ['awayGoals', 'homeGoals'].every(key => Number.isSafeInteger(score[key]) && score[key] >= 0);
  if (![...game.periods, game.regulation, game.final].every(validScore)) return false;
  for (const key of ['awayGoals', 'homeGoals']) if (game.periods.reduce((sum, period) => sum + period[key], 0) !== game.regulation[key]) return false;
  if (game.outcomeType === 'REG') return game.final.awayGoals !== game.final.homeGoals && ['awayGoals', 'homeGoals'].every(key => game.final[key] === game.regulation[key]);
  return ['OT', 'SO'].includes(game.outcomeType) && game.regulation.awayGoals === game.regulation.homeGoals && Math.abs(game.final.awayGoals - game.final.homeGoals) === 1 && game.final.awayGoals + game.final.homeGoals === game.regulation.awayGoals + game.regulation.homeGoals + 1;
}
for (const team of teams) {
  const result = await fetchNhlClubSchedule(team, season, { timeoutMs: 6500, retry: false });
  run.attempts.push({ step: 'club_schedule', team, ok: result.ok, code: result.code || null, source: result.source });
  if (!result.ok) { run.blocked = true; break; }
  run.scheduleSources.push(result.source);
  await fs.writeFile(path.join(directory, `schedule-${team}-${season}.json`), JSON.stringify(result, null, 2));
  for (const game of result.games) if (game.gameType === 2 && ['OFF', 'FINAL'].includes(game.gameState)) ids.add(game.gameId);
}
run.requestedGames = ids.size;
const games = [];
for (const gameId of [...ids].sort().slice(0, maxGames)) {
  const destination = path.join(directory, `game-${gameId}.json`);
  let result;
  try { result = JSON.parse(await fs.readFile(destination, 'utf8')); if (!validCheckpoint(result, gameId)) result = null; } catch { /* No valid checkpoint; request this game. */ }
  if (!result) {
    result = await fetchNhlGame(gameId, { timeoutMs: 6500, retry: false, includeDetails: args.includes('--details') });
    run.attempts.push({ step: 'game', gameId, ok: result.ok, code: result.code || null, issues: result.issues || [] });
    const providerBlocked = [result.code, ...(result.issues || [])].some(code => ['NHL_SOURCE_FORBIDDEN', 'NHL_SOURCE_RATE_LIMITED'].includes(code));
    if (!validCheckpoint(result, gameId)) { run.invalidGames.push(gameId); if (providerBlocked) { run.blocked = true; break; } continue; }
    await fs.writeFile(destination, JSON.stringify(result, null, 2));
    if (providerBlocked) { games.push(result.game); run.blocked = true; break; }
  }
  games.push(result.game);
}
games.sort((a, b) => a.startTimeUTC.localeCompare(b.startTimeUTC));
run.savedGames = games.length;
run.completedAt = new Date().toISOString();
run.requestedClubRegularSeasonCoverageComplete = !run.blocked && run.invalidGames.length === 0 && games.length === ids.size && !run.attempts.some(a => !a.ok);
run.preseasonIncluded = false;
await fs.writeFile(path.join(directory, 'historical-normalized.json'), JSON.stringify(games, null, 2));
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(run, null, 2));
console.log(JSON.stringify({ ...run, attempts: run.attempts.map(a => ({ step: a.step, team: a.team, gameId: a.gameId, ok: a.ok, code: a.code })), output: directory }, null, 2));
if (run.blocked || run.invalidGames.length) process.exitCode = 1;
