import assert from 'node:assert/strict';
import {
  attestIncomingMarketRows,
  marketIntegrityConfigured,
  signMarketRow,
  signRepriceSnapshot,
  verifyMarketRow,
  verifyRepriceSnapshot,
} from '../lib/market-integrity-v1.js';
import {
  assertGameHasNotStarted,
  fetchOfficialTaipeiSlate,
  validateOfficialScheduleSubset,
} from '../lib/official-schedule-v1.js';
import { normalizeJbotReference } from '../lib/reference-lines.js';
import { providerTimestamp } from '../lib/reference-time.js';

const signingEnv = { MARKET_INTEGRITY_SECRET: 'unit-market-integrity-secret-32-bytes' };
assert.equal(marketIntegrityConfigured({ APP_PASSWORD: 'login-only', TAI888_PASSWORD: 'sportsbook-only' }), false);
assert.equal(marketIntegrityConfigured({ SESSION_SECRET: 'session-is-an-allowed-hmac-key' }), true);

const game = {
  gamePk: 990001,
  gameDate: '2099-08-11T23:00:00.000Z',
  taipeiDate: '2099-08-12',
  gameNumber: 1,
  awayTeamId: 111,
  homeTeamId: 141,
  away: '波士頓紅襪',
  home: '多倫多藍鳥',
};
const market = {
  market: '全場大小',
  pick: '大8.5',
  water: 0.95,
  waterEstimated: false,
  waterMissing: false,
  confidence: 1,
  sourceType: 'ACTUAL_TW_CREDIT',
  sourceLabel: 'Tai888 Reader 自動信用盤',
  provider: 'TAI888_READER_AUTO',
  providerEventId: 'reader-1',
  lineAsOf: '2099-08-11T22:59:00.000Z',
  executable: true,
};
const signedMarket = await signMarketRow(game, market, signingEnv);
assert.equal(await verifyMarketRow(game, signedMarket, signingEnv), true);
assert.equal(await verifyMarketRow(game, { ...signedMarket, water: 1.05 }, signingEnv), false);
assert.equal(await verifyMarketRow({ ...game, gameNumber: 2 }, signedMarket, signingEnv), false);

await assert.rejects(
  () => attestIncomingMarketRows(game, [market], signingEnv),
  error => error?.status === 409 && /缺少伺服器簽章/.test(error.message),
);
const [manual] = await attestIncomingMarketRows(game, [{
  ...market,
  provider: 'USER_MANUAL_ENTRY',
  sourceLabel: 'Tai888 Reader 自動信用盤',
  authorizationStatus: 'USER_CONFIRMED_MANUAL',
}], signingEnv);
assert.equal(manual.provider, 'USER_MANUAL_ENTRY');
assert.equal(manual.sourceLabel, '使用者手動輸入盤口');
assert.equal(manual.authorizationStatus, 'USER_CONFIRMED_MANUAL');
assert.equal(await verifyMarketRow(game, manual, signingEnv), true);

const snapshot = {
  frozenContext: { game, fetchedAt: '2099-08-11T22:00:00.000Z' },
  coreFingerprint: 'core-1',
  distributionSnapshot: { distributionId: 'distribution-1', distributionHash: 'hash-1', values: [0.2, 0.8] },
  distributionId: 'distribution-1',
  distributionHash: 'hash-1',
};
const signedSnapshot = await signRepriceSnapshot(game, snapshot, signingEnv);
assert.equal(await verifyRepriceSnapshot(game, signedSnapshot, signingEnv), true);
assert.equal(await verifyRepriceSnapshot(game, {
  ...signedSnapshot,
  distributionSnapshot: { ...signedSnapshot.distributionSnapshot, values: [0.3, 0.7] },
}, signingEnv), false);

function statsGame({ gamePk, gameDate, gameNumber }) {
  return {
    gamePk,
    gameDate,
    officialDate: gameDate.slice(0, 10),
    gameNumber,
    doubleHeader: 'Y',
    scheduledInnings: 9,
    status: { detailedState: 'Scheduled', statusCode: 'S' },
    teams: {
      away: { team: { id: 111, name: 'Boston Red Sox' } },
      home: { team: { id: 141, name: 'Toronto Blue Jays' } },
    },
    venue: { id: 13, name: 'Rogers Centre' },
  };
}

