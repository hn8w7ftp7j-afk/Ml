import assert from 'node:assert/strict';
import { normalizeTai888ReaderPayload } from '../lib/tai888-reader-parser-v2.js';

const schedule = [
  { gamePk: 1, awayTeamId: 134, homeTeamId: 146, away: '匹茲堡海盜', home: '邁阿密馬林魚', gameDate: '2026-08-11T22:40:00Z' },
  { gamePk: 2, awayTeamId: 114, homeTeamId: 116, away: '克里夫蘭守護者', home: '底特律老虎', gameDate: '2026-08-11T22:40:00Z' },
];
const payload = {
  version: 'TAI888-READER-DOM-v2.0.0', readerVersion: '2.0.0', sourceHost: 'www1.tai888.in',
  pageUrl: 'https://www1.tai888.in/board', pageTitle: '泰8', boardDate: '2026-08-12', observedAt: '2026-08-11T22:30:00Z',
  games: [
    { awayCode: 'PIT', homeCode: 'MIA', boardDate: '2026-08-12', boardTime: '06:40', fullRunline: { lineSide: 'away', line: '1+85', awayWater: .95, homeWater: .95, rawRows: ['1+85 0.950', '0.950'] }, fullTotal: { line: '7-10', overWater: .94, underWater: .94 }, first5Runline: { lineSide: 'away', line: '0-15', awayWater: .94, homeWater: .94 }, first5Total: { line: '3.5', overWater: .93, underWater: .93 } },
    { awayCode: 'CLE', homeCode: 'DET', boardDate: '2026-08-12', boardTime: '06:40', fullRunline: { lineSide: 'home', line: '1+20', awayWater: .95, homeWater: .95 }, fullTotal: { line: '8+30', overWater: .94, underWater: .94 }, first5Runline: { lineSide: 'home', line: '0-90', awayWater: .94, homeWater: .94 }, first5Total: { line: '4-60', overWater: .93, underWater: .93 } },
  ],
};
const result = normalizeTai888ReaderPayload(payload, schedule, { deviceId: 'device-12345678', receivedAt: '2026-08-11T22:30:30Z' });
assert.equal(result.matchedGameCount, 2);
assert.equal(result.games[0].markets.length, 8);
assert.equal(result.games[0].markets[0].pick, '匹茲堡海盜讓1+85');
assert.equal(result.games[0].markets[1].pick, '邁阿密馬林魚受讓1+85');
assert.equal(result.games[1].markets[0].pick, '底特律老虎讓1+20');
assert.equal(result.games[1].markets[1].pick, '克里夫蘭守護者受讓1+20');
assert.equal(result.games[1].markets[4].pick, '底特律老虎讓0-90');
assert.match(result.payloadHash, /^[a-f0-9]{64}$/);
console.log('tai888 reader server parser v2: ok');
