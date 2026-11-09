import { SOCCER_PROBABILITY_AUDIT_VERSION, SOCCER_PROBABILITY_AUDIT_BIN_EDGES } from './probability-audit.js';

const classes = ['home', 'draw', 'away'];
const count = value => Number.isSafeInteger(value) && value >= 0;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = () => { throw Error('SOCCER_PROBABILITY_AUDIT_AGGREGATION_INVALID'); };
const close = (a, b, scale = 1) => finite(a) && finite(b) && Math.abs(a - b) <= 1e-10 * Math.max(1, scale);
const summarize = bins => {
  const n = bins.reduce((sum, b) => sum + b.count, 0);
  return { ECE_L1: n ? bins.reduce((sum, b) => sum + Math.abs(b.sumPredicted - b.sumObserved), 0) / n : null,
    REL_L2: n ? bins.reduce((sum, b) => sum + (b.count ? (b.sumPredicted - b.sumObserved) ** 2 / b.count : 0), 0) / n : null,
    MCE_Linf: n ? Math.max(...bins.filter(b => b.count).map(b => Math.abs(b.sumPredicted - b.sumObserved) / b.count)) : null };
};
function validated(audit, expected) {
  if (!audit || audit.version !== SOCCER_PROBABILITY_AUDIT_VERSION || audit.formalEnabled !== false
    || audit.binning?.method !== 'FIXED_WIDTH' || audit.binning.lastUpperInclusive !== true
    || audit.binning.probabilityRounding !== false || !same(audit.binning.edges, SOCCER_PROBABILITY_AUDIT_BIN_EDGES)) fail();
  const scope = Object.fromEntries(['league', 'period', 'fold', 'modelHash'].map(key => [key, expected[key] ?? audit[key]]));
  if (!['epl', 'ucl'].includes(scope.league) || !['REGULATION_FT', 'REGULATION_HT'].includes(scope.period)
    || scope.fold !== 'CALIBRATION_PROSPECTIVE_FROZEN' || !/^[a-f0-9]{64}$/.test(scope.modelHash || '')
    || Object.keys(scope).some(key => audit[key] != null && audit[key] !== scope[key])) fail();
  const c = audit.cohort;
  if (!c || !['sample', 'used', 'excluded', 'uniqueGames', 'usedUniqueGames', 'duplicateRecords', 'missingIdentityRecords'].every(k => count(c[k]))
    || c.unit !== 'INPUT_EVALUATION_RECORD' || c.independenceAssumed !== false || c.sample !== c.used + c.excluded
    || c.duplicateRecords !== 0 || c.missingIdentityRecords !== 0 || c.uniqueGames !== c.sample || c.usedUniqueGames !== c.used
    || !close(c.coverage, c.sample ? c.used / c.sample : 0) || audit.pooledEventCount !== c.used * 3) fail();
  const gameKeys = (keys, n) => Array.isArray(keys) && keys.length === n && new Set(keys).size === n
    && keys.every(key => typeof key === 'string' && new RegExp(`^${scope.league}:\\d{1,16}$`).test(key));
  if (!gameKeys(audit.sampleGameKeys, c.sample) || !gameKeys(audit.memberGameKeys, c.used)
    || audit.memberGameKeys.some(key => !audit.sampleGameKeys.includes(key))) fail();
  if (!Array.isArray(c.reasons) || new Set(c.reasons.map(r => r.code)).size !== c.reasons.length
    || c.reasons.some(r => !/^[A-Z][A-Z0-9_]{1,100}$/.test(r.code || '') || !count(r.count))
    || c.reasons.reduce((sum, r) => sum + r.count, 0) !== c.excluded) fail();
  if (!Array.isArray(audit.composition) || audit.composition.length !== (c.used ? 1 : 0)
    || audit.composition.some(row => Object.keys(scope).some(k => row[k] !== scope[k]) || !count(row.count))
    || audit.composition.reduce((sum, row) => sum + row.count, 0) !== c.used
    || !audit.missingMetadata || Object.keys(scope).some(k => audit.missingMetadata[k] !== 0)) fail();
  for (const key of classes) {
    const value = audit.classes?.[key], bins = value?.bins;
    if (!value || value.count !== c.used || !count(value.positiveCount) || value.positiveCount > c.used || !Array.isArray(bins) || bins.length !== 10) fail();
    for (const [index, b] of bins.entries()) {
      if (b.index !== index || b.lower !== index / 10 || b.upper !== (index + 1) / 10 || b.upperInclusive !== (index === 9)
        || !count(b.count) || !count(b.sumObserved) || b.sumObserved > b.count || !finite(b.sumPredicted)
        || b.sumPredicted < 0 || b.sumPredicted > b.count + 1e-10 * Math.max(1, b.count)
        || b.sumPredicted < b.lower * b.count - 1e-10 * Math.max(1, b.count)
        || b.sumPredicted > b.upper * b.count + 1e-10 * Math.max(1, b.count)
        || (b.count ? !close(b.meanPredicted, b.sumPredicted / b.count) || !close(b.observedFrequency, b.sumObserved / b.count)
          : b.sumPredicted !== 0 || b.sumObserved !== 0 || b.meanPredicted !== null || b.observedFrequency !== null)) fail();
    }
    if (bins.reduce((sum, b) => sum + b.count, 0) !== c.used || bins.reduce((sum, b) => sum + b.sumObserved, 0) !== value.positiveCount) fail();
    const derived = summarize(bins);
    for (const k of ['ECE_L1', 'REL_L2']) if (derived[k] === null ? value[k] !== null : !close(value[k], derived[k])) fail();
    if (Object.hasOwn(value, 'MCE_Linf') && (derived.MCE_Linf === null ? value.MCE_Linf !== null : !close(value.MCE_Linf, derived.MCE_Linf))) fail();
  }
  if (classes.reduce((sum, k) => sum + audit.classes[k].positiveCount, 0) !== c.used) fail();
  const mass = audit.probabilityMass, exact = audit.exactScoreEvidence;
  if (!mass || mass.renormalized !== false || mass.tolerance !== 1e-10 || mass.smallTailTolerance !== 1e-10
    || !count(mass.knownTailCount) || !count(mass.tailAffectedGames) || mass.tailAffectedGames > mass.knownTailCount || mass.knownTailCount > c.used
    || (mass.knownTailCount ? !finite(mass.maxTailMass) || mass.maxTailMass < 0
      || mass.maxTailMass > mass.smallTailTolerance : mass.maxTailMass !== null)
    || !exact || !['available', 'zeroModelProbability', 'unavailable', 'invalid'].every(k => count(exact[k]))
    || exact.available + exact.unavailable + exact.invalid !== c.used || exact.zeroModelProbability > exact.available) fail();
  // The producer permits one tolerance for p-sum vs retained mass, one for
  // retained+tail vs one, and at most one small omitted tail per observation.
  // Preserve that existing envelope without normalizing any probability.
  const probabilitySum = classes.reduce((sum, key) => sum + audit.classes[key].bins.reduce((s, b) => s + b.sumPredicted, 0), 0);
  if (!finite(probabilitySum) || Math.abs(probabilitySum - c.used) > 3 * mass.tolerance * Math.max(1, c.used)) fail();
  return { ...audit, ...scope };
}

