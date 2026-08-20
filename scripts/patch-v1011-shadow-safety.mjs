import fs from 'node:fs';

const path = 'lib/analysis-v11.js';
let source = fs.readFileSync(path, 'utf8');
const before = `function lockResult(row) {
  if (!row || typeof row !== 'object') return row;
  return { ...row, betEligible: false, unitSuggestion: null, recommendedUnit: null, portfolioUnit: null };
}

export function enforceShadowAnalysisSafety(value) {
  if (!value || typeof value !== 'object') return value;
  const output = { ...value, betEligible: false, formalRecommendationsEnabled: false };
  if (Array.isArray(output.results)) output.results = output.results.map(lockResult);
  if (output.analysis && typeof output.analysis === 'object') output.analysis = enforceShadowAnalysisSafety(output.analysis);
  if (output.frozenContext && typeof output.frozenContext === 'object') output.frozenContext = { ...output.frozenContext, betEligible: false, executable: false, formalScoringEnabled: false };
  return output;
}

export function enforceAnalysisModeSafety(value, context = {}) {
  return String(context?.analysisMode || value?.analysisMode || SHADOW_ANALYSIS_MODE).toUpperCase() === FORMAL_ANALYSIS_MODE
    ? value
    : enforceShadowAnalysisSafety(value);
}
`;
const after = `function lockContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  return { ...value, analysisMode: SHADOW_ANALYSIS_MODE, executable: false, betEligible: false, formalScoringEnabled: false };
}

function lockResult(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    analysisMode: SHADOW_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    scoreType: SHADOW_SCORE_TYPE,
    diagnosticTag: row?.diagnosticTag || row?.tag || null,
    tag: SHADOW_RESULT_TAG,
    unitSuggestion: null,
    recommendedUnit: null,
    portfolioRole: '',
    portfolioUnit: null,
    unitStatus: 'SHADOW｜不可下注',
    shadowSafety: { enforced: true, reason: '模型尚未完成 locked OOS／forward 正式驗證' },
  };
}

export function enforceShadowAnalysisSafety(value, context = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const leagueId = String(context?.leagueId || value?.leagueId || value?.context?.leagueId || value?.frozenContext?.leagueId || 'MLB').toUpperCase();
  const nestedAnalysis = value.analysis && typeof value.analysis === 'object'
    ? enforceShadowAnalysisSafety(value.analysis, { ...context, leagueId })
    : value.analysis;
  const repriceSnapshot = value.repriceSnapshot && typeof value.repriceSnapshot === 'object'
    ? {
      ...value.repriceSnapshot,
      analysisMode: SHADOW_ANALYSIS_MODE,
      executable: false,
      betEligible: false,
      portfolio: [],
      context: lockContext(value.repriceSnapshot.context),
      frozenContext: lockContext(value.repriceSnapshot.frozenContext),
      results: Array.isArray(value.repriceSnapshot.results) ? value.repriceSnapshot.results.map(lockResult) : value.repriceSnapshot.results,
    }
    : value.repriceSnapshot;
  return {
    ...value,
    leagueId,
    analysisMode: SHADOW_ANALYSIS_MODE,
    executable: false,
    betEligible: false,
    formalScoringEnabled: false,
    formalRecommendationsEnabled: false,
    scoreType: SHADOW_SCORE_TYPE,
    tag: SHADOW_RESULT_TAG,
    unitSuggestion: null,
    portfolio: [],
    context: lockContext(value.context),
    frozenContext: lockContext(value.frozenContext),
    ...(nestedAnalysis === undefined ? {} : { analysis: nestedAnalysis }),
    ...(repriceSnapshot === undefined ? {} : { repriceSnapshot }),
    warnings: [...new Set([...(Array.isArray(value.warnings) ? value.warnings : []), 'SHADOW｜僅供模型診斷與評分驗證｜不可下注'])],
    shadowSafety: { enforced: true, analysisMode: SHADOW_ANALYSIS_MODE, leagueId, reason: '模型尚未完成 locked OOS／forward 正式驗證' },
    results: (Array.isArray(value.results) ? value.results : []).map(lockResult),
  };
}

export function enforceAnalysisModeSafety(value, context = {}) {
  return String(context?.analysisMode || value?.analysisMode || SHADOW_ANALYSIS_MODE).toUpperCase() === FORMAL_ANALYSIS_MODE
    ? value
    : enforceShadowAnalysisSafety(value, context);
}
`;
if (!source.includes(before)) throw new Error('shadow safety anchor missing');
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('V10.1 shadow safety patched');
