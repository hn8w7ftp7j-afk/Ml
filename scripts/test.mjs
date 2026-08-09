import assert from 'node:assert/strict';
import {
  calculateProfit,
  hasActualWater,
  mirrorTaiwanLineToken,
  normalizeVisionGame,
  outcomeFractionForScore,
  parseTaiwanLine,
  resultTag,
  SCORE_CONTRACT_VERSION,
  scoreFromCompositeEV,
  validateScoreContract,
  validateMarketPair,
} from '../lib/markets.js';
import { analyzeMarkets, estimateRuns, MODEL_VERSION, RULES_VERSION } from '../lib/analysis.js';
import { fallbackExpertAssessment, sanitizeExpertAssessment } from '../lib/expert.js';
import { VISION_VERSION, buildVisionPrompt, cleanVisionJSON, expandVisionPayload } from '../lib/vision.js';
import { BATCH_VERSION, buildAutoAnalysisPlan } from '../lib/batch.js';

const away = '紐約洋基';
const home = '亞特蘭大勇士';

assert.equal(parseTaiwanLine(`${home}受讓1+10`).team, home);
assert.equal(parseTaiwanLine('芝加哥小熊讓1平').team, '芝加哥小熊');
assert.equal(parseTaiwanLine('大8+90').isOver, true);
assert.equal(parseTaiwanLine('小8+90').isUnder, true);
assert.equal(parseTaiwanLine(`${home}1+10`).valid, false);

// Project convention: + at the exact line wins a fraction for the giving/over side; - loses a fraction.
assert.equal(outcomeFractionForScore(`${away}讓1+50`, 4, 3, away, home), 0.5);
assert.equal(outcomeFractionForScore(`${home}受讓1+50`, 4, 3, away, home), -0.5);
assert.equal(outcomeFractionForScore(`${away}讓1-30`, 4, 3, away, home), -0.3);
assert.equal(outcomeFractionForScore(`${home}受讓1-30`, 4, 3, away, home), 0.3);
assert.equal(outcomeFractionForScore('大8+50', 4, 4, away, home), 0.5);
assert.equal(outcomeFractionForScore('小8+50', 4, 4, away, home), -0.5);
assert.equal(outcomeFractionForScore('大8-30', 4, 4, away, home), -0.3);
assert.equal(outcomeFractionForScore('小8-30', 4, 4, away, home), 0.3);
assert.equal(outcomeFractionForScore('大8平', 4, 4, away, home), 0);
assert.equal(outcomeFractionForScore(`${home}受讓0.5/1`, 4, 3, away, home), -0.5);
assert.equal(outcomeFractionForScore('勇士讓1平', 3, 4, '亞特蘭大勇士', '勇士隊'), null);

let profit = calculateProfit({ stake: 10000, water: 0.95, fraction: 1, rebateRate: 0.015 });
assert.equal(profit.profit, 9650);
profit = calculateProfit({ stake: 10000, water: 0.95, fraction: -1, rebateRate: 0.015 });
assert.equal(profit.profit, -9850);
profit = calculateProfit({ stake: 10000, water: 0.95, fraction: 0.5, rebateRate: 0.015 });
assert.equal(profit.profit, 4825);
profit = calculateProfit({ stake: 10000, water: 0.95, fraction: -0.5, rebateRate: 0.015 });
assert.equal(profit.profit, -4925);
profit = calculateProfit({ stake: 10000, water: 0.95, fraction: 0, rebateRate: 0.015 });
assert.deepEqual(profit, { profit: 0, rebate: 0, settledAmount: 0 });

