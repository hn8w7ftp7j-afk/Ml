import assert from 'node:assert/strict';
import { buildSnapshotFingerprints } from '../lib/snapshot-v9.js';
import {
  analysisCacheKey,
  analysisCachePayloadMatches,
  analysisContractSignature,
} from '../lib/analysis-cache-v9.js';

const versions = {
  modelVersion: 'model-v1',
  dataVersion: 'data-v1',
  uncertaintySetVersion: 'uncertainty-v1',
  settlementRuleVersion: 'settlement-v1',
  scoreFormulaVersion: 'score-v1',
};
const calculationSettings = {
  rebateRate: 0,
  simulationsPerScenario: 1800,
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  expertMode: 'off',
};

const baseContext = {
  game: {
    league: 'MLB',
    gamePk: 1001,
    officialDate: '2026-08-11',
    gameNumber: 1,
    away: '客隊A',
    home: '主隊A',
    awayTeamId: 1,
    homeTeamId: 2,
  },
  league: { runsPerTeamGame: 4.35 },
  away: { seasonHitting: { available: true, ops: 0.72 }, seasonPitching: { available: true, era: 4.1 } },
  home: { seasonHitting: { available: true, ops: 0.73 }, seasonPitching: { available: true, era: 4.0 } },
  weather: { available: true, temperature: 25 },
  park: { runFactor: 1 },
  umpire: { name: '' },
  featureProvenance: [],
  starterModelingMode: 'NEUTRAL_STARTER_UNCERTAINTY',
  fetchedAt: '2026-08-11T01:00:00Z',
};
const markets = [
  { market: '全場大小', pick: '大8.5', water: 0.82, sourceType: 'INTERNATIONAL', lineAsOf: '2026-08-11T01:00:00Z', executable: false },
  { market: '全場大小', pick: '小8.5', water: 0.86, sourceType: 'INTERNATIONAL', lineAsOf: '2026-08-11T01:00:00Z', executable: false },
];
const previousMarkets = [
  { market: '全場大小', pick: '大8平', water: 0.84, sourceType: 'INTERNATIONAL', lineAsOf: '2026-08-10T23:00:00Z', executable: false },
  { market: '全場大小', pick: '小8平', water: 0.84, sourceType: 'INTERNATIONAL', lineAsOf: '2026-08-10T23:00:00Z', executable: false },
];

const input = {
  league: 'MLB',
  context: baseContext,
  markets,
  versions,
  calculationSettings,
  auxiliaryInput: { previousMarkets },
};
const first = buildSnapshotFingerprints(input);
const repeated = buildSnapshotFingerprints({
  ...input,
  context: { ...baseContext, fetchedAt: '2026-08-11T01:01:00Z' },
  markets: [...markets].reverse(),
  auxiliaryInput: { previousMarkets: [...previousMarkets].reverse() },
});
assert.equal(first.coreFingerprint, repeated.coreFingerprint, 'volatile fetch time must not change the core fingerprint');
assert.equal(first.priceFingerprint, repeated.priceFingerprint, 'market row order must not change the price fingerprint');
assert.equal(first.auxiliaryFingerprint, repeated.auxiliaryFingerprint, 'previous-market row order must not change auxiliary fingerprint');
assert.equal(first.inputHash, repeated.inputHash, 'same complete input must reproduce the same inputHash');

const otherGame = buildSnapshotFingerprints({
  ...input,
  context: {
    ...baseContext,
    game: { ...baseContext.game, gamePk: 1002, away: '客隊B', home: '主隊B', awayTeamId: 3, homeTeamId: 4 },
  },
});
assert.notEqual(first.coreFingerprint, otherGame.coreFingerprint, 'different game must have a different core fingerprint');
assert.notEqual(first.inputHash, otherGame.inputHash, 'different game must have a different inputHash');

