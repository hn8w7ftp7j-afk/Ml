// Server-side sufficient statistics for disjoint whole-game scan contributions.
// The durable scanner owns the fixed cutoff, lexical game boundary and CAS.
// These aggregates are descriptive research; they never authorize W/R/S.
const clone = value => structuredClone(value);
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const assertSame = (a, b, label) => { if (stable(a) !== stable(b)) throw Error(`SOCCER_SCAN_AGGREGATE_${label}_MISMATCH`); };
const count = value => { if (!Number.isSafeInteger(value) || value < 0) throw Error('SOCCER_SCAN_AGGREGATE_COUNT_INVALID'); return value; };
const add = (a = 0, b = 0) => count(count(a) + count(b));
const sumCounts = (a = {}, b = {}) => Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].sort()
  .map(key => [key, add(a[key], b[key])]));
function mean(a, an, b, bn) {
  if (an && !Number.isFinite(a) || bn && !Number.isFinite(b)) throw Error('SOCCER_SCAN_AGGREGATE_METRIC_INVALID');
  return an + bn ? ((an ? a * an : 0) + (bn ? b * bn : 0)) / (an + bn) : null;
}
function mergeCountRows(a = [], b = [], keyOf) {
  const rows = new Map(a.map(row => [keyOf(row), clone(row)]));
  for (const row of b) { const key = keyOf(row), previous = rows.get(key); rows.set(key, previous ? { ...previous, count: add(previous.count, row.count) } : clone(row)); }
  return [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row);
}
export function mergeSoccerForwardProbabilityAudits(a, b) {
  for (const audit of [a, b].filter(Boolean)) if (audit.formalEnabled !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  if (!a) return clone(b); if (!b) return clone(a);
  for (const key of ['version', 'league', 'period', 'fold', 'modelHash', 'binning', 'interpretation', 'estimator']) assertSame(a[key], b[key], key.toUpperCase());
  if (a.formalEnabled !== false || b.formalEnabled !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  const result = { ...clone(a) }, cohort = { ...a.cohort };
  for (const key of ['unit', 'independenceAssumed']) assertSame(a.cohort[key], b.cohort[key], key.toUpperCase());
  for (const key of ['sample', 'used', 'excluded', 'uniqueGames', 'usedUniqueGames', 'duplicateRecords', 'missingIdentityRecords']) cohort[key] = add(a.cohort[key], b.cohort[key]);
  cohort.coverage = cohort.sample ? cohort.used / cohort.sample : 0;
  cohort.reasons = mergeCountRows(a.cohort.reasons, b.cohort.reasons, row => row.code);
  result.cohort = cohort;
  result.pooledEventCount = add(a.pooledEventCount, b.pooledEventCount);
  result.classes = Object.fromEntries(['home', 'draw', 'away'].map(key => {
    const x = a.classes[key], y = b.classes[key], n = add(x.count, y.count);
    if (x.bins.length !== 10 || y.bins.length !== 10) throw Error('SOCCER_SCAN_AGGREGATE_BINS_INVALID');
    const bins = x.bins.map((bin, i) => {
      const other = y.bins[i];
      for (const field of ['index', 'lower', 'upper', 'upperInclusive']) assertSame(bin[field], other[field], `BIN_${field.toUpperCase()}`);
      const total = add(bin.count, other.count), sumPredicted = bin.sumPredicted + other.sumPredicted, sumObserved = add(bin.sumObserved, other.sumObserved);
      if (!Number.isFinite(sumPredicted)) throw Error('SOCCER_SCAN_AGGREGATE_METRIC_INVALID');
      return { ...bin, count: total, sumPredicted, sumObserved, meanPredicted: total ? sumPredicted / total : null, observedFrequency: total ? sumObserved / total : null };
    });
    return [key, { count: n, positiveCount: add(x.positiveCount, y.positiveCount), bins,
      ECE_L1: n ? bins.reduce((sum, bin) => sum + Math.abs(bin.sumPredicted - bin.sumObserved) / n, 0) : null,
      REL_L2: n ? bins.reduce((sum, bin) => sum + (bin.count ? (bin.sumPredicted - bin.sumObserved) ** 2 / bin.count / n : 0), 0) : null }];
  }));
  for (const key of ['tolerance', 'smallTailTolerance', 'renormalized', 'interpretation']) assertSame(a.probabilityMass[key], b.probabilityMass[key], `MASS_${key.toUpperCase()}`);
  const mass = { ...a.probabilityMass };
  for (const key of ['knownTailCount', 'tailAffectedGames']) mass[key] = add(a.probabilityMass[key], b.probabilityMass[key]);
  mass.maxTailMass = mass.knownTailCount ? Math.max(a.probabilityMass.maxTailMass ?? 0, b.probabilityMass.maxTailMass ?? 0) : null;
  result.probabilityMass = mass;
  result.composition = mergeCountRows(a.composition, b.composition, row => stable([row.league, row.period, row.fold, row.modelHash]));
  result.missingMetadata = sumCounts(a.missingMetadata, b.missingMetadata);
  result.exactScoreEvidence = sumCounts(a.exactScoreEvidence, b.exactScoreEvidence);
  return result;
}
function detail(group) {
  if (group.probabilityAudit?.formalEnabled !== false || group.properScores?.probabilitiesRenormalized !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  const observations = group.observations || [], total = group.observationDetailCount ?? group.evaluatedGames ?? observations.length;
  return { ...clone(group), observations: clone(observations.slice(0, 100)), observationDetailCount: total,
    observationDetailLimit: 100, observationDetailsTruncated: total > Math.min(observations.length, 100) };
}
function mergeGroup(a, b) {
  if (!a) return detail(b);
  if (a.probabilityAudit?.formalEnabled !== false || b.probabilityAudit?.formalEnabled !== false
      || a.properScores?.probabilitiesRenormalized !== false || b.properScores?.probabilitiesRenormalized !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  for (const key of ['league', 'period', 'variant', 'modelHash', 'modelVersion']) assertSame(a[key], b[key], key.toUpperCase());
  const result = { ...clone(a) };
  for (const key of ['receivedSnapshotPeriods', 'excludedSnapshotPeriods', 'laterReanalysesNotSelected', 'capturedGames', 'evaluatedGames', 'pendingGames']) result[key] = add(a[key], b[key]);
  for (const key of ['excludedReasons', 'pendingReasons']) result[key] = sumCounts(a[key], b[key]);
  const x = a.properScores, y = b.properScores, n = add(x.count, y.count), infinities = add(x.infiniteLogLossCount, y.infiniteLogLossCount);
  result.properScores = { count: n, brier: mean(x.brier, x.count, y.brier, y.count),
    logLoss: infinities ? null : mean(x.logLoss, x.count, y.logLoss, y.count),
    logLossState: !n ? 'NO_SAMPLES' : infinities ? 'POSITIVE_INFINITY' : 'FINITE', infiniteLogLossCount: infinities,
    scoreLogLoss: mean(x.scoreLogLoss, x.exactScoreCount, y.scoreLogLoss, y.exactScoreCount),
    exactScoreCount: add(x.exactScoreCount, y.exactScoreCount), exactScoreExcluded: add(x.exactScoreExcluded, y.exactScoreExcluded), probabilitiesRenormalized: false };
  result.probabilityAudit = mergeSoccerForwardProbabilityAudits(a.probabilityAudit, b.probabilityAudit);
  const observations = [...(a.observations || []), ...(b.observations || [])];
  result.observationDetailCount = add(a.observationDetailCount ?? a.evaluatedGames, b.observationDetailCount ?? b.evaluatedGames);
  result.observationDetailLimit = 100;
  result.observations = observations.slice(0, 100);
  result.observationDetailsTruncated = result.observationDetailCount > result.observations.length;
  return result;
}
function mergeReturns(a, b) {
  for (const report of [a, b].filter(Boolean)) {
    for (const key of ['formalEligible', 'calibrationEligible', 'promotionEligible', 'executable']) if (report[key] !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
    for (const key of ['W', 'R', 'S', 'empiricalErrorMargin']) if (report[key] !== null) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  }
  if (!a) return clone(b); if (!b) return clone(a);
  for (const key of ['version', 'selection', 'interpretation']) assertSame(a[key], b[key], `RETURN_${key.toUpperCase()}`);
  const result = { ...clone(a) };
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (typeof a[key] === 'number' || typeof b[key] === 'number') result[key] = add(a[key], b[key]);
  }
  for (const key of ['pendingReasons', 'predictionPeriodReasons']) result[key] = sumCounts(a[key], b[key]);
  result.evidenceTruncated = a.evidenceTruncated === true || b.evidenceTruncated === true;
  result.readCoverage = null; // Whole-scan byte/row counters are owned by the scanner.
  for (const key of ['W', 'R', 'S', 'empiricalErrorMargin']) result[key] = null;
  for (const key of ['formalEligible', 'calibrationEligible', 'promotionEligible', 'executable']) {
    if (a[key] !== false || b[key] !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
    result[key] = false;
  }
  return result;
}
function mergeErrorResearch(a, b) {
  for (const report of [a, b].filter(Boolean)) {
    for (const key of ['accepted', 'formalEligible', 'calibrationEligible', 'promotionEligible', 'executable']) if (report[key] !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
    for (const key of ['W', 'R', 'S', 'empiricalErrorMargin']) if (report[key] !== null) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  }
  if (!a) return clone(b); if (!b) return clone(a);
  for (const key of ['version', 'interpretation']) assertSame(a[key], b[key], `ERROR_${key.toUpperCase()}`);
  const result = { ...clone(a) };
  for (const key of ['selectedQuoteObservations', 'checkedQuoteObservations', 'uncheckedQuoteObservations', 'observedQuoteReturns', 'observedGames', 'quarantinedGames']) result[key] = add(a[key], b[key]);
  result.excludedReasons = sumCounts(a.excludedReasons, b.excludedReasons);
  result.completeWithinRequestedScope = a.completeWithinRequestedScope === true && b.completeWithinRequestedScope === true;
  result.status = result.observedQuoteReturns ? 'RESEARCH_OBSERVATIONS_AVAILABLE' : 'MISSING_OBSERVATIONS';
  return result;
}
/** Merge only whole-game contributions proven disjoint by the durable scanner.
 * Display detail caps never truncate counters, class bins, proper scores or returns.
 * A result remains incomplete once any original/history was unreadable. The
 * scanner additionally keeps complete=false until its frozen scope is terminal. */
export function mergeSoccerForwardGameReport(previous, next) {
  if (!next) return previous ? clone(previous) : null;
  if (next.formalEligible !== false || next.promotionEligible !== false || next.executable !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  if (!previous) return { ...clone(next), groups: (next.groups || []).map(detail),
    ...(next.marketReturnValidation ? { marketReturnValidation: mergeReturns(null, next.marketReturnValidation) } : {}),
    ...(next.returnErrorResearch ? { returnErrorResearch: mergeErrorResearch(null, next.returnErrorResearch) } : {}) };
  for (const key of ['version', 'protocol', 'canonicalRule', 'denominator', 'interpretation', 'sourceLimitations', 'strictHistoricalPit']) assertSame(previous[key], next[key], key.toUpperCase());
  if (previous.formalEligible !== false || previous.promotionEligible !== false || previous.executable !== false) throw Error('SOCCER_SCAN_AGGREGATE_PROMOTION_REJECTED');
  const result = { ...clone(previous) };
  for (const key of ['capturedSnapshotPeriods', 'selectedGameModelPeriods', 'excludedSnapshotPeriods', 'laterReanalysesNotSelected', 'uniqueSelectedGames', 'evaluatedGameModelPeriods', 'conflictingResultCaptures']) result[key] = add(previous[key], next[key]);
  result.excludedReasons = sumCounts(previous.excludedReasons, next.excludedReasons);
  const keyOf = row => stable([row.league, row.period, row.variant, row.modelHash]);
  const groups = new Map(previous.groups.map(group => [keyOf(group), clone(group)]));
  for (const group of next.groups) groups.set(keyOf(group), mergeGroup(groups.get(keyOf(group)), group));
  result.groups = [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
  result.status = result.evaluatedGameModelPeriods ? 'FORWARD_OBSERVATIONS_AVAILABLE' : 'AWAITING_PROSPECTIVE_RESULTS';
  result.truncated = previous.truncated === true || next.truncated === true;
  result.complete = previous.complete === true && next.complete === true && !result.truncated;
  result.readAt = next.readAt;
  result.readCoverage = null;
  if (previous.marketReturnValidation || next.marketReturnValidation) result.marketReturnValidation = mergeReturns(previous.marketReturnValidation, next.marketReturnValidation);
  if (previous.returnErrorResearch || next.returnErrorResearch) result.returnErrorResearch = mergeErrorResearch(previous.returnErrorResearch, next.returnErrorResearch);
  return result;
}
