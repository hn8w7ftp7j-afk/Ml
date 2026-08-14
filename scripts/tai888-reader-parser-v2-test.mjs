import assert from 'node:assert/strict';
import {
  normalizeTai888ReaderPayload,
  rawTai888ReaderPayloadHash,
  readerMarketsComplete,
  readerSnapshotIsComplete,
  sanitizeTai888PageUrl,
} from '../lib/tai888-reader-parser-v2.js';

const schedule = [
  { gamePk: 1, awayTeamId: 134, homeTeamId: 146, away: '匹茲堡海盜', home: '邁阿密馬林魚', gameDate: '2026-08-11T22:40:00Z' },
  { gamePk: 2, awayTeamId: 114, homeTeamId: 116, away: '克里夫蘭守護者', home: '底特律老虎', gameDate: '2026-08-11T22:40:00Z' },
];
const querySecret = 'SERVER_QUERY_SECRET';
const hashSecret = 'SERVER_HASH_SECRET';
const titleSecret = 'SERVER_TITLE_SECRET';
const frameSecret = 'SERVER_FRAME_SECRET';
const payload = {
  version: 'TAI888-READER-DOM-v2.0.3',
  readerVersion: '2.0.3 FINAL MULTIFRAME VERIFIED',
  sourceHost: 'www1.tai888.in',
  pageUrl: `https://www1.tai888.in/newapp/?token=${querySecret}#/BS?session=${hashSecret}`,
  pageTitle: titleSecret,
  frameUrl: `https://www1.tai888.in/frame?token=${frameSecret}#private`,
  boardDate: '2026-08-12',
  observedAt: '2026-08-11T22:30:00Z',
  pageActivityAt: '2026-08-11T22:29:45Z',
  expectedGameCount: 2,
  detectedGameCount: 2,
  payloadHash: '0'.repeat(64),
  games: [
    {
      awayCode: 'PIT', homeCode: 'MIA', boardDate: '2026-08-12', boardTime: '06:40',
      fullRunline: { lineSide: 'away', line: '1+85', awayWater: .95, homeWater: .95, rawRows: ['1+85 0.950', '0.950'] },
      fullTotal: { line: '7-10', overWater: .49, underWater: 1.83 },
      first5Runline: { lineSide: 'away', line: '0-15', awayWater: .94, homeWater: .94 },
      first5Total: { line: '3.5', overWater: .93, underWater: .93 },
    },
    {
      awayCode: 'CLE', homeCode: 'DET', boardDate: '2026-08-12', boardTime: '06:40',
      fullRunline: { lineSide: 'home', line: '1+20', awayWater: .95, homeWater: .95 },
      fullTotal: { line: '8+30', overWater: .94, underWater: .94 },
      first5Runline: { lineSide: 'home', line: '0-90', awayWater: .94, homeWater: .94 },
      first5Total: { line: '4-60', overWater: .93, underWater: .93 },
    },
  ],
};
const options = { deviceId: 'device-12345678', receivedAt: '2026-08-11T22:30:30Z' };
const result = normalizeTai888ReaderPayload(payload, schedule, options);
assert.equal(result.version, 'TAI888-READER-PARSER-v2.0.3');
assert.equal(result.matchedGameCount, 2);
assert.equal(result.scheduleGameCount, 2);
assert.equal(result.unmatched.length, 0);
assert.equal(result.pageUrl, 'https://www1.tai888.in/newapp/#/BS');
assert.equal(Object.hasOwn(result, 'pageTitle'), false);
assert.equal(Object.hasOwn(result, 'frameUrl'), false);
const serialized = JSON.stringify(result);
for (const secret of [querySecret, hashSecret, titleSecret, frameSecret]) {
  assert.equal(serialized.includes(secret), false, `${secret} must not survive normalized storage`);
}
assert.equal(result.games.every(game => readerMarketsComplete(game.markets)), true);
assert.equal(result.games.every(game => game.markets.length === 8), true);
assert.equal(result.games.every(game => game.markets.every(row => row.lineAsOf === '2026-08-11T22:29:45.000Z')), true);
assert.equal(result.games[0].markets.some(row => row.pick === '匹茲堡海盜讓1+85'), true);
assert.equal(result.games[0].markets.some(row => row.pick === '邁阿密馬林魚受讓1+85'), true);
assert.equal(result.games[0].markets.some(row => row.pick === '大7-10' && row.water === 0.49), true);
assert.equal(result.games[0].markets.some(row => row.pick === '小7-10' && row.water === 1.83), true);
assert.equal(result.games[1].markets.some(row => row.pick === '底特律老虎讓1+20'), true);
assert.equal(result.games[1].markets.some(row => row.pick === '克里夫蘭守護者受讓1+20'), true);
assert.match(result.payloadHash, /^[a-f0-9]{64}$/);
assert.match(result.rawBoardHash, /^[a-f0-9]{64}$/);
assert.equal(readerSnapshotIsComplete(result), true);
assert.equal(readerSnapshotIsComplete({ ...result, pageTitle: 'LEGACY_TITLE_SECRET' }), false);
assert.equal(readerSnapshotIsComplete({ ...result, frameUrl: 'https://www1.tai888.in/frame?LEGACY_FRAME_SECRET' }), false);
assert.equal(
  readerSnapshotIsComplete({ ...result, pageUrl: 'https://www1.tai888.in/newapp/?LEGACY_QUERY_SECRET#/BS' }),
  false,
);

