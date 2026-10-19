// Pure descriptive diagnostics. Safe to import from server code or client views.
export const SOCCER_PROBABILITY_AUDIT_VERSION = 'SOCCER-CLASSWISE-PROBABILITY-AUDIT-v1';
export const SOCCER_PROBABILITY_AUDIT_BIN_EDGES = Object.freeze(Array.from({ length: 11 }, (_, i) => i / 10));
const CLASSES = ['home', 'draw', 'away'];
const MASS_TOLERANCE = 1e-10;
const finiteProbability = p => Number.isFinite(p) && p >= 0 && p <= 1;
const present = value => value !== null && value !== undefined && value !== '';
const validEventId = value => typeof value === 'string' ? value.trim().length > 0
  : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const reasonLabels = {
  SOCCER_TEAM_NOT_TRAINED: '球隊尚無可用訓練係數',
  SOCCER_MODEL_NOT_APPLICABLE: '模型與比賽或時間範圍不符',
  SOCCER_OBSERVED_SCORE_INVALID: '實際比分不合法',
  HALF_TIME_EVIDENCE_UNVERIFIED: '缺少可核對的半場比分證據',
  HALF_TIME_SCORE_INVALID: '半場與全場比分不一致',
  HALF_TIME_PREDICTION_BEFORE_CUTOFF: '比賽早於模型訓練截止',
  AUDIT_EVENT_ID_MISSING: '缺少可追溯的比賽識別',
  AUDIT_PROBABILITY_VECTOR_INVALID: '預測機率不合法',
  AUDIT_ACTUAL_OUTCOME_INVALID: '實際主和客結果不合法',
  AUDIT_PROBABILITY_MASS_UNVERIFIED: '機率總量與尾端資料不足或不一致',
  AUDIT_OMITTED_MASS_EXCEEDS_TOLERANCE: '尾端質量超過本報表容許值',
  AUDIT_SCOPE_MISMATCH: '評估紀錄與報表範圍不一致',
};

/** Preserve a true zero probability across JSON serialization; null alone is ambiguous. */
export function soccerProbabilityAuditFields(distribution, actualOutcome, exactScoreLogProbability = null) {
  const scoreState = exactScoreLogProbability === -Infinity ? 'ZERO_MODEL_PROBABILITY'
    : Number.isFinite(exactScoreLogProbability) && exactScoreLogProbability <= MASS_TOLERANCE ? 'FINITE'
      : exactScoreLogProbability === null || exactScoreLogProbability === undefined ? 'UNAVAILABLE' : 'INVALID';
  return {
    probabilities: Object.fromEntries(CLASSES.map(key => [key, distribution?.outcomes?.[key] ?? null])),
    actualOutcome,
    observedOneHot: Object.fromEntries(CLASSES.map(key => [key, key === actualOutcome ? 1 : 0])),
    retainedMass: distribution?.retainedMass ?? null,
    tailMass: distribution?.tailMass ?? null,
    exactScoreLogProbability: scoreState === 'FINITE' ? exactScoreLogProbability : null,
    exactScoreLogProbabilityState: scoreState,
    // A zero retained-grid event can still have positive probability in the tail.
    outcomeProbabilityState: distribution?.outcomes?.[actualOutcome] === 0 ? 'ZERO_RETAINED_PROBABILITY'
      : finiteProbability(distribution?.outcomes?.[actualOutcome]) ? 'FINITE' : 'UNAVAILABLE',
  };
}

function exclusion(record, scope) {
  if (record?.status !== 'EVALUATED') return record?.reason || 'UNKNOWN_EVALUATION_EXCLUSION';
  if (!validEventId(record.eventId)) return 'AUDIT_EVENT_ID_MISSING';
  if (['league', 'period', 'fold', 'modelHash'].some(key => present(scope[key]) && present(record[key]) && scope[key] !== record[key])) return 'AUDIT_SCOPE_MISMATCH';
  if (!CLASSES.includes(record.actualOutcome)) return 'AUDIT_ACTUAL_OUTCOME_INVALID';
  const p = CLASSES.map(key => record.probabilities?.[key]);
  if (!p.every(finiteProbability)) return 'AUDIT_PROBABILITY_VECTOR_INVALID';
  if (record.observedOneHot && CLASSES.some(key => record.observedOneHot[key] !== (key === record.actualOutcome ? 1 : 0))) return 'AUDIT_ACTUAL_OUTCOME_INVALID';
  const sum = p.reduce((a, b) => a + b, 0);
  const hasMass = present(record.retainedMass), hasTail = present(record.tailMass);
  if (hasMass || hasTail) {
    if (!hasMass || !hasTail || ![record.retainedMass, record.tailMass].every(x => Number.isFinite(x) && x >= 0 && x <= 1 + MASS_TOLERANCE) || Math.abs(record.retainedMass + record.tailMass - 1) > MASS_TOLERANCE || Math.abs(sum - record.retainedMass) > MASS_TOLERANCE) return 'AUDIT_PROBABILITY_MASS_UNVERIFIED';
    if (record.tailMass > MASS_TOLERANCE) return 'AUDIT_OMITTED_MASS_EXCEEDS_TOLERANCE';
  } else if (Math.abs(sum - 1) > MASS_TOLERANCE) return 'AUDIT_PROBABILITY_MASS_UNVERIFIED';
  return null;
}

/** Fixed, left-closed bins; the last bin also contains p=1. No rounding or rescaling. */
function binIndex(p) {
  for (let i = 0; i < 9; i++) if (p < SOCCER_PROBABILITY_AUDIT_BIN_EDGES[i + 1]) return i;
  return 9;
}

