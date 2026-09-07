import assert from 'node:assert/strict';
import { reliefOnlyGameLog, bullpenUsageCoverage } from '../lib/mlb-bullpen-evidence-v1.js';
import { buildBullpenV13, hydrateBullpenReliefV13, recoverRecentPitchCountsV13 } from '../lib/mlb-context-v13.js';
import { estimateRunProfileV13 } from '../lib/joint-score-v13.js';
import { buildAnalysisDataAudit } from '../lib/analysis-data-audit-v1.js';

let cases = 0;
const check = (name, fn) => { fn(); cases++; };
const gameDate = '2026-09-07T02:10:00Z';
const stats = { inningsPitched: 60, gamesPitched: 50, gamesStarted: 0, era: 3, whip: 1.1, strikeOuts: 60, baseOnBalls: 15, homeRuns: 5, saves: 0, holds: 1 };
const roster = Array.from({ length: 6 }, (_, index) => ({ id: 20 + index, name: `fixture-${index}`, position: 'RP', ...stats }));
function makeFeed(pitches) {
  const player = { person: { id: 20, fullName: 'fixture-0' }, stats: { pitching: { numberOfPitches: pitches } } };
  const home = { pitchers: [99, 20], players: { ID20: player, ID99: { person: { id: 99 }, stats: { pitching: { numberOfPitches: 90 } } } } };
  return { gamePk: 100, gameData: { status: { abstractGameState: 'Final' }, datetime: { dateTime: '2026-09-06T02:10:00Z', officialDate: '2026-09-05' }, teams: { home: { id: 119 }, away: { id: 120 } } }, liveData: { boxscore: { teams: { home } } } };
}
const expectedRecentGames = [{ gamePk: 100, officialDate: '2026-09-05' }];
const run = (value, extra = {}) => buildBullpenV13({ roster, recentFeeds: [makeFeed(value)], teamId: 119, gameDate, rosterComplete: true, expectedRecentGames, ...extra });
for (const value of [null, undefined, '', false, [], {}, -1, 1.5]) check(`unknown pitch count ${JSON.stringify(value)}`, () => {
  const result = run(value);
  assert.equal(result.fatigueIndex, null); assert.equal(result.highLeverageAvailability, null);
  assert.equal(result.relievers[0].availability, null); assert.equal(result.relievers[0].pitchesLast1, null);
  assert.equal(result.relievers[0].modelAvailability, 1); assert.equal(result.status, 'PROJECTED');
  assert.equal(result.usageAvailable, false); assert.equal(result.qualityFactorIncludesUsage, false);
  assert.equal(result.usageCoverage.missingGames[0].missingPlayers[0].id, '20');
});
check('real zero is observed and heavy usage changes later innings', () => {
  const rested = run(0), tired = run(35);
  assert.equal(rested.fatigueIndex, 0); assert.equal(rested.relievers[0].availability, 1);
  assert.equal(tired.relievers[0].availability, 0.25); assert.equal(tired.usageCoverage.completeGames, 1);
  const profile = bullpen => estimateRunProfileV13({ home: { bullpen, starter: { expectedInnings: 5.5 } }, away: {} });
  assert.equal(profile(rested).first5.away, profile(tired).first5.away);
  assert.ok(profile(tired).ninth.away > profile(rested).ninth.away);
});
check('missing game stays in denominator and audit', () => {
  const result = run(30, { expectedRecentGames: [...expectedRecentGames, { gamePk: 101, officialDate: '2026-09-04' }] });
  assert.equal(result.usageCoverage.expectedGames, 2); assert.equal(result.usageCoverage.completeGames, 1);
  assert.equal(result.usageAvailable, false);
  const audit = buildAnalysisDataAudit({ home: { bullpen: result } }, {});
  assert.equal(audit.rows.find(row => row.id === 'home.bullpen').coverage.usage.missingGames[0].gamePk, 101);
});
for (const mutate of [feed => { feed.gameData.teams.home.id = 999; }, feed => { feed.gameData.datetime.dateTime = gameDate; }, feed => { feed.gameData.datetime.dateTime = null; }, feed => { feed.gameData.status.abstractGameState = 'Live'; }]) check('wrong identity/time/status not usable', () => {
  const feed = makeFeed(30); mutate(feed);
  assert.equal(bullpenUsageCoverage({ recentFeeds: [feed], expectedRecentGames, teamId: 119, gameDate }).complete, false);
});
check('starter complete game is verified zero relief usage', () => {
  const feed = makeFeed(0); feed.liveData.boxscore.teams.home.pitchers = [99];
  const result = run(0, { recentFeeds: [feed] }); assert.equal(result.usageAvailable, true); assert.equal(result.fatigueIndex, 0);
});
check('duplicate feeds cannot double count fatigue; conflicts stay unknown', () => {
  assert.equal(run(30, { recentFeeds: [makeFeed(30), makeFeed(30)] }).fatigueIndex, run(30).fatigueIndex);
  assert.equal(run(30, { recentFeeds: [makeFeed(30), makeFeed(35)] }).usageAvailable, false);
});