const spoofed = { ...payload, payloadHash: 'f'.repeat(64) };
assert.equal(rawTai888ReaderPayloadHash(spoofed), result.rawBoardHash, 'client hash must not control server board identity');
assert.equal(normalizeTai888ReaderPayload(spoofed, schedule, options).payloadHash, result.payloadHash);

const alternatePrivateMetadata = {
  ...payload,
  pageUrl: 'https://www1.tai888.in/newapp/?token=ANOTHER_QUERY#/BS?session=ANOTHER_HASH',
  pageTitle: 'ANOTHER_PRIVATE_TITLE',
  frameUrl: 'https://www1.tai888.in/private?token=ANOTHER_FRAME_SECRET#private',
};
const alternateMetadataResult = normalizeTai888ReaderPayload(alternatePrivateMetadata, schedule, options);
assert.equal(alternateMetadataResult.rawBoardHash, result.rawBoardHash);
assert.equal(alternateMetadataResult.payloadHash, result.payloadHash);
assert.equal(alternateMetadataResult.pageUrl, result.pageUrl);
assert.equal(JSON.stringify(alternateMetadataResult).includes('ANOTHER_'), false);
assert.equal(
  sanitizeTai888PageUrl('https://www1.tai888.in/newapp/board?token=secret#arbitrary-hash'),
  'https://www1.tai888.in/newapp/board',
);
assert.equal(sanitizeTai888PageUrl('http://www1.tai888.in/newapp/#/BS'), '');

const reordered = { ...payload, games: [...payload.games].reverse() };
const reorderedResult = normalizeTai888ReaderPayload(reordered, [...schedule].reverse(), options);
assert.equal(reorderedResult.rawBoardHash, result.rawBoardHash);
assert.equal(reorderedResult.payloadHash, result.payloadHash);
assert.deepEqual(reorderedResult.games.map(game => game.gamePk), [1, 2]);

const incomplete = structuredClone(payload);
delete incomplete.games[0].first5Total;
assert.throws(
  () => normalizeTai888ReaderPayload(incomplete, schedule, options),
  /四個市場與八個可執行方向/,
);

assert.throws(
  () => normalizeTai888ReaderPayload({ ...payload, readerVersion: '2.0.2' }, schedule, options),
  error => error?.status === 426,
);

assert.throws(
  () => normalizeTai888ReaderPayload({ ...payload, expectedGameCount: 3 }, schedule, options),
  /expectedGameCount.*不一致/,
);
assert.throws(
  () => normalizeTai888ReaderPayload({ ...payload, detectedGameCount: 1 }, schedule, options),
  /detectedGameCount.*不一致/,
);
const missingExpected = { ...payload };
delete missingExpected.expectedGameCount;
assert.throws(
  () => normalizeTai888ReaderPayload(missingExpected, schedule, options),
  /expectedGameCount 缺失/,
);
const missingDetected = { ...payload };
delete missingDetected.detectedGameCount;
assert.throws(
  () => normalizeTai888ReaderPayload(missingDetected, schedule, options),
  /detectedGameCount 缺失/,
);
assert.throws(
  () => normalizeTai888ReaderPayload({ ...payload, pageActivityAt: '2026-08-11T22:20:00Z' }, schedule, options),
  error => error?.status === 409,
);

console.log('tai888 reader server parser v2.0.3: deterministic 4/8 board, server hash, freshness and minimum version ok');