export function buildSoccerProbabilityAudit(records, { league = null, period = null, fold = null, modelHash = null } = {}) {
  if (!Array.isArray(records)) throw Error('SOCCER_PROBABILITY_AUDIT_INPUT_INVALID');
  const scope = { league, period, fold, modelHash }, reasons = new Map(), allGames = new Set(), usedGames = new Set(), compositions = new Map();
  const classes = Object.fromEntries(CLASSES.map(key => [key, { count: 0, positiveCount: 0, bins: Array.from({ length: 10 }, (_, index) => ({ index, lower: index / 10, upper: (index + 1) / 10, upperInclusive: index === 9, count: 0, sumPredicted: 0, sumObserved: 0 })) }]));
  const missingMetadata = { league: 0, period: 0, fold: 0, modelHash: 0 };
  const exactScoreEvidence = { available: 0, zeroModelProbability: 0, unavailable: 0, invalid: 0 };
  let used = 0, identifiedRecords = 0, tailAffectedGames = 0, knownTailCount = 0, maxTailMass = 0;
  for (const record of records) {
    const identity = validEventId(record?.eventId) ? `${record.league ?? league ?? 'UNKNOWN'}:${record.eventId}` : null;
    if (identity) { allGames.add(identity); identifiedRecords++; }
    const reason = exclusion(record, scope);
    if (reason) { reasons.set(reason, (reasons.get(reason) || 0) + 1); continue; }
    used++; usedGames.add(identity);
    const composition = Object.fromEntries(['league', 'period', 'fold', 'modelHash'].map(key => [key, record[key] ?? null]));
    for (const key of Object.keys(missingMetadata)) if (!present(record[key])) missingMetadata[key]++;
    const compositionKey = JSON.stringify(composition), existing = compositions.get(compositionKey);
    if (existing) existing.count++; else compositions.set(compositionKey, { ...composition, count: 1 });
    if (present(record.tailMass)) { knownTailCount++; maxTailMass = Math.max(maxTailMass, record.tailMass); if (record.tailMass > 0) tailAffectedGames++; }
    const state = record.exactScoreLogProbabilityState;
    if ((state === 'ZERO_MODEL_PROBABILITY' && (record.exactScoreLogProbability === null || record.exactScoreLogProbability === -Infinity)) || (!state && record.exactScoreLogProbability === -Infinity)) { exactScoreEvidence.available++; exactScoreEvidence.zeroModelProbability++; }
    else if (Number.isFinite(record.exactScoreLogProbability) && record.exactScoreLogProbability <= MASS_TOLERANCE && (!state || state === 'FINITE')) exactScoreEvidence.available++;
    else if (state === 'INVALID' || present(record.exactScoreLogProbability)) exactScoreEvidence.invalid++;
    else exactScoreEvidence.unavailable++;
    for (const key of CLASSES) {
      const c = classes[key], p = record.probabilities[key], y = key === record.actualOutcome ? 1 : 0, b = c.bins[binIndex(p)];
      c.count++; c.positiveCount += y; b.count++; b.sumPredicted += p; b.sumObserved += y;
    }
  }
  for (const c of Object.values(classes)) {
    c.ECE_L1 = c.count ? c.bins.reduce((sum, b) => sum + Math.abs(b.sumPredicted - b.sumObserved) / c.count, 0) : null;
    c.REL_L2 = c.count ? c.bins.reduce((sum, b) => sum + (b.count ? (b.sumPredicted - b.sumObserved) ** 2 / b.count / c.count : 0), 0) : null;
    c.bins = c.bins.map(b => ({ ...b, meanPredicted: b.count ? b.sumPredicted / b.count : null, observedFrequency: b.count ? b.sumObserved / b.count : null }));
  }
  return {
    version: SOCCER_PROBABILITY_AUDIT_VERSION, ...scope,
    cohort: { unit: 'INPUT_EVALUATION_RECORD', sample: records.length, used, excluded: records.length - used, coverage: records.length ? used / records.length : 0, uniqueGames: allGames.size, usedUniqueGames: usedGames.size, duplicateRecords: identifiedRecords - allGames.size, missingIdentityRecords: records.length - identifiedRecords, reasons: [...reasons].sort(([a], [b]) => a.localeCompare(b)).map(([code, count]) => ({ code, label: reasonLabels[code] || '資料不足或驗證未通過', count })), independenceAssumed: false },
    pooledEventCount: used * 3, classes,
    binning: { method: 'FIXED_WIDTH', edges: [...SOCCER_PROBABILITY_AUDIT_BIN_EDGES], lastUpperInclusive: true, probabilityRounding: false },
    probabilityMass: { tolerance: MASS_TOLERANCE, smallTailTolerance: MASS_TOLERANCE, renormalized: false, knownTailCount, tailAffectedGames, maxTailMass: knownTailCount ? maxTailMass : null, interpretation: 'Only complete vectors or known omitted mass <= tolerance enter class bins. Original probabilities are unchanged; larger or unverified missing mass is audit-excluded with its reason.' },
    composition: [...compositions].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value), missingMetadata, exactScoreEvidence,
    interpretation: 'CLASSWISE_FIXED_BIN_DESCRIPTIVE_CALIBRATION_NOT_A_PROMOTION_OR_PIT_CERTIFICATE',
    estimator: { ECE_L1: 'sum_b(n_b/N)*abs(mean_p_b-mean_y_b)', REL_L2: 'sum_b(n_b/N)*(mean_p_b-mean_y_b)^2', biasCorrected: false, fullMurphyDecomposition: false, uncertaintyInterval: null, uncertaintyReason: 'No independence or sampling-design guarantee; bin counts and duplicate-game evidence are reported.' },
    formalEnabled: false,
  };
}