assert.equal(hasActualWater(0.95), true);
assert.equal(hasActualWater(null), false);
assert.deepEqual(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小8+50', water: null }]), []);
assert.deepEqual(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小8+50', water: 0.94 }]), []);
assert.equal(mirrorTaiwanLineToken('8-80'), '8+80');
assert.equal(mirrorTaiwanLineToken('1+40'), '1-40');
assert.ok(validateMarketPair('全場大小', [{ pick: '大8+50', water: 0.94 }, { pick: '小9+50', water: 0.94 }]).length > 0);

const vision = normalizeVisionGame({
  away,
  home,
  fullRunline: { lineSide: 'away', line: '1+50', awayWater: null, homeWater: null, confidence: 1 },
  fullTotal: { line: '8+50', overWater: 0.94, underWater: null, confidence: 1 },
}, { gamePk: 1, away, home }, { 全場讓分: 0.95, 全場大小: 0.94 });
assert.equal(vision.markets[0].directions[0].waterEstimated, true);
assert.equal(vision.markets[0].directions[1].waterEstimated, true);
assert.equal(vision.markets[1].directions[0].waterEstimated, false);
assert.equal(vision.markets[1].directions[1].water, null);
assert.equal(vision.markets[0].directions[0].pick, `${away}讓1+50`);
assert.equal(vision.markets[0].directions[1].pick, `${home}受讓1+50`);
assert.equal(vision.markets[1].directions[0].pick, '大8+50');
assert.equal(vision.markets[1].directions[1].pick, '小8+50');
assert.equal(vision.markets[2].directions[0].pick, '');

const nullLikeVision = normalizeVisionGame({
  away,
  home,
  first5Total: { line: 'null', overWater: null, underWater: null, confidence: 0 },
  first5Runline: { lineSide: 'away', line: 'undefined', awayWater: null, homeWater: null, confidence: 0 },
}, { gamePk: 2, away, home }, { 上半大小: 0.93, 上半讓分: 0.94 });
assert.equal(nullLikeVision.markets[2].directions[0].pick, '');
assert.equal(nullLikeVision.markets[2].directions[0].water, null);
assert.equal(nullLikeVision.markets[3].directions[0].pick, '');
assert.equal(nullLikeVision.markets[3].directions[1].pick, '');
assert.deepEqual(validateMarketPair('上半大小', nullLikeVision.markets[3].directions), []);

assert.ok(validateMarketPair('全場讓分', [
  { pick: '匹茲堡海盜讓9-10', water: 0.95 },
  { pick: '紐約大都會受讓9-10', water: 0.95 },
]).some(error => error.includes('疑似辨識錯欄')));
assert.ok(validateMarketPair('上半讓分', [
  { pick: '匹茲堡海盜讓9-10', water: 0.95 },
  { pick: '紐約大都會受讓9-10', water: 0.95 },
]).some(error => error.includes('疑似辨識錯欄')));
assert.equal(normalizeVisionGame({ away: '紐約大都會', home: '匹茲堡海盜', fullRunline: { lineSide:'home', line:'9-10', awayWater:null, homeWater:0.95 } }, { gamePk:9, away:'紐約大都會', home:'匹茲堡海盜' }).markets[0].directions[0].pick, '');



const compactVision = expandVisionPayload(cleanVisionJSON(JSON.stringify({
  g: [{
    id: 99,
    a: away,
    h: home,
    c: 0.91,
    fr: ['away', '1+50', 0.95, null, 0.88],
    ft: ['8+50', 0.94, 0.94, 0.92],
    r5: null,
    t5: ['4+20', 0.93, null, 0.7],
  }],
})));
assert.equal(compactVision.games.length, 1);
assert.equal(compactVision.games[0].gamePk, 99);
assert.equal(compactVision.games[0].fullRunline.lineSide, 'away');
assert.equal(compactVision.games[0].fullRunline.awayWater, 0.95);
assert.equal(compactVision.games[0].fullRunline.homeWater, null);
assert.equal(compactVision.games[0].fullTotal.line, '8+50');
assert.equal(compactVision.games[0].first5Runline.line, '');
assert.ok(buildVisionPrompt([{ gamePk: 99, away, home }]).includes('"g"'));
assert.match(VISION_VERSION, /v8\.2\.4$/);

const autoPlan = buildAutoAnalysisPlan({
  games: [{
    id: 'recognized-1',
    away,
    home,
    matchedGame: { gamePk: 44, away, home },
    markets: [
      { market: '全場讓分', directions: [{ pick: `${away}讓1+50`, water: 0.95 }, { pick: `${home}受讓1+50`, water: 0.95 }] },
      { market: '全場大小', directions: [{ pick: '大8+50', water: 0.94 }, { pick: '小9+50', water: 0.94 }] },
      { market: '上半讓分', directions: [{ pick: '', water: null }, { pick: '', water: null }] },
      { market: '上半大小', directions: [{ pick: '', water: null }, { pick: '', water: null }] },
    ],
  }, {
    id: 'recognized-2',
    away: '未配對客隊',
    home: '未配對主隊',
    matchedGame: null,
    markets: [],
  }],
  settings: { fallbackWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 } },
  version: 'test-version',
  batchId: 'batch-test',
  idFactory: () => 'lock-test',
  now: () => '2026-08-09T00:00:00.000Z',
});
assert.equal(BATCH_VERSION, 'MLB-AUTO-ANALYZE-ALL-2026-08-v1');
assert.equal(autoPlan.locks.length, 1);
assert.equal(autoPlan.locks[0].batchId, 'batch-test');
assert.equal(autoPlan.locks[0].markets.length, 2);
assert.ok(autoPlan.locks[0].markets.every(row => row.market === '全場讓分'));
assert.ok(autoPlan.issues.some(value => value.includes('全場大小')));
assert.ok(autoPlan.issues.some(value => value.includes('尚未配對')));


const neutralScore = scoreFromCompositeEV(0, { weightedEV: -0.002, robustEV: -0.015, flipProbability: 0.55, quality: 0.78, edgeStrength: 0, stability: 0.40, modelErrorFloor: 0.025, independentEvidence: 0.50, divergenceRisk: 0.08 });
assert.ok(neutralScore >= 3.5 && neutralScore <= 5.2);
const candidateScore = scoreFromCompositeEV(0.041, { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, edgeStrength: 0.55, stability: 0.80, modelErrorFloor: 0.025, independentEvidence: 0.65, divergenceRisk: 0.05 });
assert.ok(candidateScore >= 7.2 && candidateScore < 8.0);
const strongestScore = scoreFromCompositeEV(0.090, { weightedEV: 0.112, robustEV: 0.086, flipProbability: 0.05, quality: 0.92, edgeStrength: 0.85, stability: 0.90, modelErrorFloor: 0.025, independentEvidence: 0.78, divergenceRisk: 0.03 });
assert.ok(strongestScore >= 8.5 && strongestScore <= 9.4);
const oldExplosiveCase = scoreFromCompositeEV(0.10, { weightedEV: 0.13, robustEV: 0.1179, flipProbability: 0.06, quality: 0.88, edgeStrength: 0.80, stability: 0.88, modelErrorFloor: 0.025, independentEvidence: 0.70, divergenceRisk: 0.04 });
assert.ok(oldExplosiveCase >= 8.2 && oldExplosiveCase < 9.4);
assert.notEqual(oldExplosiveCase, 10);
assert.ok(scoreFromCompositeEV(-0.12, { weightedEV: -0.14, robustEV: -0.15, flipProbability: 0.90, quality: 0.80, edgeStrength: -1, stability: 0.10 }) >= 3.5);
assert.ok(scoreFromCompositeEV(0.01, { weightedEV: 0.02, robustEV: -0.001 }) <= 7.1);
assert.ok(scoreFromCompositeEV(0.12, { weightedEV: 0.15, robustEV: 0.10, waterEstimated: true }) <= 6.6);
assert.equal(validateScoreContract(candidateScore, 0.041, { weightedEV: 0.052, robustEV: 0.043, flipProbability: 0.12, quality: 0.85, modelErrorFloor: 0.025, independentEvidence: 0.65 }).ok, true);
assert.equal(validateScoreContract(10, 0.10, { weightedEV: 0.13, robustEV: 0.12, flipProbability: 0.03, quality: 0.95, modelErrorFloor: 0.025, independentEvidence: 0.80 }).ok, false);
assert.equal(SCORE_CONTRACT_VERSION, 'GPT-COMPOSITE-EVIDENCE-v8.2');
assert.equal(resultTag(8.5), '最強主推');
assert.equal(resultTag(8.1), '主推');
assert.equal(resultTag(7.6), '正常下注');
assert.equal(resultTag(7.3), '小注候選');
assert.equal(resultTag(6.9), '觀察');

const context = {
  game: { gamePk: 1, gameDate: '2026-08-09T00:00:00Z', away, home, awayProbable: 'A', homeProbable: 'B' },
  league: { available: true, runsPerTeamGame: 4.35 },
  away: {
    seasonHitting: { available: true, gamesPlayed: 112, runsPerGame: 4.65, ops: 0.748, iso: 0.165, kRate: 0.22, bbRate: 0.087 },
    recentHitting: { available: true, gamesPlayed: 12, runsPerGame: 4.85, ops: 0.758, iso: 0.172, kRate: 0.215, bbRate: 0.09 },
    seasonPitching: { available: true, inningsPitched: 980, era: 4.02, whip: 1.27 },
    recentPitching: { available: true, inningsPitched: 24, era: 3.92, whip: 1.24 },
    vsLeft: { available: true, ops: 0.755 },
    vsRight: { available: true, ops: 0.744 },
    starter: {
      available: true, confirmed: true, throws: 'R', expectedInnings: 5.7,
      season: { inningsPitched: 124, gamesStarted: 22, era: 3.82, fip: 3.90, whip: 1.21, kMinusBB: 0.168, hrPer9: 1.02 },
      recent: { inningsPitched: 20, gamesStarted: 3, era: 3.55, fip: 3.70, whip: 1.17, kMinusBB: 0.18, hrPer9: 0.9 },
      pitchQuality: { available: true, runFactor: 0.98 },
    },
    lineup: { official: false, projected: true, offensiveIndex: 1.02, catcher: 'A Catcher' },
    bullpen: { usageAvailable: true, fatigueIndex: 0.22, highLeverageAvailability: 0.85 },
    defense: { available: true, fieldingPercentage: 0.986, errorsPerGame: 0.51 },
    baserunning: { runIndex: 1.01 },
    rest: { available: true, days: 1, travelKm: 0, previousExtraInnings: false },
    injuries: [], injuryImpact: 0,
  },
  home: {
    seasonHitting: { available: true, gamesPlayed: 112, runsPerGame: 4.40, ops: 0.722, iso: 0.150, kRate: 0.23, bbRate: 0.082 },
    recentHitting: { available: true, gamesPlayed: 12, runsPerGame: 4.30, ops: 0.713, iso: 0.145, kRate: 0.235, bbRate: 0.08 },
    seasonPitching: { available: true, inningsPitched: 980, era: 4.16, whip: 1.29 },
    recentPitching: { available: true, inningsPitched: 24, era: 4.22, whip: 1.31 },
    vsLeft: { available: true, ops: 0.710 },
    vsRight: { available: true, ops: 0.725 },
    starter: {
      available: true, confirmed: true, throws: 'L', expectedInnings: 5.3,
      season: { inningsPitched: 116, gamesStarted: 22, era: 4.18, fip: 4.12, whip: 1.29, kMinusBB: 0.142, hrPer9: 1.22 },
      recent: { inningsPitched: 18, gamesStarted: 3, era: 4.35, fip: 4.25, whip: 1.32, kMinusBB: 0.13, hrPer9: 1.35 },
      pitchQuality: { available: true, runFactor: 1.02 },
    },
    lineup: { official: false, projected: true, offensiveIndex: 0.99, catcher: 'B Catcher' },
    bullpen: { usageAvailable: true, fatigueIndex: 0.32, highLeverageAvailability: 0.72 },
    defense: { available: true, fieldingPercentage: 0.984, errorsPerGame: 0.58 },
    baserunning: { runIndex: 0.99 },
    rest: { available: true, days: 1, travelKm: 420, previousExtraInnings: false },
    injuries: [], injuryImpact: 0,
  },
  weather: { available: true, temperature: 27, windSpeed: 12, precipitationProbability: 10, roofClosedProbability: 0, roofConfirmed: true },
  park: { runFactor: 1.01, roof: 'open' },
  umpire: { name: '', status: '未知' },
  warnings: [],
  coreModelable: true,
  featureProvenance: [],
};

const fallbackExpert = fallbackExpertAssessment(context, 'unit-test fallback');
assert.equal(fallbackExpert.used, false);
assert.ok(fallbackExpert.assessment.audit.unmodeled.length > 0);
context.expertAssessment = sanitizeExpertAssessment({
  contextConfidence: 0.82,
  independentEvidenceStrength: 0.62,
  marketReliance: 0.60,
  modelErrorFloor: 0.024,
  adjustments: {
    awayOffense: { multiplier: 1.01, uncertaintyAdd: 0.01, reason: 'platoon interaction', evidenceKeys: ['vsLeft'] },
    homeOffense: { multiplier: 0.995, uncertaintyAdd: 0.015, reason: 'projected lineup', evidenceKeys: ['lineup.projected'] },
    awayStarter: { runMultiplier: 0.99, inningsDelta: 0.1, uncertaintyAdd: 0.01 },
    homeStarter: { runMultiplier: 1.01, inningsDelta: -0.1, uncertaintyAdd: 0.015 },
  },
  scenarioProbabilities: {
    away: { low: 0.18, central: 0.62, high: 0.20 },
    home: { low: 0.23, central: 0.60, high: 0.17 },
    environment: { low: 0.18, central: 0.64, high: 0.18 },
  },
  audit: { unknown: ['official lineup'], unmodeled: ['Statcast live movement'] },
  summary: 'unit test expert layer',
}, context, 'unit-test-model');
assert.equal(context.expertAssessment.used, true);

const auditGuard = sanitizeExpertAssessment({
  audit: {
    confirmed: ['invented confirmed fact'],
    estimated: ['invented estimated fact'],
    unknown: ['official roof not confirmed'],
  },
}, context, 'audit-guard-model');
assert.equal(auditGuard.assessment.audit.confirmed.includes('invented confirmed fact'), false);
assert.equal(auditGuard.assessment.audit.estimated.includes('invented estimated fact'), false);
assert.ok(auditGuard.assessment.audit.unknown.some(value => value.includes('GPT 待確認：official roof not confirmed')));


const fullRuns = estimateRuns(context, false);
const first5Runs = estimateRuns(context, true);
assert.ok(fullRuns.away > first5Runs.away && fullRuns.home > first5Runs.home);

const markets = [
  { market: '全場讓分', pick: `${away}讓1+10`, water: 0.95, confidence: 1 },
  { market: '全場讓分', pick: `${home}受讓1+10`, water: 0.95, confidence: 1 },
  { market: '全場大小', pick: '大8+90', water: 0.94, confidence: 1 },
  { market: '全場大小', pick: '小8+90', water: 0.94, confidence: 1 },
  { market: '上半讓分', pick: `${away}讓0平`, water: 0.94, confidence: 1 },
  { market: '上半讓分', pick: `${home}受讓0平`, water: 0.94, confidence: 1 },
  { market: '上半大小', pick: '大4+50', water: 0.93, confidence: 1 },
  { market: '上半大小', pick: '小4+50', water: 0.93, confidence: 1 },
];
const settings = { rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, simulationsPerScenario: 500 };
const previousMarkets = markets.map(row => ({ ...row, water: row.water - 0.02 }));
const analysis = analyzeMarkets({ context, markets, previousMarkets, settings });
assert.equal(analysis.modelVersion, MODEL_VERSION);
assert.equal(analysis.rulesVersion, RULES_VERSION);
assert.equal(analysis.results.length, 8);
assert.equal(analysis.scenarioSummary.count, 27);
assert.equal(analysis.scenarioSummary.robustVariantCount, 7);
assert.equal(analysis.scenarioSummary.sharedDistribution, true);
assert.equal(analysis.scenarioSummary.jointPortfolioDistribution, true);
assert.equal(analysis.alignmentAudit.expertLayer.used, true);
assert.ok(analysis.alignmentAudit.unmodeled.length > 0);
assert.ok(analysis.results.every(row => row.modelErrorFloor >= 0.015 && row.modelErrorFloor <= 0.06));
assert.ok(analysis.results.every(row => row.independentEvidenceStrength >= 0.15 && row.independentEvidenceStrength <= 0.85));
assert.ok(analysis.scenarioSummary.jointCellCount > 0);
assert.ok(analysis.results.every(row => Number.isFinite(row.score) && row.score >= 3.5 && row.score <= 9.4));
assert.ok(analysis.results.every(row => Number.isFinite(row.weightedEV) && Number.isFinite(row.robustEV) && Number.isFinite(row.conservativeEV)));
assert.ok(analysis.results.every(row => row.robustEV <= row.weightedEV + 1e-10));
assert.ok(analysis.results.every(row => row.cev === row.conservativeEV));
assert.ok(analysis.results.every(row => row.scoreFormulaVersion === SCORE_CONTRACT_VERSION));
assert.equal(analysis.scoreContractVersion, SCORE_CONTRACT_VERSION);
assert.equal(analysis.scoreValidation.passed, true);
assert.ok(analysis.results.every(row => row.scoreAudit?.ok === true));
assert.ok(analysis.results.every(row => row.evFlipProbability >= 0 && row.evFlipProbability <= 1));
assert.ok(analysis.results.every(row => row.distributionCoverage > 0.999));
assert.ok(analysis.results.every(row => row.movement.available));
assert.ok(analysis.portfolio.reduce((sum, row) => sum + row.recommendedUnit, 0) <= 2.0001);

for (const marketName of ['全場讓分', '全場大小', '上半讓分', '上半大小']) {
  const pair = analysis.results.filter(row => row.market === marketName);
  assert.equal(pair.length, 2);
  assert.ok(Math.abs(pair[0].modelProbability + pair[1].modelProbability - 1) < 0.012, `${marketName} 機率未互補`);
  assert.ok(pair.filter(row => row.betEligible).length <= 1, `${marketName} 正反方向同時進下注池`);
  assert.ok(Math.abs(pair[0].score - pair[1].score) <= 5.900001, `${marketName} 分數超出正式尺度`);
  assert.ok(pair.every(row => row.pairAudit?.ok === true), `${marketName} 正反方向驗算失敗`);
}


for (const result of analysis.results.filter(row => row.marketAnchorProbability != null)) {
  assert.equal(result.marketCalibrationApplied, true);
  assert.ok(result.marketCalibrationWeight >= 0.12 && result.marketCalibrationWeight <= 0.55);
  assert.ok(result.maximumCalibratedProbabilityEdge >= 0.05 && result.maximumCalibratedProbabilityEdge <= 0.12);
  assert.ok(result.calibratedMarketProbabilityGap <= result.maximumCalibratedProbabilityEdge + 1e-10);
  assert.equal(result.scoreAudit?.ok, true);
  assert.equal(result.scoreContractVersion, SCORE_CONTRACT_VERSION);
  if (result.score >= 7.2) assert.ok(result.weightedEV > 0 && result.robustEV > 0 && result.conservativeEV > 0);
  if (result.score >= 8.5) assert.ok(result.evFlipProbability <= 0.12 && result.confidence >= 0.78 && result.independentEvidenceStrength >= 0.55);
}

const disagreementContext = structuredClone(context);
Object.assign(disagreementContext.home.seasonHitting, { runsPerGame: 6.20, ops: 0.900, iso: 0.245 });
Object.assign(disagreementContext.away.seasonHitting, { runsPerGame: 3.20, ops: 0.620, iso: 0.105 });
const disagreement = analyzeMarkets({ context: disagreementContext, markets: markets.filter(row => row.market === '全場讓分'), settings });
for (const row of disagreement.results) {
  assert.equal(row.marketCalibrationApplied, true);
  assert.ok(row.calibratedMarketProbabilityGap <= row.maximumCalibratedProbabilityEdge + 1e-10);
}

const repeat = analyzeMarkets({ context, markets, previousMarkets, settings });
for (let index = 0; index < analysis.results.length; index += 1) {
  assert.equal(analysis.results[index].weightedEV, repeat.results[index].weightedEV);
  assert.equal(analysis.results[index].score, repeat.results[index].score);
}

const missing = analyzeMarkets({
  context,
  markets: [
    { market: '全場大小', pick: '大8+50', water: 0.94, confidence: 1 },
    { market: '全場大小', pick: '小8+50', water: null, confidence: 1 },
  ],
  settings,
});
assert.equal(missing.results.find(row => row.pick === '小8+50').score, null);
assert.equal(missing.results.find(row => row.pick === '小8+50').tag, '水位未提供｜不評分');

const estimated = analyzeMarkets({
  context,
  markets: [
    { market: '全場大小', pick: '大8+50', water: 0.94, waterEstimated: true, confidence: 1 },
    { market: '全場大小', pick: '小8+50', water: 0.94, waterEstimated: true, confidence: 1 },
  ],
  settings,
});
assert.ok(estimated.results.every(row => row.score <= 6.6 && row.betEligible === false));

const better = analyzeMarkets({
  context,
  markets: [
    { market: '全場大小', pick: '大8平', water: 0.98, confidence: 1 },
    { market: '全場大小', pick: '小8平', water: 0.95, confidence: 1 },
  ],
  settings,
}).results.find(row => row.pick === '大8平');
const worse = analyzeMarkets({
  context,
  markets: [
    { market: '全場大小', pick: '大8平', water: 0.90, confidence: 1 },
    { market: '全場大小', pick: '小8平', water: 0.95, confidence: 1 },
  ],
  settings,
}).results.find(row => row.pick === '大8平');
assert.ok(better.weightedEV >= worse.weightedEV);
assert.ok(better.score >= worse.score);

assert.throws(() => analyzeMarkets({ context: { ...context, coreModelable: false }, markets, settings }), /資料不足｜不評分/);

console.log(JSON.stringify({
  ok: true,
  modelVersion: analysis.modelVersion,
  dataQuality: analysis.dataQuality,
  expectedRuns: analysis.expectedRuns,
  maximumScore: Math.max(...analysis.results.map(row => row.score)),
  portfolio: analysis.portfolio,
}, null, 2));