/** Merge disjoint, fully replayed whole-game audits using their sufficient
 * statistics. Identities originate at trusted source/capture replay; this
 * client-safe validation grants no source, model or acceptance authority. */
export function mergeSoccerProbabilityAudits(left, right, expected = {}) {
  const b = validated(right, expected), a = left == null ? null : validated(left, b);
  if (a && a.sampleGameKeys.some(key => b.sampleGameKeys.includes(key))) fail();
  const n = k => (a?.cohort[k] || 0) + b.cohort[k], used = n('used'), sample = n('sample');
  const reasons = new Map();
  for (const r of [...(a?.cohort.reasons || []), ...b.cohort.reasons]) {
    const old = reasons.get(r.code); reasons.set(r.code, { ...r, count: r.count + (old?.count || 0) });
  }
  const combined = {};
  for (const key of classes) {
    const bins = b.classes[key].bins.map((bin, i) => {
      const old = a?.classes[key].bins[i], count = (old?.count || 0) + bin.count,
        sumPredicted = (old?.sumPredicted || 0) + bin.sumPredicted, sumObserved = (old?.sumObserved || 0) + bin.sumObserved;
      return { ...bin, count, sumPredicted, sumObserved, meanPredicted: count ? sumPredicted / count : null,
        observedFrequency: count ? sumObserved / count : null };
    });
    combined[key] = { count: used, positiveCount: (a?.classes[key].positiveCount || 0) + b.classes[key].positiveCount, bins, ...summarize(bins) };
  }
  const known = (a?.probabilityMass.knownTailCount || 0) + b.probabilityMass.knownTailCount;
  return { ...b, cohort: { ...b.cohort, sample, used, excluded: n('excluded'), coverage: sample ? used / sample : 0,
      uniqueGames: n('uniqueGames'), usedUniqueGames: n('usedUniqueGames'), reasons: [...reasons.values()].sort((x, y) => x.code.localeCompare(y.code)) },
    pooledEventCount: used * 3, classes: combined,
    sampleGameKeys: [...(a?.sampleGameKeys || []), ...b.sampleGameKeys].sort(), memberGameKeys: [...(a?.memberGameKeys || []), ...b.memberGameKeys].sort(),
    composition: used ? [{ league: b.league, period: b.period, fold: b.fold, modelHash: b.modelHash, count: used }] : [],
    probabilityMass: { ...b.probabilityMass, knownTailCount: known,
      tailAffectedGames: (a?.probabilityMass.tailAffectedGames || 0) + b.probabilityMass.tailAffectedGames,
      maxTailMass: known ? Math.max(a?.probabilityMass.maxTailMass ?? 0, b.probabilityMass.maxTailMass ?? 0) : null },
    exactScoreEvidence: Object.fromEntries(['available', 'zeroModelProbability', 'unavailable', 'invalid']
      .map(k => [k, (a?.exactScoreEvidence[k] || 0) + b.exactScoreEvidence[k]])), formalEnabled: false };
}
