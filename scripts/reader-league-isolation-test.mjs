import assert from 'node:assert/strict';
import {
  analysisCacheKey,
  analysisCachePayloadMatches,
  analysisContractSignature,
} from '../lib/analysis-cache-v9.js';
import {
  signMarketRow,
  signRepriceSnapshot,
  verifyMarketRow,
  verifyRepriceSnapshot,
} from '../lib/market-integrity-v1.js';
import {
  loadReaderSnapshot,
  readerSnapshotStatus,
  READER_STORE_PREFIX,
  storeReaderSnapshot,
} from '../lib/reader-store-v2.js';
import { buildSnapshotFingerprints } from '../lib/snapshot-v9.js';

process.env.READER_STORE_MEMORY_ONLY = 'true';
const date = '2026-08-12';
const leagues = ['MLB', 'NPB', 'KBO', 'CPBL'];

function snapshot(league, count) {
  return {
    league,
    boardDate: date,
    observedAt: '2026-08-12T01:00:00.000Z',
    receivedAt: '2026-08-12T01:00:01.000Z',
    pageActivityAt: '2026-08-12T00:59:59.000Z',
    matchedGameCount: count,
    games: [{ league, gamePk: 777, game: { league, gamePk: 777 }, source: { league } }],
  };
}

for (const [index, league] of leagues.entries()) await storeReaderSnapshot(snapshot(league, index + 1));
for (const [index, league] of leagues.entries()) {
  assert.equal((await loadReaderSnapshot(league, date)).matchedGameCount, index + 1);
  assert.equal((await loadReaderSnapshot(league)).league, league);
}
assert.equal(await loadReaderSnapshot('NPB', '2026-08-13'), null, 'Asian exact-date miss must not fall back to MLB latest');
assert.equal(readerSnapshotStatus(await loadReaderSnapshot('MLB', date), Date.parse('2026-08-12T01:00:30.000Z'), 'NPB').available, false);
assert.equal(READER_STORE_PREFIX, 'baseball-ev:tai888-reader:v2');

const legacyDate = '2026-08-11';
globalThis.__BASEBALL_EV_READER_STORE_V2__.set(`mlb-ev:tai888-reader:v2:date:${legacyDate}`, {
  ...snapshot('MLB', 9),
  league: undefined,
  boardDate: legacyDate,
});
assert.equal((await loadReaderSnapshot('MLB', legacyDate)).league, 'MLB', 'legacy MLB key must migrate read-through');
assert.equal(await loadReaderSnapshot('KBO', legacyDate), null, 'legacy MLB key must never feed an Asian league');
await assert.rejects(
  () => storeReaderSnapshot({ ...snapshot('NPB', 1), games: [{ league: 'MLB', gamePk: 777 }] }),
  /invalid/,
);

const context = {
  game: { gamePk: 777, officialDate: date, gameNumber: 1, awayTeamId: 1, homeTeamId: 2 },
  league: { runsPerTeamGame: 4.1 },
  away: {},
  home: {},
};
const markets = [{ market: '全場大小', pick: '大8平', water: 0.95, lineAsOf: '2026-08-12T00:59:59.000Z', executable: true }];
const versions = { modelVersion: 'model', dataVersion: 'data', uncertaintySetVersion: 'uncertainty', settlementRuleVersion: 'rules', scoreFormulaVersion: 'score' };
const mlbPrints = buildSnapshotFingerprints({ league: 'MLB', context, markets, versions });
const npbPrints = buildSnapshotFingerprints({ league: 'NPB', context, markets, versions });
assert.notEqual(mlbPrints.coreFingerprint, npbPrints.coreFingerprint);
assert.notEqual(mlbPrints.inputHash, npbPrints.inputHash);

const mlbSignature = analysisContractSignature('MLB', context.game, markets);
const npbSignature = analysisContractSignature('NPB', context.game, markets);
assert.notEqual(mlbSignature, npbSignature);
assert.notEqual(analysisCacheKey('MLB', 777, mlbPrints.inputHash), analysisCacheKey('NPB', 777, mlbPrints.inputHash));
const mlbGame = { ...context.game, league: 'MLB' };
const lockedContext = { leagueId: 'MLB', game: { ...mlbGame, leagueId: 'MLB' }, analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false };
const lockedResult = {
  analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
  scoreType: 'SHADOW_DIAGNOSTIC', tag: 'SHADOW｜影子評分｜不可下注',
  unitSuggestion: null, recommendedUnit: null, portfolioRole: '', portfolioUnit: null,
};
const payload = {
  league: 'MLB', game: mlbGame, context: lockedContext,
  analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
  scoreType: 'SHADOW_DIAGNOSTIC', tag: 'SHADOW｜影子評分｜不可下注', unitSuggestion: null,
  portfolio: [], results: [lockedResult],
  analysis: {
    inputHash: mlbPrints.inputHash, analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
    scoreType: 'SHADOW_DIAGNOSTIC', tag: 'SHADOW｜影子評分｜不可下注', unitSuggestion: null,
    portfolio: [], results: [lockedResult],
  },
  repriceSnapshot: {
    inputHash: mlbPrints.inputHash, analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
    portfolio: [], frozenContext: lockedContext,
  },
};
assert.equal(analysisCachePayloadMatches({ signature: mlbSignature, payload }, {
  league: 'MLB', game: mlbGame, fingerprints: mlbPrints, signature: mlbSignature,
}), true);
assert.equal(analysisCachePayloadMatches({ signature: mlbSignature, payload }, {
  league: 'NPB', game: { ...mlbGame, league: 'NPB' }, fingerprints: npbPrints, signature: npbSignature,
}), false);

const signingEnv = { MARKET_INTEGRITY_SECRET: 'four-league-isolation-secret-with-entropy' };
const row = {
  ...markets[0],
  waterEstimated: false,
  waterMissing: false,
  confidence: 1,
  sourceType: 'ACTUAL_TW_CREDIT',
  sourceLabel: 'Tai888 Reader 自動信用盤',
  provider: 'TAI888_READER_AUTO',
  executable: true,
};
const signedRow = await signMarketRow('MLB', mlbGame, row, signingEnv);
assert.equal(await verifyMarketRow('MLB', mlbGame, signedRow, signingEnv), true);
await assert.rejects(() => verifyMarketRow('NPB', mlbGame, signedRow, signingEnv), error => error?.code === 'LEAGUE_IDENTITY_MISMATCH');

const unsignedSnapshot = { frozenContext: { game: mlbGame }, coreFingerprint: 'core', distributionSnapshot: { values: [1] } };
const signedSnapshot = await signRepriceSnapshot('MLB', mlbGame, unsignedSnapshot, signingEnv);
assert.equal(await verifyRepriceSnapshot('MLB', mlbGame, signedSnapshot, signingEnv), true);
await assert.rejects(() => verifyRepriceSnapshot('CPBL', mlbGame, signedSnapshot, signingEnv), error => error?.code === 'LEAGUE_IDENTITY_MISMATCH');

console.log('Reader league isolation: per-league store keys, MLB-only legacy migration, cache/fingerprint/HMAC domains ok');