const otherWater = buildSnapshotFingerprints({
  ...input,
  markets: markets.map((row, index) => index === 0 ? { ...row, water: 0.95 } : row),
});
assert.equal(first.coreFingerprint, otherWater.coreFingerprint, 'price-only change must retain core fingerprint');
assert.notEqual(first.priceFingerprint, otherWater.priceFingerprint, 'water change must change price fingerprint');
assert.notEqual(first.inputHash, otherWater.inputHash, 'water change must change inputHash');

const otherSimulationCount = buildSnapshotFingerprints({
  ...input,
  calculationSettings: { ...calculationSettings, simulationsPerScenario: 500 },
});
assert.equal(first.coreFingerprint, otherSimulationCount.coreFingerprint);
assert.equal(first.priceFingerprint, otherSimulationCount.priceFingerprint);
assert.notEqual(first.calculationFingerprint, otherSimulationCount.calculationFingerprint, 'simulation count must change calculation fingerprint');
assert.notEqual(first.inputHash, otherSimulationCount.inputHash, 'simulation count must change inputHash');

const otherRebate = buildSnapshotFingerprints({
  ...input,
  calculationSettings: { ...calculationSettings, rebateRate: 0.015 },
});
assert.notEqual(first.calculationFingerprint, otherRebate.calculationFingerprint, 'rebate rate must change calculation fingerprint');
assert.notEqual(first.inputHash, otherRebate.inputHash, 'rebate rate must change inputHash');

const otherPreviousPrice = buildSnapshotFingerprints({
  ...input,
  auxiliaryInput: {
    previousMarkets: previousMarkets.map((row, index) => index === 0 ? { ...row, water: 0.90 } : row),
  },
});
assert.notEqual(first.auxiliaryFingerprint, otherPreviousPrice.auxiliaryFingerprint, 'previous-market evidence must change auxiliary fingerprint');
assert.notEqual(first.inputHash, otherPreviousPrice.inputHash, 'previous-market evidence must change inputHash');

const shadowContext = {
  ...baseContext,
  game: { ...baseContext.game, league: 'NPB' },
  leagueId: 'NPB',
  analysisMode: 'EXPERIMENTAL_SHADOW',
  modelVersion: 'npb-model-v1',
  rulesVersion: 'npb-rules-v1',
  modelConfig: { shrink: { full: 0.70, first5: 0.68 }, allowDraw: true },
};
const shadowInput = { ...input, league: 'NPB', context: shadowContext };
const shadowPrints = buildSnapshotFingerprints(shadowInput);
for (const [label, context] of [
  ['analysisMode', { ...shadowContext, analysisMode: 'FORMAL' }],
  ['modelConfig', { ...shadowContext, modelConfig: { ...shadowContext.modelConfig, shrink: { full: 0.74, first5: 0.68 } } }],
  ['modelVersion', { ...shadowContext, modelVersion: 'npb-model-v2' }],
  ['rulesVersion', { ...shadowContext, rulesVersion: 'npb-rules-v2' }],
]) {
  const changed = buildSnapshotFingerprints({ ...shadowInput, context });
  assert.notEqual(shadowPrints.coreFingerprint, changed.coreFingerprint, `${label} must change the core fingerprint`);
  assert.notEqual(shadowPrints.inputHash, changed.inputHash, `${label} must change the input hash`);
}
const defaultMlbBytes = buildSnapshotFingerprints({ ...input, context: baseContext });
const undefinedContractMlbBytes = buildSnapshotFingerprints({
  ...input,
  context: { ...baseContext, analysisMode: undefined, modelConfig: undefined, modelVersion: undefined, rulesVersion: undefined },
});
assert.equal(defaultMlbBytes.coreFingerprint, undefinedContractMlbBytes.coreFingerprint, 'default MLB core bytes must not gain empty model-contract keys');

const signature = analysisContractSignature('MLB', baseContext.game, markets);
const otherSignature = analysisContractSignature('MLB', otherGame.corePayload.game, markets);
assert.notEqual(signature, otherSignature, 'contract signature must include game identity');
const cacheKey = analysisCacheKey('MLB', baseContext.game.gamePk, first.inputHash);
const otherCacheKey = analysisCacheKey('MLB', otherGame.corePayload.game.gamePk, otherGame.inputHash);
assert.notEqual(cacheKey, otherCacheKey, 'cache key must be game isolated');

