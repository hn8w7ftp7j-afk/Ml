import Decimal from 'decimal.js';
import { sha256 } from './snapshot-v9.js';
import {
  MARKET_ORDER,
  calculateProfit,
  breakEvenProbability,
  hasActualWater,
  normalizeWater,
  outcomeFractionForScore,
  outcomeSettlementForScore,
  parseTaiwanLine,
  resultTag,
} from './markets.js';

export const MODEL_VERSION = 'MLB-JOINT-SCORE-DISTRIBUTION-2026-08-v9.1.1';
export const RULES_VERSION = 'MLB-TW-DETERMINISTIC-EXECUTION-2026-08-v9.1.1';
export const SHADOW_ANALYSIS_MODE = 'EXPERIMENTAL_SHADOW';
export const FORMAL_ANALYSIS_MODE = 'FORMAL';
export const SHADOW_SCORE_TYPE = 'SHADOW_DIAGNOSTIC';
export const SHADOW_RESULT_TAG = 'SHADOW｜影子評分｜不可下注';

const ASIAN_LEAGUES = new Set(['NPB', 'KBO', 'CPBL']);
export const DEFAULT_MODEL_CONFIG = Object.freeze({
  baselineBounds: Object.freeze({
    full: Object.freeze({ min: 3.9, max: 4.8 }),
    first5: Object.freeze({ min: 3.9 * (5 / 9), max: 4.8 * (5 / 9) }),
  }),
  scoreClamps: Object.freeze({
    full: Object.freeze({ min: 2.25, max: 7.15 }),
    first5: Object.freeze({ min: 0.75, max: 4.45 }),
  }),
  homeCoefficient: Object.freeze({ full: 1.025, first5: 1.012 }),
  shrink: Object.freeze({ full: 0.78, first5: 0.78 }),
  extraInningsLimit: 12,
  allowDraw: false,
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const safe = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const logit = value => {
  const p = clamp(safe(value, 0.5), 0.001, 0.999);
  return Math.log(p / (1 - p));
};
const logistic = value => 1 / (1 + Math.exp(-value));

function plainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function valueAt(source, paths) {
  for (const path of paths) {
    let value = source;
    for (const key of path) value = value?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function finiteContractNumber(value, fallback, label, minimum, maximum) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`模型設定 ${label} 不合法`);
  }
  return number;
}

function contractBounds(source, section, defaults, aliases = {}) {
  const sectionPath = section.split('.');
  const minimum = finiteContractNumber(valueAt(source, [
    [...sectionPath, 'min'],
    ...(aliases.minimum || []).map(key => [key]),
  ]), defaults.min, `${section}.min`, 0.05, 20);
  const maximum = finiteContractNumber(valueAt(source, [
    [...sectionPath, 'max'],
    ...(aliases.maximum || []).map(key => [key]),
  ]), defaults.max, `${section}.max`, 0.05, 30);
  if (minimum >= maximum) throw new Error(`模型設定 ${section} 必須 min < max`);
  return { min: minimum, max: maximum };
}

export function normalizeModelConfig(input) {
  if (input == null) return DEFAULT_MODEL_CONFIG;
  if (!plainObject(input)) throw new Error('modelConfig 必須是物件');
  if (input.shrink !== undefined && typeof input.shrink !== 'number' && !plainObject(input.shrink)) {
    throw new Error('模型設定 shrink 必須是數字或物件');
  }

  const baselineFull = contractBounds(
    input,
    'baselineBounds.full',
    DEFAULT_MODEL_CONFIG.baselineBounds.full,
    { minimum: ['baselineMin', 'baselineFullMin'], maximum: ['baselineMax', 'baselineFullMax'] },
  );
  const baselineFirst5 = contractBounds(
    input,
    'baselineBounds.first5',
    DEFAULT_MODEL_CONFIG.baselineBounds.first5,
    { minimum: ['baselineFirst5Min'], maximum: ['baselineFirst5Max'] },
  );
  const scoreFull = contractBounds(
    input,
    'scoreClamps.full',
    DEFAULT_MODEL_CONFIG.scoreClamps.full,
    { minimum: ['fullMin', 'fullRunMin'], maximum: ['fullMax', 'fullRunMax'] },
  );
  const scoreFirst5 = contractBounds(
    input,
    'scoreClamps.first5',
    DEFAULT_MODEL_CONFIG.scoreClamps.first5,
    { minimum: ['first5Min', 'first5RunMin'], maximum: ['first5Max', 'first5RunMax'] },
  );

  const homeFull = finiteContractNumber(valueAt(input, [
    ['homeCoefficient', 'full'],
    ['homeAdvantage', 'full'],
    ['homeCoefficientFull'],
    ['homeAdvantageFull'],
  ]), DEFAULT_MODEL_CONFIG.homeCoefficient.full, 'homeCoefficient.full', 0.7, 1.3);
  const homeFirst5 = finiteContractNumber(valueAt(input, [
    ['homeCoefficient', 'first5'],
    ['homeAdvantage', 'first5'],
    ['homeCoefficientFirst5'],
    ['homeCoefficientF5'],
    ['homeAdvantageFirst5'],
    ['homeAdvantageF5'],
  ]), DEFAULT_MODEL_CONFIG.homeCoefficient.first5, 'homeCoefficient.first5', 0.7, 1.3);
  const shrinkFull = finiteContractNumber(valueAt(input, [
    ['shrink', 'full'],
    ...(typeof input.shrink === 'number' ? [['shrink']] : []),
    ['shrinkFull'],
  ]), DEFAULT_MODEL_CONFIG.shrink.full, 'shrink.full', 0, 1);
  const shrinkFirst5 = finiteContractNumber(valueAt(input, [
    ['shrink', 'first5'],
    ...(typeof input.shrink === 'number' ? [['shrink']] : []),
    ['shrinkFirst5'],
    ['shrinkF5'],
  ]), DEFAULT_MODEL_CONFIG.shrink.first5, 'shrink.first5', 0, 1);
  const extraInningsLimit = finiteContractNumber(
    valueAt(input, [['extraInningsLimit']]),
    DEFAULT_MODEL_CONFIG.extraInningsLimit,
    'extraInningsLimit',
    0,
    30,
  );
  if (!Number.isInteger(extraInningsLimit)) throw new Error('模型設定 extraInningsLimit 必須是整數');
  const allowDrawValue = valueAt(input, [['allowDraw']]);
  if (allowDrawValue !== undefined && typeof allowDrawValue !== 'boolean') {
    throw new Error('模型設定 allowDraw 必須是布林值');
  }

  return {
    baselineBounds: { full: baselineFull, first5: baselineFirst5 },
    scoreClamps: { full: scoreFull, first5: scoreFirst5 },
    homeCoefficient: { full: homeFull, first5: homeFirst5 },
    shrink: { full: shrinkFull, first5: shrinkFirst5 },
    extraInningsLimit,
    allowDraw: allowDrawValue ?? DEFAULT_MODEL_CONFIG.allowDraw,
  };
}

function contextLeagueId(context) {
  const value = context?.leagueId
    ?? context?.game?.leagueId
    ?? context?.league?.id
    ?? context?.provider?.leagueId
    ?? context?.provider?.id;
  return String(value || 'MLB').trim().toUpperCase() || 'MLB';
}

function normalizeAnalysisMode(value) {
  const mode = String(value || '').trim().toUpperCase();
  if (!mode) return FORMAL_ANALYSIS_MODE;
  if (mode === SHADOW_ANALYSIS_MODE || mode === 'SHADOW' || mode === 'EXPERIMENTAL') return SHADOW_ANALYSIS_MODE;
  if (mode === FORMAL_ANALYSIS_MODE || mode === 'ACTIVE' || mode === 'PRODUCTION') return FORMAL_ANALYSIS_MODE;
  throw new Error(`未知 analysisMode：${value}`);
}

function truthyExecutionClaim(context) {
  return context?.betEligible === true
    || context?.executable === true
    || context?.modelConfig?.betEligible === true
    || context?.modelConfig?.executable === true
    || context?.provider?.betEligible === true
    || context?.provider?.executable === true;
}

export function assertAnalysisModeContract(context = {}) {
  const leagueId = contextLeagueId(context);
  const explicitAnalysisMode = context?.analysisMode != null;
  const analysisMode = normalizeAnalysisMode(context?.analysisMode);
  const hasModelConfig = plainObject(context?.modelConfig) && Object.keys(context.modelConfig).length > 0;
  const isAsian = ASIAN_LEAGUES.has(leagueId);

  if (isAsian && analysisMode !== SHADOW_ANALYSIS_MODE) {
    throw new Error(`${leagueId} 尚未取得正式校準，只允許 ${SHADOW_ANALYSIS_MODE}`);
  }
  if ((isAsian || analysisMode === SHADOW_ANALYSIS_MODE) && !hasModelConfig) {
    throw new Error(`${leagueId} shadow 分析缺少 modelConfig`);
  }
  if (analysisMode === SHADOW_ANALYSIS_MODE && truthyExecutionClaim(context)) {
    throw new Error(`${leagueId} shadow 分析不得宣告 betEligible 或 executable`);
  }
  if (context?.modelConfig?.analysisMode != null
    && normalizeAnalysisMode(context.modelConfig.analysisMode) !== analysisMode) {
    throw new Error(`${leagueId} modelConfig.analysisMode 與 provider analysisMode 不一致`);
  }

  const modelConfig = normalizeModelConfig(context?.modelConfig);
  const modelVersion = String(context?.modelVersion || MODEL_VERSION).trim();
  const rulesVersion = String(context?.rulesVersion || RULES_VERSION).trim();
  if (!modelVersion || !rulesVersion) throw new Error(`${leagueId} 模型或規則版本缺失`);
  const customContract = hasModelConfig
    || explicitAnalysisMode
    || context?.modelVersion != null
    || context?.rulesVersion != null
    || isAsian;
  const modelContract = customContract ? {
    leagueId,
    analysisMode,
    modelVersion,
    rulesVersion,
    modelConfig,
  } : null;
  return {
    leagueId,
    isAsian,
    analysisMode,
    shadow: analysisMode === SHADOW_ANALYSIS_MODE,
    modelConfig,
    modelVersion,
    rulesVersion,
    modelContract,
    modelContractHash: modelContract ? sha256(modelContract) : null,
  };
}

function shadowLockedContext(value) {
  if (!plainObject(value)) return value;
  return {
    ...value,
    analysisMode: SHADOW_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
  };
}

function shadowLockedResult(row) {
  const diagnosticTag = row?.diagnosticTag || row?.tag || null;
  return {
    ...row,
    analysisMode: SHADOW_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    scoreType: SHADOW_SCORE_TYPE,
    diagnosticTag,
    tag: SHADOW_RESULT_TAG,
    unitSuggestion: null,
    recommendedUnit: null,
    portfolioRole: '',
    portfolioUnit: null,
    unitStatus: 'SHADOW｜不可下注',
    shadowSafety: {
      enforced: true,
      reason: '聯盟模型尚未完成跨球季 Out-of-sample 正式校準',
    },
  };
}

export function enforceShadowAnalysisSafety(analysis, context = {}) {
  if (!plainObject(analysis)) return analysis;
  const contractContext = Object.keys(context || {}).length
    ? context
    : {
      analysisMode: analysis.analysisMode,
      leagueId: analysis.leagueId,
      modelConfig: analysis.modelConfig,
      modelVersion: analysis.modelVersion,
      rulesVersion: analysis.rulesVersion,
    };
  const contract = assertAnalysisModeContract(contractContext);
  if (!contract.shadow) return analysis;

  const warnings = [...new Set([
    ...(Array.isArray(analysis.warnings) ? analysis.warnings : []),
    'SHADOW｜僅供模型診斷與評分驗證｜不可下注',
  ])];
  const nestedAnalysis = plainObject(analysis.analysis)
    ? enforceShadowAnalysisSafety(analysis.analysis, contractContext)
    : analysis.analysis;
  const repriceSnapshot = plainObject(analysis.repriceSnapshot)
    ? {
      ...analysis.repriceSnapshot,
      analysisMode: SHADOW_ANALYSIS_MODE,
      executable: false,
      betEligible: false,
      portfolio: [],
      context: shadowLockedContext(analysis.repriceSnapshot.context),
      frozenContext: shadowLockedContext(analysis.repriceSnapshot.frozenContext),
      results: Array.isArray(analysis.repriceSnapshot.results)
        ? analysis.repriceSnapshot.results.map(shadowLockedResult)
        : analysis.repriceSnapshot.results,
    }
    : analysis.repriceSnapshot;
  return {
    ...analysis,
    leagueId: contract.leagueId,
    analysisMode: SHADOW_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    scoreType: SHADOW_SCORE_TYPE,
    tag: SHADOW_RESULT_TAG,
    unitSuggestion: null,
    portfolio: [],
    context: shadowLockedContext(analysis.context),
    frozenContext: shadowLockedContext(analysis.frozenContext),
    ...(nestedAnalysis === undefined ? {} : { analysis: nestedAnalysis }),
    ...(repriceSnapshot === undefined ? {} : { repriceSnapshot }),
    warnings,
    shadowSafety: {
      enforced: true,
      analysisMode: SHADOW_ANALYSIS_MODE,
      leagueId: contract.leagueId,
      modelContractHash: contract.modelContractHash,
      reason: '聯盟模型尚未完成跨球季 Out-of-sample 正式校準',
    },
    results: (Array.isArray(analysis.results) ? analysis.results : []).map(shadowLockedResult),
  };
}

export const enforceAnalysisModeSafety = enforceShadowAnalysisSafety;

function hashString(value) {
  let hash = 2166136261;
  for (const character of String(value || '')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function normalSample(random) {
  const first = Math.max(random(), 1e-12);
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function poissonSample(lambda, random) {
  const rate = clamp(safe(lambda, 0), 0, 9);
  if (rate <= 0) return 0;
  const limit = Math.exp(-rate);
  let product = 1;
  let count = 0;
  do {
    count += 1;
    product *= Math.max(random(), 1e-12);
  } while (product > limit && count < 35);
  return count - 1;
}

function blend(first, second, secondWeight = 0.3, fallback = 1) {
  const left = safe(first, fallback);
  const right = safe(second, left);
  return left * (1 - secondWeight) + right * secondWeight;
}

function sampleWeight(sample, target, minimum = 0.05, maximum = 0.30) {
  return clamp(safe(sample, 0) / target, minimum, maximum);
}

function ratio(value, baseline, minimum = 0.75, maximum = 1.30) {
  return clamp(safe(value, baseline) / baseline, minimum, maximum);
}

function geometricBlend(components) {
  let totalWeight = 0;
  let totalLog = 0;
  for (const [value, weight] of components) {
    if (!Number.isFinite(Number(value)) || weight <= 0) continue;
    totalWeight += weight;
    totalLog += Math.log(clamp(Number(value), 0.15, 6)) * weight;
  }
  return totalWeight > 0 ? clamp(Math.exp(totalLog / totalWeight), 0.55, 1.75) : 1;
}

function expertResidual(expert, key) {
  const row = expert?.adjustments?.[key];
  return row && typeof row === 'object' ? row : {};
}

function combinedUncertainty(base, extra) {
  return Math.sqrt(Math.max(0, safe(base, 0)) ** 2 + clamp(safe(extra, 0), 0, 0.07) ** 2);
}

function scenarioLevelRows(source) {
  const value = source && typeof source === 'object' ? source : {};
  const rows = [
    { z: -1, weight: clamp(safe(value.low, 0.20), 0.05, 0.70) },
    { z: 0, weight: clamp(safe(value.central, 0.60), 0.10, 0.90) },
    { z: 1, weight: clamp(safe(value.high, 0.20), 0.05, 0.70) },
  ];
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  return rows.map(row => ({ ...row, weight: total > 0 ? row.weight / total : 1 / 3 }));
}

function offenseProfile(team, opposingStarter, adjustment = {}) {
  const season = team?.seasonHitting || {};
  const recent = team?.recentHitting || {};
  const recentWeight = sampleWeight(recent.gamesPlayed, 45, 0.08, 0.28);
  const runs = blend(season.runsPerGame, recent.runsPerGame, recentWeight, 4.35);
  const ops = blend(season.ops, recent.ops, recentWeight * 0.9, 0.72);
  const iso = blend(season.iso, recent.iso, recentWeight * 0.75, 0.15);
  const kRate = blend(season.kRate, recent.kRate, recentWeight * 0.65, 0.225);
  const bbRate = blend(season.bbRate, recent.bbRate, recentWeight * 0.65, 0.085);
  const split = opposingStarter?.throws === 'L' ? team?.vsLeft : team?.vsRight;
  const splitWeight = split?.available ? 0.13 : 0;
  const lineupIndex = clamp(safe(team?.lineup?.offensiveIndex, 1), 0.86, 1.14);
  const runningIndex = clamp(safe(team?.baserunning?.runIndex, 1), 0.96, 1.04);
  const injuryPenalty = Math.min(0.045, safe(team?.injuryImpact, 0));

  let factor = geometricBlend([
    [ratio(runs, 4.35, 0.76, 1.27), 0.32],
    [ratio(ops, 0.72, 0.80, 1.23), 0.27],
    [ratio(iso, 0.15, 0.80, 1.23), 0.09],
    [Math.exp(-(kRate - 0.225) * 0.9), 0.07],
    [Math.exp((bbRate - 0.085) * 0.8), 0.06],
    [ratio(split?.ops, 0.72, 0.84, 1.18), splitWeight],
    [lineupIndex, 0.15],
    [runningIndex, 0.04],
  ]) * (1 - injuryPenalty);
  factor *= clamp(safe(adjustment.multiplier, 1), 0.95, 1.05);

  const lineupStatus = team?.lineup?.official ? '已確認' : team?.lineup?.projected ? '預估' : '未知';
  const lineupUncertainty = team?.lineup?.official ? 0.035 : team?.lineup?.projected ? 0.075 : 0.12;
  const splitUncertainty = split?.available ? 0.025 : 0.055;
  const recentUncertainty = recent.gamesPlayed >= 8 ? 0.025 : 0.055;

  return {
    factor: clamp(factor, 0.76, 1.27),
    uncertainty: combinedUncertainty(Math.sqrt(lineupUncertainty ** 2 + splitUncertainty ** 2 + recentUncertainty ** 2), adjustment.uncertaintyAdd),
    status: lineupStatus,
    inputs: { runs, ops, iso, kRate, bbRate, splitOps: split?.available ? split.ops : null, lineupIndex, runningIndex, injuryPenalty, expertResidual: clamp(safe(adjustment.multiplier, 1), 0.95, 1.05), expertReason: adjustment.reason || '' },
  };
}

function starterProfile(starter, adjustment = {}) {
  const expertMultiplier = clamp(safe(adjustment.multiplier ?? adjustment.runMultiplier, 1), 0.94, 1.06);
  const inningsDelta = clamp(safe(adjustment.inningsDelta, 0), -0.65, 0.65);
  if (!starter?.available) {
    return {
      factor: expertMultiplier,
      expectedInnings: clamp(4.8 + inningsDelta, 3.2, 7.2),
      uncertainty: combinedUncertainty(0.17, adjustment.uncertaintyAdd),
      status: '未知',
      inputs: { expertResidual: expertMultiplier, expertInningsDelta: inningsDelta, expertReason: adjustment.reason || '' },
    };
  }
  const season = starter.season || {};
  const recent = starter.recent || {};
  const recentWeight = sampleWeight(recent.inningsPitched, 55, 0.06, 0.28);
  const era = blend(season.era, recent.era, recentWeight, 4.2);
  const fip = blend(season.fip, recent.fip, recentWeight * 0.8, era);
  const whip = blend(season.whip, recent.whip, recentWeight, 1.3);
  const kMinusBB = blend(season.kMinusBB, recent.kMinusBB, recentWeight * 0.8, 0.14);
  const hrPer9 = blend(season.hrPer9, recent.hrPer9, recentWeight * 0.7, 1.15);
  const pitchQuality = clamp(safe(starter?.pitchQuality?.runFactor, 1), 0.88, 1.12);

  let factor = geometricBlend([
    [ratio(era, 4.2, 0.70, 1.42), 0.29],
    [ratio(fip, 4.2, 0.72, 1.38), 0.25],
    [ratio(whip, 1.3, 0.76, 1.32), 0.19],
    [Math.exp(-(kMinusBB - 0.14) * 1.9), 0.16],
    [ratio(hrPer9, 1.15, 0.72, 1.42), 0.07],
    [pitchQuality, 0.04],
  ]);
  factor *= expertMultiplier;

  const gamesStarted = Math.max(1, safe(season.gamesStarted, safe(recent.gamesStarted, 1)));
  const seasonLength = safe(season.inningsPitched, 0) / gamesStarted;
  const recentStarts = Math.max(1, safe(recent.gamesStarted, 0));
  const recentLength = recentStarts > 0 ? safe(recent.inningsPitched, 0) / recentStarts : seasonLength;
  const expectedInnings = clamp(safe(starter.expectedInnings, blend(seasonLength, recentLength, 0.35, 5.2)) + inningsDelta, 3.2, 7.2);
  const sample = safe(season.inningsPitched, 0);
  const sampleUncertainty = sample >= 100 ? 0.045 : sample >= 50 ? 0.065 : sample >= 20 ? 0.09 : 0.13;
  const arsenalUncertainty = starter?.pitchQuality?.available ? 0.025 : 0.055;
  const confirmationUncertainty = starter?.confirmed === false ? 0.055 : 0.015;

  return {
    factor: clamp(factor, 0.68, 1.44),
    expectedInnings,
    uncertainty: combinedUncertainty(Math.sqrt(sampleUncertainty ** 2 + arsenalUncertainty ** 2 + confirmationUncertainty ** 2), adjustment.uncertaintyAdd),
    status: starter?.confirmed === false ? '預估' : '已確認',
    inputs: { era, fip, whip, kMinusBB, hrPer9, pitchQuality, expectedInnings, expertResidual: expertMultiplier, expertInningsDelta: inningsDelta, expertReason: adjustment.reason || '' },
  };
}

function bullpenProfile(team, adjustment = {}) {
  const recent = team?.recentPitching || {};
  const recentWeight = sampleWeight(recent.inningsPitched, 55, 0.08, 0.24);
  const recentEra = blend(4.2, recent.era, recentWeight, 4.2);
  const recentWhip = blend(1.3, recent.whip, recentWeight, 1.3);
  const fatigue = clamp(safe(team?.bullpen?.fatigueIndex, 0.2), 0, 1);
  const leverageAvailability = clamp(safe(team?.bullpen?.highLeverageAvailability, 0.75), 0, 1);
  const suppliedQuality = Number(team?.bullpen?.qualityFactor);
  const qualityFactor = Number.isFinite(suppliedQuality)
    ? clamp(suppliedQuality, 0.76, 1.30)
    : geometricBlend([[ratio(recentEra, 4.2, 0.82, 1.22), 0.58], [ratio(recentWhip, 1.3, 0.86, 1.18), 0.42]]);
  let factor = geometricBlend([
    [qualityFactor, 0.56],
    [ratio(recentEra, 4.2, 0.84, 1.20), 0.12],
    [1 + fatigue * 0.17, 0.21],
    [1 + (1 - leverageAvailability) * 0.13, 0.11],
  ]);
  factor *= clamp(safe(adjustment.multiplier, 1), 0.95, 1.05);
  const usageKnown = Boolean(team?.bullpen?.usageAvailable);
  return {
    factor: clamp(factor, 0.75, 1.36),
    uncertainty: combinedUncertainty(usageKnown ? 0.055 + fatigue * 0.035 : 0.105, adjustment.uncertaintyAdd),
    status: usageKnown ? '已確認' : '預估',
    inputs: { recentEra, recentWhip, qualityFactor, fatigue, leverageAvailability, expertResidual: clamp(safe(adjustment.multiplier, 1), 0.95, 1.05), expertReason: adjustment.reason || '' },
  };
}

function defenseProfile(team) {
  const fielding = team?.defense || {};
  if (!fielding.available) return { factor: 1, uncertainty: 0.035, status: '未知' };
  const fieldingPercentage = safe(fielding.fieldingPercentage, 0.985);
  const errorsPerGame = safe(fielding.errorsPerGame, 0.55);
  const factor = clamp(1 - (fieldingPercentage - 0.985) * 3.5 + (errorsPerGame - 0.55) * 0.018, 0.96, 1.04);
  return { factor, uncertainty: 0.018, status: '已確認' };
}

function restProfile(team) {
  const rest = team?.rest || {};
  const days = safe(rest.days, 1);
  const travelKm = safe(rest.travelKm, 0);
  const extra = rest.previousExtraInnings ? 1 : 0;
  const dayNight = rest.dayNightTransition ? 1 : 0;
  const factor = clamp(1 + (days >= 2 ? 0.008 : 0) - (days <= 0 ? 0.018 : 0) - Math.min(travelKm / 120000, 0.02) - extra * 0.008 - dayNight * 0.005, 0.955, 1.025);
  return { factor, uncertainty: rest.available === false ? 0.025 : 0.012, status: rest.available === false ? '預估' : '已確認' };
}

function environmentProfile(context, adjustment = {}) {
  const park = clamp(safe(context?.park?.runFactor, 1), 0.86, 1.20);
  const weather = context?.weather || {};
  const temperature = safe(weather.temperature, 21);
  const roof = context?.park?.roof || 'unknown';
  const closedProbability = clamp(safe(weather.roofClosedProbability, roof === 'dome' ? 1 : roof === 'open' ? 0 : 0.35), 0, 1);
  const openTemperatureFactor = clamp(1 + (temperature - 21) * 0.0024, 0.94, 1.06);
  const temperatureFactor = closedProbability * 1 + (1 - closedProbability) * openTemperatureFactor;
  let factor = clamp(park * temperatureFactor, 0.86, 1.20);
  factor *= clamp(safe(adjustment.multiplier, 1), 0.97, 1.03);
  const windSpeed = safe(weather.windSpeed, 0);
  const precipitation = safe(weather.precipitationProbability, 0);
  const weatherKnown = Boolean(weather.available);
  const roofUncertainty = roof === 'retractable' && !weather.roofConfirmed ? 0.045 : roof === 'unknown' ? 0.04 : 0.015;
  const windUncertainty = Math.min(0.065, windSpeed / 450);
  const rainUncertainty = Math.min(0.04, precipitation / 2500);
  const baseUncertainty = weatherKnown ? Math.sqrt(0.02 ** 2 + roofUncertainty ** 2 + windUncertainty ** 2 + rainUncertainty ** 2) : 0.11;
  return {
    factor: clamp(factor, 0.84, 1.22),
    uncertainty: combinedUncertainty(baseUncertainty, adjustment.uncertaintyAdd),
    status: weatherKnown ? (weather.roofConfirmed || roof === 'open' || roof === 'dome' ? '已確認' : '預估') : '未知',
    inputs: { park, temperature, windSpeed, precipitation, closedProbability, expertResidual: clamp(safe(adjustment.multiplier, 1), 0.97, 1.03), expertReason: adjustment.reason || '' },
  };
}

function gameContextProfile(context, modelConfig = DEFAULT_MODEL_CONFIG) {
  const expert = context?.expertAssessment?.assessment || {};
  const awayStarter = starterProfile(context?.away?.starter, expertResidual(expert, 'awayStarter'));
  const homeStarter = starterProfile(context?.home?.starter, expertResidual(expert, 'homeStarter'));
  const awayOffense = offenseProfile(context?.away, context?.home?.starter, expertResidual(expert, 'awayOffense'));
  const homeOffense = offenseProfile(context?.home, context?.away?.starter, expertResidual(expert, 'homeOffense'));
  const awayBullpen = bullpenProfile(context?.away, expertResidual(expert, 'awayBullpen'));
  const homeBullpen = bullpenProfile(context?.home, expertResidual(expert, 'homeBullpen'));
  const awayDefense = defenseProfile(context?.away);
  const homeDefense = defenseProfile(context?.home);
  const awayRest = restProfile(context?.away);
  const homeRest = restProfile(context?.home);
  const environment = environmentProfile(context, expertResidual(expert, 'environment'));
  const umpireKnown = Boolean(context?.umpire?.name || (typeof context?.umpire === 'string' && context.umpire));
  const catcherKnown = Boolean(context?.away?.lineup?.catcher && context?.home?.lineup?.catcher);
  const umpireCatcherUncertainty = Math.sqrt((umpireKnown ? 0.018 : 0.035) ** 2 + (catcherKnown ? 0.015 : 0.03) ** 2);

  const baseline = clamp(
    safe(context?.league?.runsPerTeamGame, 4.35),
    modelConfig.baselineBounds.full.min,
    modelConfig.baselineBounds.full.max,
  );
  const awayStarterShareFull = clamp(homeStarter.expectedInnings / 9, 0.35, 0.80);
  const homeStarterShareFull = clamp(awayStarter.expectedInnings / 9, 0.35, 0.80);
  const awayStarterShareF5 = clamp(homeStarter.expectedInnings / 5, 0.55, 1);
  const homeStarterShareF5 = clamp(awayStarter.expectedInnings / 5, 0.55, 1);

  const awayPitchFull = geometricBlend([[homeStarter.factor, awayStarterShareFull], [homeBullpen.factor, 1 - awayStarterShareFull]]);
  const homePitchFull = geometricBlend([[awayStarter.factor, homeStarterShareFull], [awayBullpen.factor, 1 - homeStarterShareFull]]);
  const awayPitchF5 = geometricBlend([[homeStarter.factor, awayStarterShareF5], [homeBullpen.factor, 1 - awayStarterShareF5]]);
  const homePitchF5 = geometricBlend([[awayStarter.factor, homeStarterShareF5], [awayBullpen.factor, 1 - homeStarterShareF5]]);

  const homeAdvantageFull = modelConfig.homeCoefficient.full;
  const homeAdvantageF5 = modelConfig.homeCoefficient.first5;
  const shrinkFull = modelConfig.shrink.full;
  const shrinkFirst5 = modelConfig.shrink.first5;
  const awayRawFull = baseline * awayOffense.factor * awayPitchFull * homeDefense.factor * awayRest.factor * environment.factor;
  const homeRawFull = baseline * homeOffense.factor * homePitchFull * awayDefense.factor * homeRest.factor * environment.factor * homeAdvantageFull;
  const awayRawF5 = baseline * (5 / 9) * awayOffense.factor * awayPitchF5 * homeDefense.factor * awayRest.factor * environment.factor;
  const homeRawF5 = baseline * (5 / 9) * homeOffense.factor * homePitchF5 * awayDefense.factor * homeRest.factor * environment.factor * homeAdvantageF5;

  const full = {
    away: clamp(
      baseline + (awayRawFull - baseline) * shrinkFull,
      modelConfig.scoreClamps.full.min,
      modelConfig.scoreClamps.full.max,
    ),
    home: clamp(
      baseline + (homeRawFull - baseline) * shrinkFull,
      modelConfig.scoreClamps.full.min,
      modelConfig.scoreClamps.full.max,
    ),
  };
  const first5Baseline = clamp(
    baseline * (5 / 9),
    modelConfig.baselineBounds.first5.min,
    modelConfig.baselineBounds.first5.max,
  );
  const first5 = {
    away: clamp(
      first5Baseline + (awayRawF5 - first5Baseline) * shrinkFirst5,
      modelConfig.scoreClamps.first5.min,
      modelConfig.scoreClamps.first5.max,
    ),
    home: clamp(
      first5Baseline + (homeRawF5 - first5Baseline) * shrinkFirst5,
      modelConfig.scoreClamps.first5.min,
      modelConfig.scoreClamps.first5.max,
    ),
  };

  const awayEarlyUncertainty = Math.sqrt(awayOffense.uncertainty ** 2 + homeStarter.uncertainty ** 2 + environment.uncertainty ** 2 + umpireCatcherUncertainty ** 2);
  const homeEarlyUncertainty = Math.sqrt(homeOffense.uncertainty ** 2 + awayStarter.uncertainty ** 2 + environment.uncertainty ** 2 + umpireCatcherUncertainty ** 2);
  const awayLateUncertainty = Math.sqrt(awayOffense.uncertainty ** 2 + homeBullpen.uncertainty ** 2 + environment.uncertainty ** 2 + 0.035 ** 2);
  const homeLateUncertainty = Math.sqrt(homeOffense.uncertainty ** 2 + awayBullpen.uncertainty ** 2 + environment.uncertainty ** 2 + 0.035 ** 2);

  const statuses = {
    awayStarter: awayStarter.status,
    homeStarter: homeStarter.status,
    awayLineup: awayOffense.status,
    homeLineup: homeOffense.status,
    awayBullpen: awayBullpen.status,
    homeBullpen: homeBullpen.status,
    weatherRoof: environment.status,
    umpire: umpireKnown ? '已確認' : '未知',
    catcher: catcherKnown ? '已確認' : (context?.away?.lineup?.projected || context?.home?.lineup?.projected ? '預估' : '未知'),
  };
  const statusValues = Object.values(statuses);
  const confirmed = statusValues.filter(value => value === '已確認').length;
  const estimated = statusValues.filter(value => value === '預估').length;
  const sourceQuality = clamp(0.50 + ((confirmed + estimated * 0.65) / statusValues.length) * 0.45, 0.50, 0.96);
  const expertConfidence = clamp(safe(expert.contextConfidence, sourceQuality), 0.35, 0.95);
  const quality = clamp(sourceQuality * 0.82 + expertConfidence * 0.18, 0.50, 0.96);

  return {
    full,
    first5,
    earlyUncertainty: { away: clamp(awayEarlyUncertainty, 0.07, 0.25), home: clamp(homeEarlyUncertainty, 0.07, 0.25) },
    lateUncertainty: { away: clamp(awayLateUncertainty, 0.07, 0.25), home: clamp(homeLateUncertainty, 0.07, 0.25) },
    sharedEnvironmentUncertainty: clamp(environment.uncertainty, 0.025, 0.14),
    statuses,
    quality,
    modelErrorFloor: clamp(safe(expert.modelErrorFloor, 0.028), 0.015, 0.060),
    independentEvidenceStrength: clamp(safe(expert.independentEvidenceStrength, 0.32), 0.15, 0.85),
    marketReliance: clamp(safe(expert.marketReliance, 0.72), 0.45, 0.86),
    scenarioProbabilities: expert.scenarioProbabilities || {},
    expertLayerUsed: Boolean(context?.expertAssessment?.used),
    expertModel: context?.expertAssessment?.model || null,
    expertSummary: expert.summary || '',
    expertAudit: expert.audit || { confirmed: [], estimated: [], unknown: [], blocking: [], unmodeled: [] },
    components: {
      awayOffense, homeOffense, awayStarter, homeStarter, awayBullpen, homeBullpen,
      awayDefense, homeDefense, awayRest, homeRest, environment,
    },
  };
}

export function estimateRuns(context, first5 = false) {
  const contract = assertAnalysisModeContract(context);
  const profile = gameContextProfile(context, contract.modelConfig);
  return first5 ? profile.first5 : profile.full;
}

function scenarioGrid(profile) {
  const awayLevels = scenarioLevelRows(profile.scenarioProbabilities?.away);
  const homeLevels = scenarioLevelRows(profile.scenarioProbabilities?.home);
  const environmentLevels = scenarioLevelRows(profile.scenarioProbabilities?.environment);
  const scenarios = [];
  let index = 0;
  for (const awayShock of awayLevels) {
    for (const homeShock of homeLevels) {
      for (const environmentShock of environmentLevels) {
        const environmentMultiplier = Math.exp(environmentShock.z * profile.sharedEnvironmentUncertainty);
        const awayEarly = profile.first5.away * Math.exp(awayShock.z * profile.earlyUncertainty.away) * environmentMultiplier;
        const homeEarly = profile.first5.home * Math.exp(homeShock.z * profile.earlyUncertainty.home) * environmentMultiplier;
        const awayLateBase = Math.max(0.25, profile.full.away - profile.first5.away);
        const homeLateBase = Math.max(0.25, profile.full.home - profile.first5.home);
        const awayLate = awayLateBase * Math.exp(awayShock.z * profile.lateUncertainty.away) * environmentMultiplier;
        const homeLate = homeLateBase * Math.exp(homeShock.z * profile.lateUncertainty.home) * environmentMultiplier;
        scenarios.push({
          id: `S${String(index + 1).padStart(2, '0')}`,
          weight: awayShock.weight * homeShock.weight * environmentShock.weight,
          shocks: { away: awayShock.z, home: homeShock.z, environment: environmentShock.z },
          means: {
            first5: { away: clamp(awayEarly, 0.55, 5), home: clamp(homeEarly, 0.55, 5) },
            late: { away: clamp(awayLate, 0.20, 4.8), home: clamp(homeLate, 0.20, 4.8) },
          },
        });
        index += 1;
      }
    }
  }
  return scenarios;
}

function addJointScore(map, awayFirst5, homeFirst5, awayRuns, homeRuns, amount = 1) {
  const key = `${Math.min(20, awayFirst5)}:${Math.min(20, homeFirst5)}:${Math.min(25, awayRuns)}:${Math.min(25, homeRuns)}`;
  map.set(key, (map.get(key) || 0) + amount);
}

function mapToJointCells(map, divisor = 1) {
  const cells = [];
  let sum = 0;
  for (const [key, value] of map.entries()) {
    const [awayFirst5, homeFirst5, awayRuns, homeRuns] = key.split(':').map(Number);
    const probability = value / divisor;
    sum += probability;
    cells.push({ awayFirst5, homeFirst5, awayRuns, homeRuns, probability });
  }
  if (sum <= 0) return [];
  return cells.map(cell => ({ ...cell, probability: cell.probability / sum }));
}

function simulateScenario(scenario, simulations, seed, modelConfig = DEFAULT_MODEL_CONFIG) {
  const random = seededRandom(seed);
  const joint = new Map();
  const awayEarlyRate = scenario.means.first5.away / 5;
  const homeEarlyRate = scenario.means.first5.home / 5;
  const awayLateRate = scenario.means.late.away / 4;
  const homeLateRate = scenario.means.late.home / 4;

  for (let simulation = 0; simulation < simulations; simulation += 1) {
    const sharedGameFactor = Math.exp(normalSample(random) * 0.095 - 0.5 * 0.095 ** 2);
    const awayGameFactor = Math.exp(normalSample(random) * 0.075 - 0.5 * 0.075 ** 2);
    const homeGameFactor = Math.exp(normalSample(random) * 0.075 - 0.5 * 0.075 ** 2);
    let awayRuns = 0;
    let homeRuns = 0;

    for (let inning = 1; inning <= 5; inning += 1) {
      awayRuns += poissonSample(awayEarlyRate * sharedGameFactor * awayGameFactor, random);
      homeRuns += poissonSample(homeEarlyRate * sharedGameFactor * homeGameFactor, random);
    }
    const awayFirst5 = awayRuns;
    const homeFirst5 = homeRuns;

    for (let inning = 6; inning <= 8; inning += 1) {
      awayRuns += poissonSample(awayLateRate * sharedGameFactor * awayGameFactor, random);
      homeRuns += poissonSample(homeLateRate * sharedGameFactor * homeGameFactor, random);
    }

    awayRuns += poissonSample(awayLateRate * sharedGameFactor * awayGameFactor, random);
    if (homeRuns <= awayRuns) {
      const bottomRuns = poissonSample(homeLateRate * sharedGameFactor * homeGameFactor, random);
      const needed = awayRuns - homeRuns + 1;
      if (bottomRuns >= needed) {
        homeRuns += needed + (bottomRuns > needed && random() < 0.18 ? bottomRuns - needed : 0);
      } else {
        homeRuns += bottomRuns;
      }
    }

    let extraInning = 0;
    while (awayRuns === homeRuns && extraInning < modelConfig.extraInningsLimit) {
      extraInning += 1;
      awayRuns += poissonSample((awayLateRate * 1.32 + 0.16) * sharedGameFactor * awayGameFactor, random);
      const homeRunsThisInning = poissonSample((homeLateRate * 1.32 + 0.16) * sharedGameFactor * homeGameFactor, random);
      const needed = awayRuns - homeRuns + 1;
      if (homeRunsThisInning >= needed) homeRuns += needed;
      else homeRuns += homeRunsThisInning;
    }
    if (awayRuns === homeRuns && !modelConfig.allowDraw) {
      if (random() < 0.48) awayRuns += 1;
      else homeRuns += 1;
    }

    addJointScore(joint, awayFirst5, homeFirst5, awayRuns, homeRuns);
  }

  return mapToJointCells(joint, simulations);
}

function combinedJoint(scenarios) {
  const map = new Map();
  for (const scenario of scenarios) {
    for (const cell of scenario.joint) {
      addJointScore(map, cell.awayFirst5, cell.homeFirst5, cell.awayRuns, cell.homeRuns, cell.probability * scenario.weight);
    }
  }
  return mapToJointCells(map, 1);
}

function drawProbability(jointCells) {
  return (jointCells || [])
    .filter(cell => Number(cell.awayRuns) === Number(cell.homeRuns))
    .reduce((sum, cell) => sum + safe(cell.probability, 0), 0);
}

function distributionForMarket(jointCells, market) {
  const first5 = market.includes('上半');
  return jointCells.map(cell => ({
    awayRuns: first5 ? cell.awayFirst5 : cell.awayRuns,
    homeRuns: first5 ? cell.homeFirst5 : cell.homeRuns,
    probability: cell.probability,
  }));
}

function summarizeDistribution({ cells, pick, water, context, rebateRate }) {
  const parsed = parseTaiwanLine(pick);
  const decimals = {
    fullWin: new Decimal(0),
    partialWin: new Decimal(0),
    push: new Decimal(0),
    partialLoss: new Decimal(0),
    fullLoss: new Decimal(0),
    mixedWinLoss: new Decimal(0),
    mixedNeutral: new Decimal(0),
    equivalentWin: new Decimal(0),
    equivalentLoss: new Decimal(0),
    coverage: new Decimal(0),
    directEV: new Decimal(0),
    exactLineProbability: new Decimal(0),
  };
  const outcomeBuckets = new Map();

  for (const cell of cells || []) {
    const probability = new Decimal(safe(cell.probability, 0));
    if (probability.lte(0)) continue;
    const settlement = outcomeSettlementForScore(parsed, cell.awayRuns, cell.homeRuns, context.game.away, context.game.home);
    if (!settlement) continue;
    const calculation = calculateProfit({ stake: 1, water, settlement, rebateRate });
    const win = new Decimal(settlement.winFraction || 0);
    const loss = new Decimal(settlement.lossFraction || 0);
    const push = new Decimal(settlement.pushFraction || 0);
    const net = win.minus(loss);

    decimals.coverage = decimals.coverage.plus(probability);
    decimals.equivalentWin = decimals.equivalentWin.plus(probability.mul(win));
    decimals.equivalentLoss = decimals.equivalentLoss.plus(probability.mul(loss));
    decimals.directEV = decimals.directEV.plus(probability.mul(calculation.profit));

    if (win.eq(1) && loss.eq(0)) decimals.fullWin = decimals.fullWin.plus(probability);
    else if (loss.eq(1) && win.eq(0)) decimals.fullLoss = decimals.fullLoss.plus(probability);
    else if (win.eq(0) && loss.eq(0)) decimals.push = decimals.push.plus(probability);
    else if (win.gt(0) && loss.gt(0)) {
      decimals.mixedWinLoss = decimals.mixedWinLoss.plus(probability);
      if (net.gt(0)) decimals.partialWin = decimals.partialWin.plus(probability);
      else if (net.lt(0)) decimals.partialLoss = decimals.partialLoss.plus(probability);
      else decimals.mixedNeutral = decimals.mixedNeutral.plus(probability);
    } else if (win.gt(0)) decimals.partialWin = decimals.partialWin.plus(probability);
    else if (loss.gt(0)) decimals.partialLoss = decimals.partialLoss.plus(probability);
    else decimals.push = decimals.push.plus(probability);

    if ((settlement.legs || []).some(leg => leg.exactLine)) {
      decimals.exactLineProbability = decimals.exactLineProbability.plus(probability);
    }

    const signature = (settlement.legs || []).map(leg => [
      Number(leg.allocation || 0).toFixed(12),
      Number(leg.winShare || 0).toFixed(12),
      Number(leg.lossShare || 0).toFixed(12),
      Number(leg.pushShare || 0).toFixed(12),
    ].join(':')).join('|');
    const bucket = outcomeBuckets.get(signature) || {
      signature,
      probability: new Decimal(0),
      profit: new Decimal(calculation.profit),
      winFraction: win,
      lossFraction: loss,
      pushFraction: push,
    };
    bucket.probability = bucket.probability.plus(probability);
    outcomeBuckets.set(signature, bucket);
  }

  const bucketEV = [...outcomeBuckets.values()].reduce(
    (sum, bucket) => sum.plus(bucket.probability.mul(bucket.profit)),
    new Decimal(0),
  );
  const resolved = decimals.equivalentWin.plus(decimals.equivalentLoss);
  const modelProbability = resolved.gt(0)
    ? decimals.equivalentWin.div(resolved)
    : new Decimal('0.5');
  const fairWater = decimals.equivalentWin.gt(0)
    ? Decimal.max('0.5', Decimal.min('1.5',
      new Decimal(1).minus(rebateRate).mul(decimals.equivalentLoss).div(decimals.equivalentWin).minus(rebateRate),
    ))
    : new Decimal('1.5');
  const categoryCoverage = decimals.fullWin
    .plus(decimals.partialWin)
    .plus(decimals.push)
    .plus(decimals.partialLoss)
    .plus(decimals.fullLoss)
    .plus(decimals.mixedNeutral);

  return {
    fullWin: decimals.fullWin.toNumber(),
    partialWin: decimals.partialWin.toNumber(),
    push: decimals.push.toNumber(),
    partialLoss: decimals.partialLoss.toNumber(),
    fullLoss: decimals.fullLoss.toNumber(),
    mixedWinLoss: decimals.mixedWinLoss.toNumber(),
    mixedNeutral: decimals.mixedNeutral.toNumber(),
    equivalentWin: decimals.equivalentWin.toNumber(),
    equivalentLoss: decimals.equivalentLoss.toNumber(),
    coverage: decimals.coverage.toNumber(),
    categoryCoverage: categoryCoverage.toNumber(),
    ev: decimals.directEV.toNumber(),
    evFromBuckets: bucketEV.toNumber(),
    evDoubleCheckError: decimals.directEV.minus(bucketEV).abs().toNumber(),
    exactLineProbability: decimals.exactLineProbability.toNumber(),
    modelProbability: modelProbability.toNumber(),
    fairWater: fairWater.toNumber(),
    outcomeBuckets: [...outcomeBuckets.values()].map(bucket => ({
      signature: bucket.signature,
      probability: bucket.probability.toNumber(),
      profit: bucket.profit.toNumber(),
      winFraction: bucket.winFraction.toNumber(),
      lossFraction: bucket.lossFraction.toNumber(),
      pushFraction: bucket.pushFraction.toNumber(),
    })),
  };
}

function normalizedWeights(rows) {
  const total = rows.reduce((sum, row) => sum + row.weight, 0);
  return rows.map(row => ({ ...row, weight: total > 0 ? row.weight / total : 0 }));
}

function robustWeightSets(scenarios) {
  const make = (id, description, multiplier) => ({
    id,
    description,
    rows: normalizedWeights(scenarios.map(scenario => ({
      id: scenario.id,
      weight: scenario.weight * Math.max(0.08, multiplier(scenario)),
    }))),
  });
  return [
    make('central', '中央聯合情境', () => 1),
    make('away-favourable', '客隊整體偏好', scenario => Math.exp(0.65 * (scenario.shocks.away - scenario.shocks.home))),
    make('home-favourable', '主隊整體偏好', scenario => Math.exp(0.65 * (scenario.shocks.home - scenario.shocks.away))),
    make('run-high', '高得分壓力', scenario => Math.exp(0.75 * scenario.shocks.environment)),
    make('run-low', '低得分壓力', scenario => Math.exp(-0.75 * scenario.shocks.environment)),
    make('away-stress', '客隊打線／投手壓力', scenario => Math.exp(-0.75 * scenario.shocks.away)),
    make('home-stress', '主隊打線／投手壓力', scenario => Math.exp(-0.75 * scenario.shocks.home)),
  ];
}

function robustFromScenarioEVs(scenarioEVs, weightSets) {
  const byId = new Map(scenarioEVs.map(row => [row.id, new Decimal(row.value || 0)]));
  const variants = weightSets.map(set => ({
    id: set.id,
    description: set.description,
    value: set.rows.reduce(
      (sum, row) => sum.plus(new Decimal(row.weight || 0).mul(byId.get(row.id) || 0)),
      new Decimal(0),
    ).toNumber(),
  })).sort((left, right) => left.value - right.value);
  return { robustEV: variants[0]?.value ?? 0, worstVariant: variants[0] || null, variants };
}

function weightedQuantile(values, quantile) {
  const sorted = values.filter(row => Number.isFinite(row.value) && row.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, row) => sum + row.weight, 0);
  if (!sorted.length || total <= 0) return 0;
  let cumulative = 0;
  for (const row of sorted) {
    cumulative += row.weight / total;
    if (cumulative >= quantile) return row.value;
  }
  return sorted.at(-1).value;
}

function marketAnchorInfo(rows, row, rebateRate) {
  const actual = rows.filter(item => hasActualWater(item.water) && !item.waterEstimated);
  if (actual.length === 2) {
    const implied = actual.map(item => breakEvenProbability(item.water, rebateRate));
    const total = implied[0] + implied[1];
    const index = actual.indexOf(row);
    if (total > 0 && index >= 0) {
      return {
        probability: implied[index] / total,
        source: '雙邊實際水位去水',
        paired: true,
      };
    }
  }
  if (hasActualWater(row?.water) && !row?.waterEstimated) {
    return {
      probability: clamp(breakEvenProbability(row.water, rebateRate), 0.40, 0.60),
      source: '單邊實際價格基準',
      paired: false,
    };
  }
  if (hasActualWater(row?.water)) {
    return { probability: 0.5, source: '暫估水位中性基準', paired: false };
  }
  return { probability: null, source: '無市場價格基準', paired: false };
}

function calibrationParameters({ profile, rawProbability, marketAnchorProbability, exactLineProbability, marketName, paired, waterEstimated }) {
  if (marketAnchorProbability == null || !Number.isFinite(Number(rawProbability))) {
    return {
      weight: 1,
      maximumEdge: 1,
      rawProbabilityGap: 0,
      logitGap: 0,
      divergenceRisk: 0,
      modelErrorFloor: profile.modelErrorFloor,
    };
  }
  const qualityScale = clamp((profile.quality - 0.50) / 0.46, 0, 1);
  const evidence = clamp(profile.independentEvidenceStrength, 0.15, 0.85);
  const rawProbabilityGap = Math.abs(rawProbability - marketAnchorProbability);
  const logitGap = Math.abs(logit(rawProbability) - logit(marketAnchorProbability));
  const disagreementPenalty = 1 / (1 + 0.55 * Math.pow(logitGap, 1.20));
  const holePenalty = 1 - Math.min(0.22, exactLineProbability * (marketName.includes('讓分') ? 0.65 : 0.45));
  let weight = (1 - clamp(profile.marketReliance, 0.45, 0.86));
  weight *= 0.72 + 0.18 * qualityScale + 0.10 * evidence;
  weight *= 0.74 + 0.26 * disagreementPenalty;
  weight *= holePenalty;
  if (!paired) weight *= 0.82;
  if (marketName.includes('上半')) weight *= 0.92;
  if (waterEstimated) weight *= 0.60;
  weight = clamp(weight, 0.12, 0.55);

  // There is no out-of-sample history yet that could justify publishing a
  // double-digit probability edge over the two-sided credit market.  Keep the
  // data model influential, but cap its formal displacement from the no-vig
  // anchor at 4-7 percentage points. Raw probability/EV remain available as
  // diagnostics and never receive this cap.
  let maximumEdge = 0.040 + 0.030 * evidence * qualityScale;
  if (!paired) maximumEdge *= 0.88;
  if (marketName.includes('上半')) maximumEdge *= 0.92;
  if (exactLineProbability > 0.20) maximumEdge *= 0.94;
  maximumEdge = clamp(maximumEdge, 0.035, 0.070);
  const divergenceRisk = rawProbabilityGap * (1 - evidence) * (1 - weight * 0.25);
  return {
    weight,
    maximumEdge,
    rawProbabilityGap,
    logitGap,
    divergenceRisk,
    modelErrorFloor: profile.modelErrorFloor,
  };
}

function marketCalibratedProbability(rawProbability, marketAnchorProbability, weight, maximumEdge) {
  const raw = clamp(safe(rawProbability, 0.5), 0.001, 0.999);
  if (marketAnchorProbability == null) return raw;
  const anchor = clamp(safe(marketAnchorProbability, 0.5), 0.001, 0.999);
  const blended = logistic(logit(anchor) + weight * (logit(raw) - logit(anchor)));
  return clamp(anchor + clamp(blended - anchor, -maximumEdge, maximumEdge), 0.02, 0.98);
}

function resolvedExposure(summary) {
  return clamp(safe(summary?.equivalentWin, 0) + safe(summary?.equivalentLoss, 0), 0, 1);
}

function calibratedEVFromSummary(summary, probability, water, rebateRate) {
  const exposure = resolvedExposure(summary);
  const p = clamp(safe(probability, 0.5), 0, 1);
  return exposure * (p * (water + rebateRate) - (1 - p) * (1 - rebateRate));
}

function fairWaterFromProbability(probability, rebateRate) {
  const p = clamp(safe(probability, 0.5), 0.001, 0.999);
  return clamp(((1 - rebateRate) * (1 - p) / p) - rebateRate, 0.5, 1.5);
}

function normalizedTeam(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function sameContractDirection(leftPick, rightPick) {
  const left = parseTaiwanLine(leftPick);
  const right = parseTaiwanLine(rightPick);
  if (!left.valid || !right.valid || left.isTotal !== right.isTotal) return false;
  if (left.isTotal) return (left.isOver && right.isOver) || (left.isUnder && right.isUnder);
  return normalizedTeam(left.team) === normalizedTeam(right.team);
}

function previousMarketRow(previousMarkets, row) {
  const candidates = (Array.isArray(previousMarkets) ? previousMarkets : [])
    .filter(previous => previous?.market === row.market && sameContractDirection(previous.pick, row.pick));
  return candidates.at(-1) || null;
}

function scenarioSensitivity(scenarioEVs, scenarios) {
  const valueById = new Map(scenarioEVs.map(row => [row.id, row.value]));
  const dimensions = [
    ['away', '客隊能力／名單'],
    ['home', '主隊能力／名單'],
    ['environment', '球場／天氣／屋頂'],
  ].map(([key, label]) => {
    const levels = [-1, 0, 1].map(level => {
      const rows = scenarios.filter(scenario => scenario.shocks[key] === level);
      const total = rows.reduce((sum, scenario) => sum + scenario.weight, 0);
      const value = total > 0
        ? rows.reduce((sum, scenario) => sum + scenario.weight * safe(valueById.get(scenario.id), 0), 0) / total
        : 0;
      return { level, value };
    });
    const values = levels.map(row => row.value);
    return { key, label, range: Math.max(...values) - Math.min(...values), levels };
  }).sort((left, right) => right.range - left.range);
  return {
    primary: dimensions[0]?.label || '',
    primaryRange: dimensions[0]?.range || 0,
    dimensions,
  };
}

function movementComparison({ previous, row, distribution, context, rebateRate, weightedEV, modelProbability }) {
  if (!previous) return { available: false, reason: '無可比較舊盤' };
  const lineChanged = String(previous.pick || '') !== String(row.pick || '');
  const previousHasWater = hasActualWater(previous.water);
  const currentHasWater = hasActualWater(row.water);
  const previousParsed = parseTaiwanLine(previous.pick);
  const currentParsed = parseTaiwanLine(row.pick);
  const previousLine = previousParsed.legs?.length ? previousParsed.legs.reduce((sum, value) => sum + value, 0) / previousParsed.legs.length : null;
  const currentLine = currentParsed.legs?.length ? currentParsed.legs.reduce((sum, value) => sum + value, 0) / currentParsed.legs.length : null;
  const crossedKeyNumbers = [];
  if (Number.isFinite(previousLine) && Number.isFinite(currentLine) && Math.abs(previousLine - currentLine) > 1e-9) {
    const keys = currentParsed.isTotal ? [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15] : [0, 1, 2, 3, 4, 5];
    const minimum = Math.min(previousLine, currentLine);
    const maximum = Math.max(previousLine, currentLine);
    for (const key of keys) if (key > minimum && key <= maximum) crossedKeyNumbers.push(key);
  }
  if (!previousHasWater) {
    return { available: true, previousPick: previous.pick, previousWater: null, lineChanged, crossedKeyNumbers, reason: '舊盤水位未提供，只比較盤口文字' };
  }
  const previousWater = normalizeWater(previous.water);
  const previousSummary = summarizeDistribution({ cells: distribution, pick: previous.pick, water: previousWater, context, rebateRate });
  if (lineChanged) {
    return {
      available: true,
      previousPick: previous.pick,
      previousWater,
      lineChanged,
      waterChanged: currentHasWater && Math.abs(Number(row.water) - previousWater) > 1e-9,
      crossedKeyNumbers,
      previousWeightedEV: null,
      deltaEV: null,
      verdict: '盤口已改變，需以新合約正式分析；不混用raw與校準EV比較',
      method: '只在相同合約下使用同一校準機率比較新舊水位',
    };
  }
  const previousWeightedEV = Number.isFinite(Number(modelProbability))
    ? calibratedEVFromSummary(previousSummary, Number(modelProbability), previousWater, rebateRate)
    : previousSummary.ev;
  const deltaEV = weightedEV - previousWeightedEV;
  return {
    available: true,
    previousPick: previous.pick,
    previousWater,
    lineChanged,
    waterChanged: currentHasWater && Math.abs(Number(row.water) - previousWater) > 1e-9,
    crossedKeyNumbers,
    previousWeightedEV,
    deltaEV,
    evDoubleCheck: {
      passed: previousSummary.evDoubleCheckError <= 0.0001,
      error: previousSummary.evDoubleCheckError,
    },
    verdict: deltaEV > 0.005 ? '目前價格比舊盤更有利' : deltaEV < -0.005 ? '目前價格比舊盤更差' : '與舊盤價值接近',
    method: '沿用同一凍結聯合比分分布與同一校準勝率重算新舊水位；不重新研究核心資料',
  };
}

function scoreBand(score) {
  if (score == null) return '不評分';
  if (score >= 8.5) return '8.5+';
  if (score >= 8.0) return '8.0–8.4';
  if (score >= 7.5) return '7.5–7.9';
  if (score >= 7.2) return '7.2–7.4';
  if (score >= 6.7) return '6.7–7.1';
  return '≤6.6';
}

function unitSuggestion({ score, robustEV, flipProbability, quality, eligible, modelErrorFloor = 0.025, independentEvidence = 0.35 }) {
  if (!eligible) return 0;
  const edgeAboveError = robustEV - modelErrorFloor;
  let units = score >= 8.5 ? 1.25 : score >= 8.0 ? 1.0 : score >= 7.5 ? 0.75 : 0.5;
  if (edgeAboveError < 0.012 || flipProbability > 0.25 || quality < 0.72) units = Math.min(units, 0.5);
  if (independentEvidence < 0.35) units = Math.min(units, 0.5);
  if (flipProbability < 0.08 && quality > 0.88 && edgeAboveError > 0.04 && independentEvidence > 0.60) units += 0.25;
  return clamp(Math.round(units * 4) / 4, 0.25, 1.5);
}

function buildRisks({ profile, flipProbability, robustEV, marketName, row, rawProbabilityGap = 0, calibrationWeight = 1, divergenceRisk = 0 }) {
  const risks = [];
  if (profile.statuses.awayLineup !== '已確認' || profile.statuses.homeLineup !== '已確認') risks.push('正式打線／輪休仍可能改變情境權重');
  if (profile.statuses.awayBullpen !== '已確認' || profile.statuses.homeBullpen !== '已確認') risks.push('牛棚逐投手可用性仍有估計誤差');
  if (profile.statuses.weatherRoof !== '已確認') risks.push('天氣／屋頂情境尚未完全確認');
  if (profile.statuses.umpire !== '已確認') risks.push('主審採中性分布');
  if (!profile.expertLayerUsed) risks.push('GPT 研究判讀層未完成，本版使用統計備援');
  if (rawProbabilityGap > 0.08) risks.push(`原始模型與市場差距 ${(rawProbabilityGap * 100).toFixed(1)}%，正式 EV 使用 ${(calibrationWeight * 100).toFixed(0)}% 資料模型權重`);
  if (divergenceRisk > 0.10) risks.push('市場與資料模型分歧仍大，已提高評分所需誤差門檻');
  if (flipProbability > 0.20) risks.push(`EV 翻負機率約 ${(flipProbability * 100).toFixed(0)}%`);
  if (robustEV <= 0) risks.push('最不利合理情境已翻為非正 EV');
  else if (robustEV <= profile.modelErrorFloor) risks.push('穩健 EV 尚未明確高於模型誤差門檻');
  if (marketName.includes('上半')) risks.push('前五局對先發臨場狀態與提前退場較敏感');
  if (row.waterEstimated) risks.push('水位為暫估，不可列入正式下注池');
  return risks.slice(0, 5);
}

function resultIntegrity({ summary, rows, marketAnchorProbability, scenarioEVs }) {
  const coverageInvalid = summary.coverage < 0.999;
  const scenarioInvalid = scenarioEVs.some(row => !Number.isFinite(row.value));
  const halfLineHasPush = parseTaiwanLine(rows[0]?.pick).legs?.every(line => Math.abs(line % 1) > 1e-9) && summary.push > 0.002;
  const extremeMismatch = marketAnchorProbability != null
    && marketAnchorProbability > 0.33 && marketAnchorProbability < 0.67
    && (summary.modelProbability < 0.025 || summary.modelProbability > 0.975);
  const warning = coverageInvalid || scenarioInvalid || halfLineHasPush || extremeMismatch;
  const message = coverageInvalid
    ? '比分分布覆蓋不足'
    : scenarioInvalid
      ? '情境 EV 計算異常'
      : halfLineHasPush
        ? '半分盤出現不應存在的走水機率'
        : extremeMismatch
          ? '模型與市場基準差距異常，封鎖正式下注'
          : '';
  return { warning, message };
}

function contractProfitOnJoint(result, cell, context, rebateRate) {
  const first5 = String(result.market || '').includes('上半');
  const awayRuns = first5 ? cell.awayFirst5 : cell.awayRuns;
  const homeRuns = first5 ? cell.homeFirst5 : cell.homeRuns;
  const fraction = outcomeFractionForScore(result.pick, awayRuns, homeRuns, context.game.away, context.game.home);
  if (fraction == null) return 0;
  return calculateProfit({ stake: 1, water: result.water, fraction, rebateRate }).profit;
}

function contractCorrelation(left, right, jointCells, context, rebateRate) {
  if (!jointCells?.length || !hasActualWater(left?.water) || !hasActualWater(right?.water)) return 0;
  let leftMean = 0;
  let rightMean = 0;
  const values = jointCells.map(cell => {
    const leftValue = contractProfitOnJoint(left, cell, context, rebateRate);
    const rightValue = contractProfitOnJoint(right, cell, context, rebateRate);
    leftMean += cell.probability * leftValue;
    rightMean += cell.probability * rightValue;
    return { probability: cell.probability, leftValue, rightValue };
  });
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (const row of values) {
    const leftDelta = row.leftValue - leftMean;
    const rightDelta = row.rightValue - rightMean;
    covariance += row.probability * leftDelta * rightDelta;
    leftVariance += row.probability * leftDelta ** 2;
    rightVariance += row.probability * rightDelta ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator > 1e-12 ? clamp(covariance / denominator, -1, 1) : 0;
}

function buildPortfolio(results, jointCells, context, rebateRate) {
  const eligible = results.filter(result => result.betEligible).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return right.conservativeEV - left.conservativeEV;
  });
  const portfolio = [];
  let totalUnits = 0;
  for (const result of eligible) {
    const primary = portfolio[0]?.result || null;
    const correlation = primary ? contractCorrelation(primary, result, jointCells, context, rebateRate) : 0;
    const role = !primary ? '主選' : correlation > 0.65 ? '備選' : '次選';
    let units = result.unitSuggestion;
    if (role === '備選') units = Math.min(units, 0.25);
    else if (role === '次選' && correlation > 0.35) units = Math.min(units, 0.5);
    units = Math.min(units, Math.max(0, 2.0 - totalUnits));
    if (units <= 0) continue;
    totalUnits += units;
    portfolio.push({ result, role, recommendedUnit: units, correlationToPrimary: correlation });
  }
  return portfolio.map(row => ({
    market: row.result.market,
    pick: row.result.pick,
    score: row.result.score,
    role: row.role,
    recommendedUnit: row.recommendedUnit,
    correlationToPrimary: row.correlationToPrimary,
  }));
}

function scoreDistributionAudit(results) {
  const rows = (results || []).filter(result => Number.isFinite(Number(result.score)));
  const values = rows.map(result => Number(result.score));
  const displayedCounts = new Map();
  for (const value of values) {
    const key = value.toFixed(1);
    displayedCounts.set(key, (displayedCounts.get(key) || 0) + 1);
  }
  const displayedEntries = [...displayedCounts.entries()].sort((left, right) => right[1] - left[1] || Number(left[0]) - Number(right[0]));
  const dominant = displayedEntries[0] || [null, 0];
  const clampedLowCount = rows.filter(result => result.scoreAudit?.breakdown?.clampedLow).length;
  const clampedHighCount = rows.filter(result => result.scoreAudit?.breakdown?.clampedHigh).length;
  const minimum = values.length ? Math.min(...values) : null;
  const maximum = values.length ? Math.max(...values) : null;
  const spread = values.length ? maximum - minimum : null;
  const errors = [];

  // This specifically prevents the regression where five or six directions
  // all displayed as exactly 3.5 merely because the scorer hit a lower clamp.
  if (values.length >= 4 && dominant[1] > Math.ceil(values.length * 0.50)) {
    errors.push(`單一顯示分數 ${dominant[0]} 集中 ${dominant[1]}/${values.length}，疑似評分黏底或黏頂`);
  }
  if (values.length >= 6 && displayedCounts.size < 3) errors.push('同場評分有效分布少於 3 個級距');
  if (values.length >= 6 && spread != null && spread < 0.25) errors.push('同場評分差異過小，疑似公式退化');
  if (clampedLowCount > Math.max(1, Math.floor(values.length * 0.25))) errors.push('過多方向命中最低分界');
  if (clampedHighCount > Math.max(1, Math.floor(values.length * 0.25))) errors.push('過多方向命中最高分界');

  return {
    passed: errors.length === 0,
    checkedDirections: values.length,
    minimum,
    maximum,
    spread,
    uniqueDisplayedScores: displayedCounts.size,
    dominantDisplayedScore: dominant[0],
    dominantDisplayedCount: dominant[1],
    clampedLowCount,
    clampedHighCount,
    errors,
  };
}

function compactJoint(cells) {
  return (cells || []).map(cell => [cell.awayFirst5, cell.homeFirst5, cell.awayRuns, cell.homeRuns, cell.probability]);
}

function expandJoint(rows) {
  return (rows || []).map(row => ({
    awayFirst5: Number(row[0]),
    homeFirst5: Number(row[1]),
    awayRuns: Number(row[2]),
    homeRuns: Number(row[3]),
    probability: Number(row[4]),
  }));
}

function compactRobustSets(sets) {
  return (sets || []).map(set => ({
    id: set.id,
    description: set.description,
    rows: set.rows.map(row => [row.id, row.weight]),
  }));
}

function expandRobustSets(sets) {
  return (sets || []).map(set => ({
    id: set.id,
    description: set.description,
    rows: (set.rows || []).map(row => ({ id: row[0], weight: Number(row[1]) })),
  }));
}

export function buildDistributionSnapshot({ context, settings = {} }) {
  if (context?.coreModelable === false) throw new Error('資料不足｜不評分');
  const contract = assertAnalysisModeContract(context);
  const simulationsPerScenario = clamp(Math.round(safe(settings.simulationsPerScenario, 1800)), 500, 4000);
  const profile = gameContextProfile(context, contract.modelConfig);
  const scenarioBase = scenarioGrid(profile);
  const coreIdentity = context?.coreFingerprint || `${context?.game?.gamePk}|${context?.game?.away}|${context?.game?.home}`;
  const modelCoreIdentity = contract.modelContractHash
    ? sha256({ coreIdentity, modelContractHash: contract.modelContractHash })
    : coreIdentity;
  const seedBase = hashString(`${contract.modelVersion}|${modelCoreIdentity}|${simulationsPerScenario}`);
  const scenarios = scenarioBase.map((scenario, index) => ({
    ...scenario,
    joint: simulateScenario(
      scenario,
      simulationsPerScenario,
      seedBase ^ hashString(scenario.id) ^ Math.imul(index + 1, 2654435761),
      contract.modelConfig,
    ),
  }));
  const combinedJointCells = combinedJoint(scenarios);
  const robustSets = robustWeightSets(scenarios);
  const snapshotCore = {
    version: 'MLB-FROZEN-JOINT-DISTRIBUTION-2026-08-v1.0.0',
    modelVersion: contract.modelVersion,
    rulesVersion: contract.rulesVersion,
    coreFingerprint: context?.coreFingerprint || null,
    seedBase,
    simulationsPerScenario,
    profile,
    scenarios: scenarios.map(scenario => ({
      id: scenario.id,
      weight: scenario.weight,
      shocks: scenario.shocks,
      means: scenario.means,
      joint: compactJoint(scenario.joint),
    })),
    robustSets: compactRobustSets(robustSets),
    combinedJoint: compactJoint(combinedJointCells),
  };
  if (contract.modelContractHash) {
    Object.assign(snapshotCore, {
      leagueId: contract.leagueId,
      analysisMode: contract.analysisMode,
      modelConfig: contract.modelConfig,
      modelContractHash: contract.modelContractHash,
      modelCoreFingerprint: modelCoreIdentity,
    });
  }
  const distributionHash = sha256(snapshotCore);
  const drawProb = drawProbability(combinedJointCells);
  return {
    ...snapshotCore,
    distributionHash,
    distributionId: `${context?.game?.gamePk || 'game'}-${distributionHash.slice(0, 20)}`,
    drawProb,
  };
}

function hydrateDistributionSnapshot(snapshot, context) {
  const contract = assertAnalysisModeContract(context);
  if (!snapshot
    || snapshot.modelVersion !== contract.modelVersion
    || snapshot.rulesVersion !== contract.rulesVersion
    || !snapshot.distributionHash) {
    throw new Error('凍結比分分布版本不相容，必須完整重算');
  }
  if (contract.modelContractHash) {
    if (snapshot.analysisMode !== contract.analysisMode
      || snapshot.leagueId !== contract.leagueId
      || snapshot.modelContractHash !== contract.modelContractHash
      || sha256(snapshot.modelConfig) !== sha256(contract.modelConfig)) {
      throw new Error('凍結比分分布模型契約不相容，必須完整重算');
    }
  } else if (snapshot.modelContractHash || snapshot.analysisMode === SHADOW_ANALYSIS_MODE) {
    throw new Error('凍結比分分布模型契約不相容，必須完整重算');
  }
  const withoutHash = { ...snapshot };
  delete withoutHash.distributionHash;
  delete withoutHash.distributionId;
  delete withoutHash.drawProb;
  const actualHash = sha256(withoutHash);
  if (actualHash !== snapshot.distributionHash) throw new Error('凍結比分分布雜湊驗證失敗');
  const scenarios = (snapshot.scenarios || []).map(scenario => ({
    ...scenario,
    weight: Number(scenario.weight),
    joint: expandJoint(scenario.joint),
  }));
  const combinedJointCells = expandJoint(snapshot.combinedJoint);
  const robustSets = expandRobustSets(snapshot.robustSets);
  const derivedDrawProb = drawProbability(combinedJointCells);
  if (snapshot.drawProb != null && Math.abs(Number(snapshot.drawProb) - derivedDrawProb) > 1e-12) {
    throw new Error('凍結比分分布和局機率驗證失敗');
  }
  return { profile: snapshot.profile, scenarios, combinedJointCells, robustSets, drawProb: derivedDrawProb, contract };
}

function pricingAggregate(scenarioEvaluations, rows = null) {
  const weights = rows
    ? new Map(rows.map(row => [row.id, Number(row.weight)]))
    : new Map(scenarioEvaluations.map(row => [row.id, Number(row.weight)]));
  let win = new Decimal(0);
  let loss = new Decimal(0);
  for (const scenario of scenarioEvaluations) {
    const weight = new Decimal(weights.get(scenario.id) || 0);
    // Formal EV is calibrated from the independent baseball distribution toward
    // the no-vig two-sided market anchor.  Threshold prices must use that same
    // calibrated pricing measure instead of silently falling back to raw model
    // probabilities.
    win = win.plus(weight.mul(scenario.calibratedEquivalentWin ?? scenario.summary.equivalentWin ?? 0));
    loss = loss.plus(weight.mul(scenario.calibratedEquivalentLoss ?? scenario.summary.equivalentLoss ?? 0));
  }
  return { win: win.toNumber(), loss: loss.toNumber() };
}

function waterForEVTarget(pricing, targetEV, rebateRate) {
  const win = new Decimal(pricing?.win || 0);
  const loss = new Decimal(pricing?.loss || 0);
  if (win.lte(0)) return null;
  return new Decimal(targetEV || 0)
    .plus(loss.mul(new Decimal(1).minus(rebateRate)))
    .div(win)
    .minus(rebateRate)
    .toNumber();
}

function minimumWaterThresholds(scenarioEvaluations, robustSets, currentWater, rebateRate, crossMarketVerified) {
  const weightedPricing = pricingAggregate(scenarioEvaluations);
  const robustPricings = robustSets.map(set => ({
    id: set.id,
    description: set.description,
    ...pricingAggregate(scenarioEvaluations, set.rows),
  }));
  const threshold = (score, weightedTarget, robustTarget, comparator = '>=') => {
    const weightedWater = waterForEVTarget(weightedPricing, weightedTarget, rebateRate);
    const robustWaters = robustPricings.map(pricing => waterForEVTarget(pricing, robustTarget, rebateRate)).filter(Number.isFinite);
    const robustWater = robustWaters.length ? Math.max(...robustWaters) : null;
    const requiredWater = [weightedWater, robustWater].filter(Number.isFinite).length
      ? Math.max(...[weightedWater, robustWater].filter(Number.isFinite))
      : null;
    return {
      score,
      weightedTarget,
      robustTarget,
      comparator,
      weightedWater,
      robustWater,
      requiredWater,
      withinSupportedWaterRange: requiredWater != null && requiredWater >= 0.5 && requiredWater <= 1.5,
      distanceFromCurrent: requiredWater == null ? null : requiredWater - Number(currentWater),
    };
  };
  return {
    currentLineOnly: true,
    waterPrecisionPolicy: '保留完整內部精度；顯示時不得反向用於資格判定',
    score7_2: threshold(7.2, 0, 0, '>'),
    score7_5: threshold(7.5, 0.020, 0.008),
    score8_0: threshold(8.0, 0.040, 0.020),
    score8_5: {
      ...threshold(8.5, 0.070, 0.040),
      crossMarketVerified: crossMarketVerified === true,
      marketQualificationRequired: true,
    },
    virtual9_0: threshold(9.0, 0.120, 0.080),
  };
}

function holeAuditForRow(row, context, rebateRate) {
  const parsed = parseTaiwanLine(row.pick);
  if (!parsed.valid || !parsed.legs?.length) return null;
  const integerLegs = [...new Set(parsed.legs.filter(line => Number.isInteger(Number(line))).map(Number))];
  if (!integerLegs.length) return null;
  const audits = [];
  for (const line of integerLegs) {
    let awayRuns = 0;
    let homeRuns = 0;
    let trigger = '';
    if (parsed.isTotal) {
      homeRuns = line;
      trigger = `總分剛好${line}`;
    } else {
      const selectedIsAway = normalizedTeam(parsed.team) === normalizedTeam(context.game.away);
      if (parsed.isGiving) {
        if (selectedIsAway) awayRuns = line;
        else homeRuns = line;
      } else {
        if (selectedIsAway) homeRuns = line;
        else awayRuns = line;
      }
      trigger = `讓方剛好贏${line}分`;
    }
    const settlement = outcomeSettlementForScore(row.pick, awayRuns, homeRuns, context.game.away, context.game.home);
    if (!settlement) continue;
    const calculation = calculateProfit({ stake: 10000, water: row.water, settlement, rebateRate });
    audits.push({
      line,
      trigger,
      awayRuns,
      homeRuns,
      winFraction: settlement.winFraction,
      lossFraction: settlement.lossFraction,
      pushFraction: settlement.pushFraction,
      netProfitPer10000: calculation.profit,
      rebatePer10000: calculation.rebate,
      legOutcomes: settlement.legs,
    });
  }
  return audits.length ? { passed: true, audits } : null;
}

function evidenceIntegrity({ weightedSummary, scenarioEvaluations, rows, weightedEV, robustEV }) {
  const failures = [];
  if (weightedSummary.coverage < 0.999999) failures.push('比分分布覆蓋不足100%');
  if (Math.abs(weightedSummary.categoryCoverage - weightedSummary.coverage) > 0.000001) failures.push('結果分類機率未完整覆蓋');
  const maximumDoubleCheckError = Math.max(
    weightedSummary.evDoubleCheckError || 0,
    ...scenarioEvaluations.map(row => row.summary.evDoubleCheckError || 0),
  );
  if (maximumDoubleCheckError > 0.0001) failures.push('逐比分EV與結果桶EV誤差超過0.01%');
  if (scenarioEvaluations.some(row => !Number.isFinite(row.value))) failures.push('情境EV不是有限數值');
  if (robustEV > weightedEV + 0.0000000001) failures.push('穩健EV高於加權EV');
  const parsed = parseTaiwanLine(rows[0]?.pick);
  const allLegsNonInteger = parsed?.legs?.length && parsed.legs.every(line => Math.abs(Number(line) % 1) > 1e-9);
  if (allLegsNonInteger && weightedSummary.push > 0.002) failures.push('純半分盤出現不應存在的走水機率');
  return {
    passed: failures.length === 0,
    failures,
    maximumDoubleCheckError,
  };
}

export function evaluateMarketsFromDistribution({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  const rebateRate = clamp(safe(settings.rebateRate, 0.015), 0, 0.1);
  const {
    profile,
    scenarios,
    combinedJointCells,
    robustSets,
    drawProb,
    contract,
  } = hydrateDistributionSnapshot(distributionSnapshot, context);
  const distributionId = distributionSnapshot.distributionId;
  const results = [];

  for (const marketName of MARKET_ORDER) {
    const rows = (Array.isArray(markets) ? markets : [])
      .filter(row => row?.market === marketName && String(row?.pick || '').trim())
      .slice(0, 2);
    if (!rows.length) continue;
    const combinedDistribution = distributionForMarket(combinedJointCells, marketName);

    for (const row of rows) {
      const actualWaterProvided = hasActualWater(row.water);
      const waterEstimated = Boolean(row.waterEstimated);
      const anchorInfo = marketAnchorInfo(rows, row, rebateRate);
      const previous = previousMarketRow(previousMarkets, row);
      if (!actualWaterProvided) {
        results.push({
          ...row,
          water: null,
          waterMissing: true,
          waterEstimated: false,
          score: null,
          tag: '水位未提供｜不評分',
          betEligible: false,
          modelProbability: null,
          rawModelProbability: null,
          marketAnchorProbability: anchorInfo.probability,
          weightedEV: null,
          robustEV: null,
          conservativeEV: null,
          ev: null,
          rawEV: null,
          evFlipProbability: null,
          distributionCoverage: 1,
          movement: { available: false, reason: '目前水位未提供' },
          distributionId,
          sourceStatuses: profile.statuses,
          evDoubleCheck: { passed: true, skipped: true },
        });
        continue;
      }

      const water = normalizeWater(row.water);
      const rawWeightedSummary = summarizeDistribution({ cells: combinedDistribution, pick: row.pick, water, context, rebateRate });
      const marketAnchorProbability = anchorInfo.probability;
      const calibration = calibrationParameters({
        profile,
        rawProbability: rawWeightedSummary.modelProbability,
        marketAnchorProbability,
        exactLineProbability: rawWeightedSummary.exactLineProbability,
        marketName,
        paired: anchorInfo.paired,
        waterEstimated,
      });
      const scenarioEvaluations = scenarios.map(scenario => {
        const rawSummary = summarizeDistribution({
          cells: distributionForMarket(scenario.joint, marketName),
          pick: row.pick,
          water,
          context,
          rebateRate,
        });
        const calibratedProbability = marketCalibratedProbability(
          rawSummary.modelProbability,
          marketAnchorProbability,
          calibration.weight,
          calibration.maximumEdge,
        );
        const exposure = resolvedExposure(rawSummary);
        const calibratedEquivalentWin = exposure * calibratedProbability;
        const calibratedEquivalentLoss = exposure * (1 - calibratedProbability);
        return {
          id: scenario.id,
          weight: scenario.weight,
          value: calibratedEVFromSummary(rawSummary, calibratedProbability, water, rebateRate),
          rawValue: rawSummary.ev,
          rawProbability: rawSummary.modelProbability,
          calibratedProbability,
          calibratedEquivalentWin,
          calibratedEquivalentLoss,
          exposure,
          summary: rawSummary,
        };
      });
      const scenarioEVs = scenarioEvaluations.map(scenario => ({ id: scenario.id, weight: scenario.weight, value: scenario.value }));
      const weightedEV = scenarioEvaluations.reduce(
        (sum, scenario) => sum.plus(new Decimal(scenario.weight || 0).mul(scenario.value || 0)),
        new Decimal(0),
      ).toNumber();
      const rawEV = scenarioEvaluations.reduce(
        (sum, scenario) => sum.plus(new Decimal(scenario.weight || 0).mul(scenario.rawValue || 0)),
        new Decimal(0),
      ).toNumber();
      const rawAggregationError = Math.abs(rawEV - rawWeightedSummary.ev);
      const robust = robustFromScenarioEVs(scenarioEVs, robustSets);
      const conservativeEV = weightedQuantile(scenarioEVs, 0.20);
      const evFlipProbabilityDiagnostic = scenarioEVs
        .filter(scenario => scenario.value <= 0)
        .reduce((sum, scenario) => sum + scenario.weight, 0);
      const sensitivity = scenarioSensitivity(scenarioEVs, scenarios);
      const calibratedEquivalentWin = scenarioEvaluations.reduce(
        (sum, scenario) => sum.plus(new Decimal(scenario.weight || 0).mul(scenario.calibratedEquivalentWin || 0)),
        new Decimal(0),
      ).toNumber();
      const calibratedEquivalentLoss = scenarioEvaluations.reduce(
        (sum, scenario) => sum.plus(new Decimal(scenario.weight || 0).mul(scenario.calibratedEquivalentLoss || 0)),
        new Decimal(0),
      ).toNumber();
      const calibratedResolved = calibratedEquivalentWin + calibratedEquivalentLoss;
      const modelProbability = calibratedResolved > 1e-12
        ? calibratedEquivalentWin / calibratedResolved
        : marketAnchorProbability ?? rawWeightedSummary.modelProbability;
      const calibratedAggregateEV = calibratedEquivalentWin * (water + rebateRate)
        - calibratedEquivalentLoss * (1 - rebateRate);
      const calibratedAggregationError = Math.abs(weightedEV - calibratedAggregateEV);
      const integrity = evidenceIntegrity({
        weightedSummary: rawWeightedSummary,
        scenarioEvaluations,
        rows,
        weightedEV,
        robustEV: robust.robustEV,
      });
      if (rawAggregationError > 0.0001) integrity.failures.push('原始情境加權EV與合併分布EV誤差超過0.01%');
      if (calibratedAggregationError > 0.0001) integrity.failures.push('校準情境EV與校準結果桶EV誤差超過0.01%');
      integrity.passed = integrity.failures.length === 0;
      const rawMarketProbabilityGap = marketAnchorProbability == null
        ? null
        : Math.abs(rawWeightedSummary.modelProbability - marketAnchorProbability);
      const calibratedMarketProbabilityGap = marketAnchorProbability == null
        ? null
        : Math.abs(modelProbability - marketAnchorProbability);
      const movement = movementComparison({
        previous,
        row,
        distribution: combinedDistribution,
        context,
        rebateRate,
        weightedEV,
        modelProbability,
      });
      const crossMarketVerified = row.marketVerification?.verified === true;
      const minimumWater = minimumWaterThresholds(
        scenarioEvaluations,
        robustSets,
        water,
        rebateRate,
        crossMarketVerified,
      );

      results.push({
        ...row,
        water,
        waterMissing: false,
        waterEstimated,
        modelProbability,
        rawModelProbability: rawWeightedSummary.modelProbability,
        marketAnchorProbability,
        marketAnchorSource: anchorInfo.source,
        marketCalibrationWeight: calibration.weight,
        maximumCalibratedProbabilityEdge: calibration.maximumEdge,
        rawMarketProbabilityGap,
        calibratedMarketProbabilityGap,
        marketCalibrationApplied: marketAnchorProbability != null,
        marketReliance: profile.marketReliance,
        modelErrorFloor: calibration.modelErrorFloor,
        independentEvidenceStrength: profile.independentEvidenceStrength,
        divergenceRisk: calibration.divergenceRisk,
        expertLayerUsed: false,
        expertModel: null,
        outcomeProbabilitiesSource: 'MLB資料建立的凍結聯合比分分布；正式EV以雙邊實際水位去水基準作有限收縮校準，不改寫比分分布',
        fairWater: fairWaterFromProbability(modelProbability, rebateRate),
        rawFairWater: rawWeightedSummary.fairWater,
        fullWinProbability: rawWeightedSummary.fullWin,
        partialWinProbability: rawWeightedSummary.partialWin,
        pushProbability: rawWeightedSummary.push,
        partialLossProbability: rawWeightedSummary.partialLoss,
        fullLossProbability: rawWeightedSummary.fullLoss,
        mixedWinLossProbability: rawWeightedSummary.mixedWinLoss,
        mixedNeutralProbability: rawWeightedSummary.mixedNeutral,
        exactLineProbability: rawWeightedSummary.exactLineProbability,
        distributionCoverage: rawWeightedSummary.coverage,
        weightedEV,
        robustEV: robust.robustEV,
        conservativeEV,
        cev: conservativeEV,
        rawEV,
        ev: weightedEV,
        evFlipProbability: null,
        evFlipProbabilityDiagnostic,
        evFlipStatus: '診斷值｜目前情境集合不視為獨立機率抽樣母體',
        worstVariant: robust.worstVariant?.description || '',
        robustVariants: robust.variants,
        scenarioSensitivity: sensitivity,
        integrityWarning: !integrity.passed,
        integrityMessage: integrity.failures.join('；'),
        confidence: profile.quality,
        score: 0,
        scoreAudit: { ok: integrity.passed, evidenceOnly: true, errors: integrity.failures },
        scoreBreakdown: null,
        tag: integrity.passed ? '待固定公式評分' : '⛔ QA未通過｜不評分｜不下注',
        betEligible: false,
        unitSuggestion: null,
        primaryRisks: buildRisks({
          profile,
          flipProbability: evFlipProbabilityDiagnostic,
          robustEV: robust.robustEV,
          marketName,
          row,
          rawProbabilityGap: rawMarketProbabilityGap || 0,
          calibrationWeight: calibration.weight,
          divergenceRisk: calibration.divergenceRisk,
        }),
        movement,
        distributionId,
        sourceStatuses: profile.statuses,
        evDoubleCheck: {
          passed: integrity.maximumDoubleCheckError <= 0.0001
            && rawAggregationError <= 0.0001
            && calibratedAggregationError <= 0.0001,
          directEV: rawWeightedSummary.ev,
          bucketEV: rawWeightedSummary.evFromBuckets,
          scenarioWeightedEV: weightedEV,
          combinedDistributionEV: rawWeightedSummary.ev,
          rawScenarioWeightedEV: rawEV,
          calibratedAggregateEV,
          maximumBucketError: integrity.maximumDoubleCheckError,
          aggregationError: Math.max(rawAggregationError, calibratedAggregationError),
          rawAggregationError,
          calibratedAggregationError,
          tolerance: 0.0001,
          methods: ['逐比分逐腿損益加總', '結算結果桶機率彙總', '去水市場基準有限收縮後結果桶加總'],
        },
        minimumWater,
        holeAudit: holeAuditForRow({ ...row, water }, context, rebateRate),
      });
    }
  }

  const analysis = {
    leagueId: contract.leagueId,
    analysisMode: contract.analysisMode,
    modelVersion: contract.modelVersion,
    rulesVersion: contract.rulesVersion,
    ...(contract.modelContractHash ? {
      modelConfig: contract.modelConfig,
      modelContractHash: contract.modelContractHash,
    } : {}),
    scoreContractVersion: null,
    scoreValidation: {
      version: 'EV-EVIDENCE-ONLY-v9.1',
      passed: results.every(result => result.water == null || result.scoreAudit?.ok === true),
      checkedDirections: results.filter(result => result.water != null).length,
      failures: results.flatMap(result => result.scoreAudit?.ok === false
        ? [`${result.market}｜${result.pick}：${(result.scoreAudit.errors || []).join('；')}`]
        : []),
    },
    snapshotId: distributionId,
    distributionId,
    distributionHash: distributionSnapshot.distributionHash,
    drawProb,
    distributionSnapshot,
    createdAt: new Date().toISOString(),
    analysisStatus: Object.values(profile.statuses).every(value => value === '已確認') ? '完整資料版' : '聯合情境版',
    dataQuality: profile.quality,
    expectedRuns: { full: profile.full, first5: profile.first5 },
    modelInputs: profile.components,
    sourceStatuses: profile.statuses,
    scenarioSummary: {
      count: scenarios.length,
      robustVariantCount: robustSets.length,
      simulationsPerScenario: distributionSnapshot.simulationsPerScenario,
      totalSimulations: scenarios.length * distributionSnapshot.simulationsPerScenario,
      conservativeQuantile: 0.20,
      sharedDistribution: true,
      jointPortfolioDistribution: true,
      jointCellCount: combinedJointCells.length,
      persistedForReprice: true,
      targetPriceCalibratesDistribution: false,
      marketProbabilityCalibrationApplied: true,
    },
    alignmentAudit: {
      instructionVersion: 'MLB 長期正 EV 分析指令｜每日執行最佳化版',
      expertLayer: { used: false, model: null, summary: '', reason: 'GPT不得參與數字評分；本版未使用GPT殘差調整' },
      confirmed: profile.expertAudit?.confirmed || [],
      estimated: profile.expertAudit?.estimated || [],
      unknown: profile.expertAudit?.unknown || [],
      blocking: profile.expertAudit?.blocking || [],
      unmodeled: profile.expertAudit?.unmodeled || [],
      modules: [
        { name: '實際盤口與單邊水位', status: '來源分類；只有實際台灣信用盤＋實際水位可進正式下注' },
        { name: '台灣信用盤逐腿結算與每萬退150', status: '已實作；不得先互抵' },
        { name: '前五局與全場共用聯合比分世界', status: '已實作並保存凍結分布' },
        { name: '實際盤口機率校準', status: '啟用；雙邊實際水位去水後作有限收縮，只校準正式EV且不改寫比分分布' },
        { name: 'EV雙算', status: '逐比分與結果桶獨立驗算' },
        { name: 'GPT數字評分', status: '停用' },
        { name: '正式／預估打線與捕手', status: profile.statuses.awayLineup === '已確認' && profile.statuses.homeLineup === '已確認' ? '已確認' : '情境建模' },
      ],
    },
    featureProvenance: Array.isArray(context?.featureProvenance) ? context.featureProvenance : [],
    warnings: Array.isArray(context?.warnings) ? context.warnings : [],
    portfolio: [],
    results,
  };
  return enforceShadowAnalysisSafety(analysis, context);
}

export function analyzeMarkets({ context, markets, previousMarkets = [], settings = {} }) {
  const distributionSnapshot = buildDistributionSnapshot({ context, settings });
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}

export function repriceMarkets({ context, markets, previousMarkets = [], settings = {}, distributionSnapshot }) {
  if (!distributionSnapshot) throw new Error('缺少凍結比分分布，不能進行價格快速重算');
  if (context?.coreFingerprint && distributionSnapshot.coreFingerprint
    && context.coreFingerprint !== distributionSnapshot.coreFingerprint) {
    throw new Error('核心資料指紋已改變，必須完整重算');
  }
  return evaluateMarketsFromDistribution({ context, markets, previousMarkets, settings, distributionSnapshot });
}
