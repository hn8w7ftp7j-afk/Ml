import assert from 'node:assert/strict';
import { normalizeTai888ReaderPayload } from '../lib/tai888-reader-parser-v2.js';

const schedule = [
  { gamePk: 101, awayTeamId: 118, homeTeamId: 119, away: '堪薩斯市皇家', home: '洛杉磯道奇', gameDate: '2026-08-12T02:10:00Z' }, // 10:10 Taipei
  { gamePk: 102, awayTeamId: 118, homeTeamId: 119, away: '堪薩斯市皇家', home: '洛杉磯道奇', gameDate: '2026-08-12T09:10:00Z' }, // 17:10 Taipei
  { gamePk: 103, awayTeamId: 135, homeTeamId: 137, away: '聖地牙哥教士', home: '舊金山巨人', gameDate: '2026-08-12T11:45:00Z' },
];

function marketGame(awayCode, homeCode, boardTime) {
  return {
    awayCode,
    homeCode,
    boardDate: '2026-08-12',
    boardTime,
    fullRunline: { lineSide: 'home', line: '1+50', awayWater: 0.95, homeWater: 0.95 },
    fullTotal: { line: '8平', overWater: 0.94, underWater: 0.94 },
  };
}

const payload = {
  version: 'TAI888-READER-DOM-v2.0.2',
  readerVersion: '2.0.2',
  sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/newapp/#/BS',
  pageTitle: '泰8',
  boardDate: '2026-08-12',
  observedAt: '2026-08-12T01:00:00Z',
  games: [
    marketGame('KAN', 'LAD', '10:10'),
    marketGame('SDG', 'SFO', '19:45'),
    marketGame('KAN', 'LAD', '12:30'), // >180 minutes from both official starts, must not guess.
  ],
};

const result = normalizeTai888ReaderPayload(payload, schedule, {
  deviceId: 'device-12345678',
  receivedAt: '2026-08-12T01:00:30Z',
});
assert.equal(result.version, 'TAI888-READER-PARSER-v2.0.2');
assert.equal(result.matchedGameCount, 2);
assert.deepEqual(result.games.map(game => Number(game.gamePk)).sort((a, b) => a - b), [101, 103]);
assert.equal(result.games.find(game => Number(game.gamePk) === 101).readerMeta.awayCode, 'KAN');
assert.equal(result.games.find(game => Number(game.gamePk) === 103).readerMeta.homeCode, 'SFO');
assert.equal(result.unmatched.some(value => value.includes('日期／時間無法唯一配對')), true);

const wrongDate = {
  ...payload,
  boardDate: '2026-08-13',
  games: [marketGame('KAN', 'LAD', '10:10')].map(game => ({ ...game, boardDate: '2026-08-13' })),
};
const wrongDateResult = normalizeTai888ReaderPayload(wrongDate, schedule, {
  deviceId: 'device-12345678',
  receivedAt: '2026-08-12T01:00:30Z',
});
assert.equal(wrongDateResult.matchedGameCount, 0);

console.log('Reader 2.0.2 game matching: aliases, doubleheader time selection, distance and date rejection PASS');
