import { createHash } from 'node:crypto';
import '../../reader/league-registry.js';
import { deterministicScore, scoreBoundaryAudit, SCORE_FORMULA_VERSION } from '../deterministic-score.js';
import { wrGapWarning } from '../wr-gap-warning.js';
import { evaluateSoccerQuote } from './market-payoff.js';
import { soccerVerifiedSettlementContract } from './settlement-contract.js';
import { validSoccerDate, soccerDate } from './contracts.js';

export const SOCCER_SCORING_VERSION = 'SOCCER-TRACEABLE-SCENARIO-SCORE-v2';
export const SOCCER_SCENARIO_ARITHMETIC_VERSION = 'SOCCER-EXPLICIT-SCENARIO-RETURNS-v1';
const EPS = 1e-10, periods = { FT: 'REGULATION_FT', HT: 'REGULATION_HT' };
const outcomes = ['FULL_WIN', 'PARTIAL_WIN', 'PUSH', 'PARTIAL_LOSS', 'FULL_LOSS'];
const finite = value => typeof value === 'number' && Number.isFinite(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const soccerScoringHash = value => createHash('sha256').update(canonical(value) ?? 'null').digest('hex');
const detached = value => value == null ? value : JSON.parse(JSON.stringify(value));
const unique = values => [...new Set(values.filter(Boolean))];
const failed = (code, details = {}) => ({ ok: false, code, reasons: [code], ...details });

// Registration is server-owned and requires actual independently reviewed artifacts.
// Retrospective development diagnostics and caller-supplied VERIFIED flags are not
// registrations. There are currently no accepted football model/uncertainty artifacts.
const acceptedArtifacts = Object.freeze([]);
const acceptanceKinds = ['model', 'calibration', 'uncertainty'];

function sourceKnown(source, cutoff) {
  if (!source || !sha(source.contentHash) || typeof source.provider !== 'string' || !source.provider.trim()) return false;
  try { const url = new URL(source.url); if (url.protocol !== 'https:' || url.username || url.password) return false; } catch { return false; }
  const times = [source.sourcePublishedAt, source.fetchedAt, source.availableAt].map(instant);
  return times.every(time => Number.isFinite(time) && time <= cutoff) && times[0] <= times[1] && times[1] <= times[2];
}

/** Adapt only the original, fresh, explicitly scoped and server-persisted Reader quote. */
export function adaptSoccerReaderQuote({ quote, game, now = Date.now() } = {}) {
  if (!finite(now) || !['epl', 'ucl'].includes(game?.league) || typeof game?.sourceId !== 'string' || !/^\d{1,16}$/.test(game.sourceId)
      || game.id !== `soccer:${game.league}:${game.sourceId}` || !validSoccerDate(game.date)
      || !Number.isFinite(instant(game.startTime)) || soccerDate(game.startTime) !== game.date
      || ![game.home?.sourceId, game.away?.sourceId].every(id => typeof id === 'string' && /^\d{1,16}$/.test(id))
      || game.home.sourceId === game.away.sourceId) return failed('SOCCER_SCORE_GAME_IDENTITY_INVALID');
  if (game.status !== 'scheduled' || !(instant(game.startTime) > now)) return failed('SOCCER_SCORE_NOT_PREMATCH');
  if (!quote || !Object.hasOwn(periods, quote.period) || quote.unit !== 'GOALS'
      || !['HANDICAP', 'TOTAL'].includes(quote.kind) || typeof quote.line !== 'string' || quote.line.trim() !== quote.line
      || !/^\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?(?:平|[+-]\d{1,3})?$/.test(quote.line)
      || !finite(quote.water) || quote.water <= 0 || quote.water > 1000
      || !Array.isArray(quote.rawRows) || !quote.rawRows.length || quote.rawRows.length > 100
      || quote.rawRows.some(row => typeof row !== 'string' || row.length > 10000)
      || quote.kind === 'HANDICAP' && (!['home', 'away'].includes(quote.side) || !['home', 'away'].includes(quote.lineSide))
      || quote.kind === 'TOTAL' && (!['over', 'under'].includes(quote.side) || quote.lineSide != null)) return failed('SOCCER_SCORE_READER_QUOTE_INVALID');
  const proof = quote.provenance, heading = proof?.periodEvidence;
  const parsed = globalThis.Tai888LeagueRegistry.soccerPeriodEvidence({ sectionTitle: heading?.sectionTitle,
    headers: heading?.tableHeaders, marketHeader: heading?.marketHeader, truncated: heading?.truncated });
  if (parsed.status !== 'EXPLICIT' || parsed.period !== quote.period || heading?.status !== 'EXPLICIT'
      || heading?.period !== quote.period || proof?.gameId !== game.id) return failed('SOCCER_SCORE_READER_SCOPE_INVALID');
  if (!sha(proof.readerRevision) || !sha(proof.readerObservationId)) return failed('SOCCER_SCORE_READER_RECEIPT_MISSING');
  const [observed, firstFetched, received, persisted] = [proof.observedAt, proof.firstFetchedAt, proof.receivedAt, proof.persistedAt].map(instant);
  if (![observed, firstFetched, received, persisted].every(time => Number.isFinite(time) && time <= now)
      || firstFetched > received || received > persisted || now - observed >= 180000
      || quote.fresh !== true || quote.prestart !== true) return failed('SOCCER_SCORE_READER_TIME_INVALID');
  try {
    const url = new URL(proof.sourceUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== proof.sourceHost
        || !(url.hostname === 'tai888.in' || url.hostname.endsWith('.tai888.in'))) throw Error();
  } catch { return failed('SOCCER_SCORE_READER_SOURCE_INVALID'); }
  const marketKey = [game.id, quote.period, quote.kind, quote.line, quote.lineSide || '', quote.side].join(':');
  // Reconstruct the original adapter's field order, including the parsed heading.
  // JSONB key reordering must neither invalidate a real quote nor bypass its hash.
  const provenance = Object.fromEntries(['gameId', 'readerRevision', 'readerObservationId', 'observedAt', 'firstFetchedAt',
    'receivedAt', 'persistedAt', 'sourceHost', 'sourceUrl'].map(key => [key, proof[key] ?? null]));
  provenance.periodEvidence = parsed;
  const expectedKey = createHash('sha256').update(JSON.stringify({ marketKey, water: quote.water, rawRows: quote.rawRows, provenance })).digest('hex');
  if (quote.marketKey !== marketKey || quote.key !== expectedKey || quote.sourceQuoteKey !== expectedKey) return failed('SOCCER_SCORE_READER_QUOTE_HASH_MISMATCH');
  return { ok: true, quote: { period: quote.period, kind: quote.kind, direction: quote.side.toUpperCase(),
    sourceLine: quote.line, lineSide: quote.lineSide ?? null, water: quote.water, waterFormat: 'PROFIT_PER_UNIT' },
    sourceQuoteKey: quote.key, marketKey, provenance: detached(provenance) };
}

function contractForPayoff(contract, game) {
  if (!contract) return null;
  if (!contract.rebate?.appliesTo) return detached(contract);
  if (contract.rebate.rate !== .01 || contract.rebate.basis !== 'TOTAL_PRINCIPAL'
      || outcomes.some(outcome => typeof contract.rebate.appliesTo[outcome] !== 'boolean')) return null;
  return { type: contract.type, period: contract.period, rebate: { rate: 0, basis: 'NONE' },
    labelMapping: { home: game?.home?.name, away: game?.away?.name },
    provenance: { status: 'ASSUMPTION', note: 'Explicit per-outcome terms; arithmetic is not source approval' } };
}

function conditionalPayoff(quote, distribution, contract, game) {
  if (contract && (contract.league !== undefined && contract.league !== game?.league
      || contract.kind !== undefined && contract.kind !== quote?.kind
      || contract.line !== undefined && contract.line !== quote?.sourceLine)) return {
    ...failed('SOCCER_SCORE_CONTRACT_SCOPE_MISMATCH'), status: 'NOT_CALCULABLE', netEV: null, grossEV: null,
    retainedEV: null, evBounds: null, probabilities: null, rows: [] };
  const result = evaluateSoccerQuote({ quote, distribution, contract: contractForPayoff(contract, game) });
  if (!result.ok) return result;
  if (contract?.rebate?.appliesTo) {
    result.rows = result.rows.map(row => { const rebatePerUnit = contract.rebate.appliesTo[row.outcome] ? contract.rebate.rate : 0;
      return { ...row, rebatePerUnit, netPerUnit: row.grossPerUnit + rebatePerUnit }; });
    result.retainedEV.rebate = result.rows.reduce((sum, row) => sum + row.probability * row.rebatePerUnit, 0);
    result.retainedEV.net = result.retainedEV.gross + result.retainedEV.rebate;
    const rebate = outcome => contract.rebate.appliesTo[outcome] ? contract.rebate.rate : 0;
    const possible = [quote.water + rebate('FULL_WIN'), rebate('PARTIAL_WIN'), quote.water + rebate('PARTIAL_WIN'),
      rebate('PUSH'), -1 + rebate('PARTIAL_LOSS'), rebate('PARTIAL_LOSS'), -1 + rebate('FULL_LOSS')];
    const range = { min: Math.min(...possible), max: Math.max(...possible) };
    // A proven settlement-invariant tail is a separate outcome contribution,
    // not a score row. Apply the actual outcome's rebate rule to it as well.
    if (result.tailSettlement) {
      const tail = result.tailSettlement, rebatePerUnit = rebate(tail.outcome);
      tail.rebatePerUnit = rebatePerUnit;
      tail.netPerUnit = tail.grossPerUnit + rebatePerUnit;
      tail.contribution.rebate = tail.probability * rebatePerUnit;
      tail.contribution.net = tail.probability * tail.netPerUnit;
    }
    const unresolved = result.unresolvedTailMass ?? result.tailMass;
    const net = result.retainedEV.net + (result.tailSettlement?.contribution.net || 0);
    const rebateValue = result.retainedEV.rebate + (result.tailSettlement?.contribution.rebate || 0);
    result.evBounds.net = { lower: net + unresolved * range.min,
      upper: net + unresolved * range.max };
    const rebateRange = { min: Math.min(...outcomes.map(rebate)), max: Math.max(...outcomes.map(rebate)) };
    result.evBounds.rebate = { lower: rebateValue + unresolved * rebateRange.min,
      upper: rebateValue + unresolved * rebateRange.max };
    result.netEV = unresolved === 0 ? net : null;
    result.contract = detached(contract);
    result.tailUncertainty.payoffRanges.net = range;
    result.tailUncertainty.payoffRanges.rebate = rebateRange;
    result.tailUncertainty.maxAbsoluteNetContribution = unresolved * Math.max(Math.abs(range.min), Math.abs(range.max));
  }
  const profitRows = result.tailSettlement ? [...result.rows, result.tailSettlement] : result.rows;
  const profitable = profitRows.filter(row => row.netPerUnit > 0).reduce((sum, row) => sum + row.probability, 0);
  const breakeven = profitRows.filter(row => row.netPerUnit === 0).reduce((sum, row) => sum + row.probability, 0);
  const losing = profitRows.filter(row => row.netPerUnit < 0).reduce((sum, row) => sum + row.probability, 0);
  const unresolved = result.unresolvedTailMass ?? result.tailMass;
  result.profitProbabilities = { profitable, breakeven, losing,
    bounds: Object.fromEntries(Object.entries({ profitable, breakeven, losing }).map(([key, value]) => [key, { lower: value, upper: Math.min(1, value + unresolved) }])),
    interpretation: 'CONDITIONAL_NET_PROFIT_EVENTS_NOT_RAW_GOAL_THRESHOLDS' };
  return result;
}

/**
 * Recompute every scenario's return from score cells. The explicit protocol is
 * conditional engineering arithmetic, never empirical validation of football R.
 * No default error margin, normalized tail, borrowed sport model or caller EV.
 */
export function evaluateSoccerScenarioReturns({ quote, scenarios, contract, uncertainty, game, now = Date.now() } = {}) {
  const body = uncertainty && Object.fromEntries(Object.entries(uncertainty).filter(([key]) => key !== 'artifactHash'));
  if (!game || !Object.hasOwn(periods, quote?.period) || !finite(now) || !Array.isArray(scenarios) || !scenarios.length || scenarios.length > 1000)
    return failed('SOCCER_SCORE_SCENARIOS_MISSING');
  if (uncertainty?.version !== SOCCER_SCENARIO_ARITHMETIC_VERSION || uncertainty.aggregation !== 'WEIGHTED_Q10_AND_EMPIRICAL_ERROR'
      || uncertainty.quantile !== .10 || uncertainty.league !== game.league || uncertainty.period !== quote.period
      || !sha(uncertainty.artifactHash) || uncertainty.artifactHash !== soccerScoringHash(body)
      || uncertainty.scenariosHash !== soccerScoringHash(scenarios) || !sha(uncertainty.trainingHash) || !uncertainty.modelVersion
      || !finite(uncertainty.modelError?.value) || uncertainty.modelError.value < 0
      || uncertainty.modelError.unit !== 'NET_PROFIT_PER_1_STAKE' || !sha(uncertainty.modelError.validationArtifactHash)
      || !Number.isInteger(uncertainty.modelError.validationSamples) || uncertainty.modelError.validationSamples <= 0
      || !sourceKnown(uncertainty.modelError.source, instant(uncertainty.createdAt)) || !(instant(uncertainty.trainedThrough) < instant(uncertainty.createdAt))
      || !(instant(uncertainty.createdAt) <= now)) return failed('SOCCER_SCORE_UNCERTAINTY_ARTIFACT_INVALID');
  const ids = new Set(), rows = []; let weightSum = 0;
  for (const scenario of scenarios) {
    if (!scenario || typeof scenario.id !== 'string' || !scenario.id || ids.has(scenario.id) || !finite(scenario.weight) || scenario.weight <= 0
        || scenario.league !== game.league || scenario.gameId !== game.id || scenario.period !== quote.period
        || scenario.modelVersion !== uncertainty.modelVersion || scenario.trainingHash !== uncertainty.trainingHash
        || !Array.isArray(scenario.sources) || !scenario.sources.length || scenario.sources.some(source => !sourceKnown(source, instant(uncertainty.createdAt)))
        || scenario.distribution?.league !== game.league || scenario.distribution?.gameId !== game.id
        || scenario.distribution?.period !== periods[quote.period] || scenario.distribution?.modelVersion !== scenario.modelVersion
        || scenario.distribution?.trainingHash !== scenario.trainingHash) return failed('SOCCER_SCORE_SCENARIO_SCOPE_OR_SOURCE_INVALID');
    const payoff = conditionalPayoff(quote, scenario.distribution, contract, game);
    if (!payoff.ok) return failed('SOCCER_SCORE_SCENARIO_PAYOFF_INVALID', { underlyingCode: payoff.code, scenarioId: scenario.id });
    ids.add(scenario.id); weightSum += scenario.weight;
    rows.push({ id: scenario.id, weight: scenario.weight, distributionHash: soccerScoringHash(scenario.distribution),
      sourceHashes: scenario.sources.map(source => source.contentHash), expectedNet: payoff.netEV, evBounds: payoff.evBounds.net,
      tailMass: payoff.tailMass, resolvedTailMass: payoff.resolvedTailMass ?? 0,
      unresolvedTailMass: payoff.unresolvedTailMass ?? payoff.tailMass, payoff });
  }
  if (Math.abs(weightSum - 1) > EPS) return failed('SOCCER_SCORE_SCENARIO_WEIGHT_MASS_INVALID');
  const evBounds = { lower: rows.reduce((sum, row) => sum + row.weight * row.evBounds.lower, 0),
    upper: rows.reduce((sum, row) => sum + row.weight * row.evBounds.upper, 0) };
  const evidence = { version: SOCCER_SCENARIO_ARITHMETIC_VERSION, artifactHash: uncertainty.artifactHash,
    aggregation: uncertainty.aggregation, scenarioRows: rows, weightSum, weightMassError: weightSum - 1,
    evBounds, interpretation: 'CONDITIONAL_SCENARIO_STRESS_NOT_A_CONFIDENCE_INTERVAL_OR_FORMAL_R' };
  if (rows.some(row => !finite(row.expectedNet))) return { ...evidence, ok: false, code: 'SOCCER_SCORE_SCENARIO_TAIL_UNRESOLVED',
    reasons: ['SOCCER_SCORE_SCENARIO_TAIL_UNRESOLVED'], conditionalWeightedReturn: null, conditionalRobustReturn: null, fixedScoreDiagnostic: null };
  const weighted = rows.reduce((sum, row) => sum + row.weight * row.expectedNet, 0);
  let cumulative = 0, q10 = null;
  for (const row of [...rows].sort((a, b) => a.expectedNet - b.expectedNet)) {
    cumulative += row.weight / weightSum; if (cumulative + 1e-12 >= .10) { q10 = row.expectedNet; break; }
  }
  if (!finite(q10) || !finite(weighted)) return failed('SOCCER_SCORE_SCENARIO_NUMERICS_INVALID');
  const errorAdjusted = weighted - uncertainty.modelError.value, robust = Math.min(weighted, q10, errorAdjusted);
  const fixedScoreDiagnostic = deterministicScore({ weightedEV: weighted, robustEV: robust, actualWater: true, qaPassed: true, executable: false });
  const audit = scoreBoundaryAudit(fixedScoreDiagnostic, { weightedEV: weighted, robustEV: robust });
  if (!audit.ok) return failed('SOCCER_SCORE_FIXED_FORMULA_INTEGRITY_FAILED', { audit });
  return { ...evidence, ok: true, status: 'CONDITIONAL_PROTOCOL_ARITHMETIC', conditionalWeightedReturn: weighted,
    conditionalRobustReturn: robust, q10, modelErrorMargin: uncertainty.modelError.value, errorAdjustedReturn: errorAdjusted,
    fixedScoreDiagnostic, scoreAudit: audit, warnings: [wrGapWarning(weighted - robust)].filter(Boolean) };
}

function acceptanceReasons({ acceptance, game, period, distribution, uncertainty, evidence, now }) {
  const reasons = [];
  for (const kind of acceptanceKinds) {
    const manifest = acceptance?.[kind], registration = acceptedArtifacts.find(item => item.kind === kind
      && item.league === game?.league && item.period === period && item.manifestHash === soccerScoringHash(manifest));
    if (!registration) reasons.push(`SOCCER_SCORE_${kind.toUpperCase()}_ACCEPTANCE_NOT_REGISTERED`);
    if (manifest?.league !== game?.league || manifest?.period !== period || !sha(manifest?.artifactHash)
        || manifest?.modelVersion !== distribution?.modelVersion || manifest?.trainingHash !== distribution?.trainingHash
        || !sourceKnown(manifest?.source, now) || manifest?.status !== 'VERIFIED') reasons.push(`SOCCER_SCORE_${kind.toUpperCase()}_ACCEPTANCE_INCOMPLETE`);
  }
  if (uncertainty?.artifactHash !== acceptance?.uncertainty?.artifactHash) reasons.push('SOCCER_SCORE_UNCERTAINTY_ACCEPTANCE_MISMATCH');
  if (evidence?.ok !== true || evidence.phase !== 'PREMATCH_OBSERVATION' || evidence.game?.id !== game?.id
      || evidence.game?.league !== game?.league || evidence.pointInTimeAvailabilityVerified !== true
      || !sourceKnown(evidence.source, now)) reasons.push('SOCCER_SCORE_PREMATCH_PIT_EVIDENCE_INCOMPLETE');
  const playerIds = new Set();
  for (const side of ['home', 'away']) {
    const team = evidence?.teams?.[side];
    if (team?.sourceId !== game?.[side]?.sourceId) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_IDENTITY_UNVERIFIED`);
    for (const field of ['lineup', 'injuries', 'suspensions', 'minutes']) {
      const observation = team?.[field];
      if (observation?.status !== 'VERIFIED' || !sourceKnown(observation?.source, now)) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_${field.toUpperCase()}_UNVERIFIED`);
    }
    const starters = team?.lineup?.starters;
    if (!Array.isArray(starters) || starters.length !== 11 || starters.some(player => typeof player?.id !== 'string'
        || !/^\d{1,16}$/.test(player.id) || playerIds.has(player.id) || (playerIds.add(player.id), false))) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_STARTING_XI_UNVERIFIED`);
    if (team?.minutes?.modelEffectApplied !== true) reasons.push(`SOCCER_SCORE_${side.toUpperCase()}_PERSONNEL_MODEL_EFFECT_UNVERIFIED`);
  }
  for (const field of ['xg', 'travel', 'weather', 'referee', ...(game?.league === 'ucl' ? ['uclContext'] : [])]) {
    if (evidence?.[field]?.status !== 'VERIFIED' || !sourceKnown(evidence[field]?.source, now)) reasons.push(`SOCCER_SCORE_${field.toUpperCase()}_UNVERIFIED`);
  }
  if (distribution?.league !== game?.league || distribution?.gameId !== game?.id || distribution?.period !== periods[period]
      || !sha(distribution?.trainingHash) || !distribution?.modelVersion) reasons.push('SOCCER_SCORE_MODEL_DISTRIBUTION_SCOPE_UNVERIFIED');
  return reasons;
}

/** Per-quote calculation progress plus an independent, fail-closed formal gate. */
export function scoreSoccerQuote({ quote, distribution, game, contract = null, scenarios = null, uncertainty = null,
  evidence = null, acceptance = null, now = Date.now() } = {}) {
  const adapted = adaptSoccerReaderQuote({ quote, game, now }), stages = [];
  stages.push({ stage: 'READER_QUOTE', status: adapted.ok ? 'PASS' : 'BLOCKED', reasons: adapted.reasons || [] });
  const record = { league: game?.league, period: quote?.period, kind: quote?.kind, line: quote?.line,
    quoteKey: quote?.key, sourceQuote: quote };
  const registeredContract = soccerVerifiedSettlementContract(record), selectedContract = registeredContract || contract;
  const payoff = adapted.ok ? conditionalPayoff(adapted.quote, distribution, selectedContract, game) : null;
  stages.push({ stage: 'SETTLEMENT_CONTRACT', status: registeredContract ? 'REGISTERED' : selectedContract ? 'CONDITIONAL_ONLY' : 'MISSING',
    reasons: registeredContract ? [] : ['SOCCER_SCORE_SOURCE_CONTRACT_NOT_REGISTERED'] });
  stages.push({ stage: 'PER_SCORE_PAYOFF', status: payoff?.ok ? 'CALCULATED_CONDITIONALLY' : 'NOT_CALCULABLE',
    reasons: payoff?.ok ? [] : [payoff?.code || 'SOCCER_SCORE_PAYOFF_NOT_REACHED'] });
  const scenarioReturns = adapted.ok && payoff?.ok && scenarios
    ? evaluateSoccerScenarioReturns({ quote: adapted.quote, scenarios, contract: selectedContract, uncertainty, game, now }) : null;
  stages.push({ stage: 'FOOTBALL_UNCERTAINTY', status: scenarioReturns?.ok ? 'CONDITIONAL_PROTOCOL_ARITHMETIC' : 'NOT_CALCULABLE',
    reasons: scenarioReturns?.ok ? [] : [scenarioReturns?.code || 'SOCCER_SCORE_FOOTBALL_UNCERTAINTY_MISSING'] });
  stages.push({ stage: 'FIXED_S_FORMULA', status: scenarioReturns?.fixedScoreDiagnostic ? 'DIAGNOSTIC_ONLY' : 'NOT_CALCULABLE',
    reasons: scenarioReturns?.fixedScoreDiagnostic ? [] : ['SOCCER_SCORE_FIXED_S_INPUTS_UNVERIFIED'] });
  const blockers = acceptanceReasons({ acceptance, game, period: quote?.period, distribution, uncertainty, evidence, now });
  if (!registeredContract) blockers.unshift('SOCCER_SCORE_SOURCE_CONTRACT_NOT_REGISTERED');
  if (!adapted.ok) blockers.push(adapted.code);
  if (!payoff?.ok) blockers.push(payoff?.code || 'SOCCER_SCORE_PAYOFF_NOT_REACHED');
  if (!scenarioReturns?.ok) blockers.push(scenarioReturns?.code || 'SOCCER_SCORE_FOOTBALL_UNCERTAINTY_MISSING');
  const authorized = blockers.length === 0, weighted = scenarioReturns?.conditionalWeightedReturn, robust = scenarioReturns?.conditionalRobustReturn;
  const score = authorized ? scenarioReturns.fixedScoreDiagnostic.score : null;
  stages.push({ stage: 'FORMAL_ACCEPTANCE', status: authorized ? 'PASS' : 'BLOCKED', reasons: unique(blockers) });
  stages.push({ stage: 'CURRENT_PUBLICATION', status: 'PENDING', prerequisitesPassed: authorized,
    reasons: ['SOCCER_SCORE_ATOMIC_CURRENT_PUBLICATION_REQUIRED'] });
  return { version: SOCCER_SCORING_VERSION, scoreFormulaVersion: SCORE_FORMULA_VERSION,
    status: authorized ? 'FORMAL_CALCULATED_AWAITING_PUBLICATION' : scenarioReturns?.fixedScoreDiagnostic ? 'RESEARCH_FIXED_SCORE'
      : payoff?.ok ? 'CONDITIONAL_PAYOFF_ONLY' : 'NOT_CALCULABLE',
    availableThrough: scenarioReturns?.fixedScoreDiagnostic ? 'FIXED_S_DIAGNOSTIC' : payoff?.ok ? 'PER_SCORE_PAYOFF' : adapted.ok ? 'READER_QUOTE' : null,
    unit: 'NET_PROFIT_PER_1_STAKE', displayUnit: 'PERCENT_RETURN',
    W: authorized ? weighted : null, R: authorized ? robust : null, score, S: score,
    WPercent: authorized ? weighted * 100 : null, RPercent: authorized ? robust * 100 : null,
    formalScoringEnabled: authorized, calculationEligible: authorized && score >= 7.2 && weighted > 0 && robust > 0,
    calculationInputs: authorized ? detached({ scenarios, uncertainty, acceptance }) : null,
    eligible: false, eligibilityAuthority: 'ATOMIC_CURRENT_PUBLICATION_REQUIRED',
    executable: false, executionScope: 'SCORING_ONLY_REQUIRES_ATOMIC_CURRENT_PUBLICATION_AND_ACCEPTED_PRICE',
    conditionalPayoff: payoff, scenarioReturns, fixedScoreDiagnostic: scenarioReturns?.fixedScoreDiagnostic || null,
    sourceQuoteKey: adapted.sourceQuoteKey || null, gameId: game?.id || null, league: game?.league || null, period: quote?.period || null,
    stages, reasons: unique([...blockers, 'SOCCER_SCORE_ATOMIC_CURRENT_PUBLICATION_REQUIRED']), provenance: { quoteHash: adapted.sourceQuoteKey || null,
      distributionHash: distribution ? soccerScoringHash(distribution) : null, uncertaintyHash: uncertainty?.artifactHash || null,
      contractRegistered: Boolean(registeredContract), registeredAcceptanceCount: acceptedArtifacts.length,
      calculatedAt: finite(now) && Math.abs(now) <= 8.64e15 ? new Date(now).toISOString() : null } };
}