const payload = {
  league: 'MLB',
  game: baseContext.game,
  context: { game: baseContext.game },
  analysis: { inputHash: first.inputHash },
  repriceSnapshot: { inputHash: first.inputHash },
};
assert.equal(analysisCachePayloadMatches({ signature, payload }, {
  league: 'MLB',
  game: baseContext.game,
  fingerprints: first,
  signature,
}), true);
assert.equal(analysisCachePayloadMatches({ signature, payload }, {
  league: 'MLB',
  game: otherGame.corePayload.game,
  fingerprints: otherGame,
  signature: otherSignature,
}), false, 'cached payload from another game must be rejected');

const shadowGame = shadowContext.game;
const shadowSignature = analysisContractSignature('NPB', shadowGame, markets);
const lockedContext = { ...shadowContext, executable: false, betEligible: false };
const lockedResult = {
  analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
  scoreType: 'SHADOW_DIAGNOSTIC', tag: 'SHADOW｜影子評分｜不可下注',
  unitSuggestion: null, recommendedUnit: null, portfolioRole: '', portfolioUnit: null,
};
const shadowPayload = {
  league: 'NPB',
  game: shadowGame,
  context: { ...lockedContext, game: shadowGame },
  analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
  scoreType: 'SHADOW_DIAGNOSTIC', tag: 'SHADOW｜影子評分｜不可下注', unitSuggestion: null,
  portfolio: [], results: [lockedResult],
  analysis: {
    inputHash: shadowPrints.inputHash,
    analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
    scoreType: 'SHADOW_DIAGNOSTIC', tag: 'SHADOW｜影子評分｜不可下注', unitSuggestion: null,
    portfolio: [], results: [lockedResult],
  },
  repriceSnapshot: {
    inputHash: shadowPrints.inputHash,
    analysisMode: 'EXPERIMENTAL_SHADOW', executable: false, betEligible: false,
    portfolio: [], frozenContext: { ...lockedContext, game: shadowGame },
  },
};
const shadowEntry = { signature: shadowSignature, payload: shadowPayload };
const shadowMatch = candidate => analysisCachePayloadMatches({ ...shadowEntry, payload: candidate }, {
  league: 'NPB', game: shadowGame, fingerprints: shadowPrints, signature: shadowSignature,
});
assert.equal(shadowMatch(shadowPayload), true);
for (const [label, candidate] of [
  ['top executable', { ...shadowPayload, executable: true }],
  ['top portfolio', { ...shadowPayload, portfolio: [{ pick: 'unsafe' }] }],
  ['top tag', { ...shadowPayload, tag: '主推' }],
  ['context', { ...shadowPayload, context: { ...shadowPayload.context, betEligible: true } }],
  ['analysis result', { ...shadowPayload, analysis: { ...shadowPayload.analysis, results: [{ ...lockedResult, tag: '主推' }] } }],
  ['reprice snapshot', { ...shadowPayload, repriceSnapshot: { ...shadowPayload.repriceSnapshot, portfolio: [{ pick: 'unsafe' }] } }],
  ['frozen context', { ...shadowPayload, repriceSnapshot: { ...shadowPayload.repriceSnapshot, frozenContext: { ...shadowPayload.repriceSnapshot.frozenContext, analysisMode: 'FORMAL' } } }],
]) assert.equal(shadowMatch(candidate), false, `unsafe shadow cache layer must miss: ${label}`);

console.log(JSON.stringify({
  ok: true,
  repeatedInputHash: first.inputHash,
  otherGameInputHash: otherGame.inputHash,
  priceOnlyInputHash: otherWater.inputHash,
  simulationInputHash: otherSimulationCount.inputHash,
  rebateInputHash: otherRebate.inputHash,
  previousMarketInputHash: otherPreviousPrice.inputHash,
  cacheKey,
  otherCacheKey,
}, null, 2));
