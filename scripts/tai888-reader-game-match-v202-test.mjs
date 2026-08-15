import assert from 'node:assert/strict';
import { normalizeTai888ReaderPayload } from '../lib/tai888-reader-parser-v2.js';

const schedule = [
  { gamePk: 101, awayTeamId: 118, homeTeamId: 119, away: '堪薩斯市皇家', home: '洛杉磯道奇', gameDate: '2026-08-12T02:10:00Z', doubleHeader: 'Y', gameNumber: 1 },
  { gamePk: 102, awayTeamId: 118, homeTeamId: 119, away: '堪薩斯市皇家', home: '洛杉磯道奇', gameDate: '2026-08-12T09:10:00Z', doubleHeader: 'Y', gameNumber: 2 },
  { gamePk: 103, awayTeamId: 135, homeTeamId: 137, away: '聖地牙哥教士', home: '舊金山巨人', gameDate: '2026-08-12T11:45:00Z' },
];

function marketGame(awayCode, homeCode, boardTime, suffix = 0) {
  return {
    awayCode,
    homeCode,
    boardDate: '2026-08-12',
    boardTime,
    fullRunline: { lineSide: 'home', line: `1+${50 + suffix}`, awayWater: 0.95, homeWater: 0.95 },
    fullTotal: { line: `8+${suffix}`, overWater: 0.94, underWater: 0.94 },
    first5Runline: { lineSide: 'away', line: `0-${50 + suffix}`, awayWater: 0.93, homeWater: 0.93 },
    first5Total: { line: `4-${suffix || 10}`, overWater: 0.92, underWater: 0.92 },
  };
}

function payload(games) {
  return {
    version: 'TAI888-READER-DOM-v2.0.3',
    readerVersion: '2.0.3',
    sourceHost: 'www1.tai888.in',
    pageUrl: 'https://www1.tai888.in/newapp/#/BS',
    pageTitle: '泰8',
    boardDate: '2026-08-12',
    observedAt: '2026-08-12T01:00:00Z',
    pageActivityAt: '2026-08-12T00:59:45Z',
    expectedGameCount: games.length,
    detectedGameCount: games.length,
    games,
  };
}

const fullPayload = payload([
  marketGame('KAN', 'LAD', '17:10', 20),
  marketGame('SDG', 'SFO', '19:45', 30),
  marketGame('KAN', 'LAD', '10:10', 10),
]);
const options = { deviceId: 'device-12345678', receivedAt: '2026-08-12T01:00:30Z' };
const result = normalizeTai888ReaderPayload(fullPayload, schedule, options);
assert.equal(result.version, 'TAI888-READER-PARSER-v2.0.3');
assert.equal(result.matchedGameCount, 3);
assert.deepEqual(result.games.map(game => Number(game.gamePk)), [101, 102, 103]);
assert.equal(result.games.every(game => game.markets.length === 8), true);
assert.equal(result.games.find(game => game.gamePk === 101).readerMeta.boardTime, '10:10');
assert.equal(result.games.find(game => game.gamePk === 102).readerMeta.boardTime, '17:10');
assert.equal(result.games.find(game => game.gamePk === 101).markets.some(row => row.pick.includes('1+60')), true);
assert.equal(result.games.find(game => game.gamePk === 102).markets.some(row => row.pick.includes('1+70')), true);
assert.equal(result.games.find(game => game.gamePk === 103).readerMeta.homeCode, 'SFO');

const partial = payload([
  marketGame('KAN', 'LAD', '10:10', 10),
  marketGame('SDG', 'SFO', '19:45', 30),
]);
partial.expectedGameCount = 3;
const partialResult = normalizeTai888ReaderPayload(partial, schedule, options);
assert.equal(partialResult.rawGameCount, 2);
assert.equal(partialResult.matchedGameCount, 2);
assert.equal(partialResult.unopenedGameCount, 1);
assert.equal(partialResult.unopenedGames[0].gamePk, 102);
assert.equal(partialResult.unopenedGames[0].unavailableReason, 'not-rendered-by-reader');
assert.equal(partialResult.unopenedGames[0].source.executable, false);

const ambiguousSchedule = [
  { ...schedule[0], gameDate: '2026-08-12T02:10:00Z' },
  { ...schedule[1], gameDate: '2026-08-12T04:10:00Z' },
  schedule[2],
];
const ambiguous = payload([
  marketGame('KAN', 'LAD', '11:10', 10),
  marketGame('KAN', 'LAD', '11:10', 20),
  marketGame('SDG', 'SFO', '19:45', 30),
]);
assert.throws(
  () => normalizeTai888ReaderPayload(ambiguous, ambiguousSchedule, options),
  /無法唯一配對.*拒絕跨場次合併/,
);

console.log('Reader 2.0.3 full-board matching: aliases, deterministic doubleheaders, no merge, and partial/ambiguous rejection PASS');