const appearance = (id, role, innings, earnedRuns, overrides = {}) => ({ player: { id: 20 }, sport: { id: 1 }, season: '2026', date: '2026-09-04', game: { gamePk: id }, stat: { gamesStarted: role, inningsPitched: innings, earnedRuns, hits: 1, baseOnBalls: 0, strikeOuts: 2, homeRuns: 0, saves: 0, holds: 0 }, ...overrides });
const payload = rows => ({ stats: [{ group: { displayName: 'pitching' }, splits: rows }] });
const opts = { playerId: 20, endDate: '2026-09-05' };
const rows = [appearance(1, 1, '7.0', 10), appearance(2, 0, '1.1', 1), appearance(3, 0, '2.2', 0), appearance(4, 0, '9.0', 20, { date: '2026-09-06' })];
check('only relief counts, exact outs and PIT cutoff', () => {
  const result = reliefOnlyGameLog(payload(rows), opts);
  assert.equal(result.inningsPitched, 4); assert.equal(result.earnedRuns, 1); assert.equal(result.era, 2.25);
  assert.equal(result.gamesPitched, 2); assert.equal(result.gamesStarted, 0); assert.deepEqual(result.sourceGameIds, [2, 3]);
});
for (const overrides of [{ player: { id: 99 } }, { sport: { id: 11 } }, { season: '2025' }]) check('cross-scope records rejected', () => {
  assert.equal(reliefOnlyGameLog(payload([appearance(1, 0, '1.0', 0, overrides)]), opts).available, false);
});
for (const value of [null, '', false]) check('unknown role cannot become relief', () => assert.equal(reliefOnlyGameLog(payload([appearance(1, value, '1.0', 0)]), opts).available, false));
check('duplicates deduplicated, conflicts rejected', () => {
  assert.equal(reliefOnlyGameLog(payload([rows[1], rows[1]]), opts).gamesPitched, 1);
  assert.equal(reliefOnlyGameLog(payload([rows[1], { ...rows[1], stat: { ...rows[1].stat, earnedRuns: 2 } }]), opts).available, false);
});
check('invalid innings and missing dates rejected', () => {
  assert.equal(reliefOnlyGameLog(payload([appearance(1, 0, null, 0)]), opts).available, false);
  assert.equal(reliefOnlyGameLog(payload([appearance(1, 0, '1.3', 0)]), opts).available, false);
  assert.equal(reliefOnlyGameLog(payload([appearance(1, 0, '1.0', 0, { date: null })]), opts).available, false);
});
check('missing counts not borrowed from season totals', () => {
  const row = appearance(1, 0, '1.0', 0); row.stat.baseOnBalls = null;
  assert.equal(reliefOnlyGameLog(payload([row]), opts).whip, null);
});
const mixed = [{ ...roster[0], gamesStarted: 19, gamesPitched: 20, position: 'SP' }, ...roster.slice(1)];
check('mixed season never masquerades as relief ability', () => {
  const result = run(20, { roster: mixed });
  assert.equal(result.relievers[0].inningsPitched, null); assert.equal(result.relievers[0].era, null);
  assert.equal(result.relievers[0].qualityFactor, 1); assert.equal(result.qualityCoverage, 5 / 6);
});
const calls = [];
const hydrated = await hydrateBullpenReliefV13(mixed, [makeFeed(20)], 119, opts.endDate, { fetchImpl: async url => { calls.push(String(url)); return Response.json(payload(rows)); } });
check('only mixed candidate hydrated with individual MLB game log', () => {
  assert.equal(calls.length, 1); assert.match(calls[0], /people\/20\/stats/); assert.match(calls[0], /stats=gameLog/);
  const result = run(20, { roster: hydrated }); assert.equal(result.relievers[0].inningsPitched, 4); assert.equal(result.relievers[0].era, 2.25);
  assert.equal(result.relievers[0].metricScope, 'RELIEF_ONLY'); assert.equal(result.relievers[0].metricProvenance.accepted, true);
  const profile = rows => estimateRunProfileV13({ home: { bullpen: run(20, { roster: rows }), starter: { expectedInnings: 5.5 } }, away: {} });
  assert.equal(profile(mixed).first5.away, profile(hydrated).first5.away);
  assert.notEqual(profile(mixed).ninth.away, profile(hydrated).ninth.away);
});
const input = { ok: true, data: makeFeed(null) };
const backup = structuredClone(input.data.liveData.boxscore); backup.teams.home.team = { id: 119 }; backup.teams.home.players.ID20.stats.pitching.numberOfPitches = 32;
const recovered = await recoverRecentPitchCountsV13(input, { fetchImpl: async () => Response.json(backup) });
check('exact game boxscore repairs only missing pitch count with receipt', () => {
  assert.equal(recovered.data.liveData.boxscore.teams.home.players.ID20.stats.pitching.numberOfPitches, 32);
  assert.equal(input.data.liveData.boxscore.teams.home.players.ID20.stats.pitching.numberOfPitches, null);
  assert.equal(recovered.sourceReceipts[0].sourceGameId, 100);
});
backup.teams.home.team.id = 999;
const wrong = await recoverRecentPitchCountsV13(input, { fetchImpl: async () => Response.json(backup) });
check('wrong backup team cannot fill missing pitches', () => assert.equal(wrong.data.liveData.boxscore.teams.home.players.ID20.stats.pitching.numberOfPitches, null));
console.log(JSON.stringify({ suite: 'bullpen-evidence-v11917', cases, ok: true }));
check('current reliever yesterday started: workload counted without importing starter quality', () => {
  const feed = makeFeed(0);
  feed.liveData.boxscore.teams.home.pitchers = [20];
  feed.liveData.boxscore.teams.home.players.ID20.stats.pitching.numberOfPitches = 90;
  const result = run(0, { recentFeeds: [feed] });
  const pitcher = result.relievers.find(row => row.id === 20);
  assert.equal(pitcher.pitchesLast1, 90);
  assert.equal(pitcher.availability, 0.25);
  assert.equal(pitcher.inningsPitched, stats.inningsPitched);
  delete feed.liveData.boxscore.teams.home.players.ID20.stats.pitching.numberOfPitches;
  assert.equal(run(0, { recentFeeds: [feed] }).usageAvailable, false);
});