const statsPayload = {
  dates: [{ games: [
    statsGame({ gamePk: 990001, gameDate: '2099-08-11T23:00:00Z', gameNumber: 1 }),
    statsGame({ gamePk: 990002, gameDate: '2099-08-12T02:00:00Z', gameNumber: 2 }),
  ] }],
};
const fetchImpl = async () => new Response(JSON.stringify(statsPayload), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});
const fullSlate = await fetchOfficialTaipeiSlate('2099-08-12', { fetchImpl });
assert.deepEqual(fullSlate.map(row => row.gamePk), [990001, 990002]);
assert.equal(validateOfficialScheduleSubset([game], fullSlate, '2099-08-12')[0].gamePk, 990001);
assert.throws(
  () => validateOfficialScheduleSubset([{ ...game, homeTeamId: 147 }], fullSlate, '2099-08-12'),
  error => error?.status === 409 && error?.code === 'OFFICIAL_IDENTITY_MISMATCH',
);
await assert.rejects(
  () => fetchOfficialTaipeiSlate('2099-08-12', { fetchImpl: async () => new Response('unavailable', { status: 503 }) }),
  error => error?.status === 502 && error?.code === 'OFFICIAL_SCHEDULE_UNAVAILABLE',
);

assert.equal(providerTimestamp('2099-08-12T10:00', { assumeTaipei: true }), '2099-08-12T02:00:00.000Z');
assert.equal(providerTimestamp('2099-08-12T10:00'), null);
const fetchedAt = '2099-08-12T01:55:00.000Z';
const doubleheader = normalizeJbotReference({
  status: 'OK',
  data: [{
    id: 'doubleheader-game-2',
    time: '2099-08-12T10:00',
    away: '波士頓紅襪',
    home: '多倫多藍鳥',
    odds: [{
      handi: { '-1.5': { a: 1.9, h: 1.9, m: true } },
      total: { '8.5': { o: 1.9, u: 1.9, m: true } },
    }],
  }],
}, fullSlate, { fetchedAt });
assert.equal(doubleheader.games[0].gamePk, 990002);
assert.ok(doubleheader.games[0].markets.every(row => row.lineAsOf === fetchedAt));
const requestedOnlyGameOne = new Set([990001]);
assert.equal(doubleheader.games.filter(row => requestedOnlyGameOne.has(row.gamePk)).length, 0);

const timezoneUpdate = normalizeJbotReference({
  status: 'OK',
  data: [{
    id: 'timezone-update', time: '2099-08-12T10:00', away: '波士頓紅襪', home: '多倫多藍鳥',
    odds: [{ update: '2099-08-12T09:50', total: { '8.5': { o: 1.9, u: 1.9, m: true } } }],
  }],
}, fullSlate, { fetchedAt });
assert.ok(timezoneUpdate.games[0].markets.every(row => row.lineAsOf === '2099-08-12T01:50:00.000Z'));

const missingEventTime = normalizeJbotReference({
  status: 'OK',
  data: [{
    id: 'missing-time', away: '波士頓紅襪', home: '多倫多藍鳥',
    odds: [{ total: { '8.5': { o: 1.9, u: 1.9, m: true } } }],
  }],
}, fullSlate, { fetchedAt });
assert.equal(missingEventTime.games.length, 0);
assert.equal(missingEventTime.unmatched.length, 1);

assert.throws(
  () => assertGameHasNotStarted({ ...game, gameDate: '2000-01-01T00:00:00.000Z' }, Date.parse('2000-01-01T00:00:00.000Z')),
  error => error?.status === 409 && error?.code === 'GAME_ALREADY_STARTED',
);

console.log(JSON.stringify({
  ok: true,
  signedMarket: true,
  signedSnapshot: true,
  officialSlate: fullSlate.length,
  doubleheaderOracleClosed: true,
  timezoneVerified: true,
  missingEventTimeRejected: true,
}, null, 2));
