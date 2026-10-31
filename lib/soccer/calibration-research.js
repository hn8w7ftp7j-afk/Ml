import { createHash } from 'node:crypto';
import { normalizeSoccerHistory, enrichSoccerHistoryHalfTime } from './history.js';
import { predictScoreModel, scoreDistribution, soccerScoreLogProbability } from './score-model.js';
import { predictHalfTimeDistribution } from './half-time-model.js';
import { buildSoccerProbabilityAudit, soccerProbabilityAuditFields } from './probability-audit.js';
import { soccerLeague } from './contracts.js';

export const SOCCER_CALIBRATION_RESEARCH_VERSION = 'SOCCER-FROZEN-MODEL-RATE-CALIBRATION-v1';
export const SOCCER_CALIBRATION_METHOD = Object.freeze({
  version: SOCCER_CALIBRATION_RESEARCH_VERSION,
  fullTime: 'UNWEIGHTED_POISSON_MARGINAL_RATE_SCALE_MLE_BY_HOME_AWAY',
  halfTime: 'CONDITIONAL_BINOMIAL_GOAL_SHARE_MLE_BY_HOME_AWAY',
  dependence: 'UNCHANGED_BASELINE_RHO_FAIL_IF_CALIBRATED_DC_FACTORS_INVALID',
  selection: 'ALL_SOURCE_VERIFIED_NORMAL_FINAL_GAMES_IN_DECLARED_DEVELOPMENT_WINDOW',
  grouping: 'LEAGUE_EXACT_FROZEN_FT_AND_HT_MODEL_HASHES',
  target: 'COMPLETE_FT_SCORE_DISTRIBUTION_AND_ITS_CONDITIONAL_HT_DISTRIBUTION',
  interpretation: 'DEVELOPMENT_FIT_NOT_UNTOUCHED_VALIDATION_OR_FORMAL_CALIBRATION_ACCEPTANCE',
});
const restrictions = { accepted: false, formalEligible: false, promotionEligible: false, executable: false,
  W: null, R: null, S: null, empiricalErrorMargin: null };
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const soccerCalibrationHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const providerHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const seal = value => ({ ...value, contentHash: soccerCalibrationHash(value) });
const validSeal = value => { if (!value) return false; const { contentHash, ...body } = value; return contentHash === soccerCalibrationHash(body); };
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const gameKey = row => `${row.league}:${row.eventId}`;
const scoreKey = row => `${row.homeGoals}:${row.awayGoals}:${row.halfTime?.home ?? '?'}:${row.halfTime?.away ?? '?'}`;
const sourceMetadata = document => ({ ...document.source, originalResponseHash: document.source.contentHash,
  sourcePublishedAt: document.source.sourcePublishedAt ?? null, sourceAvailabilityBasis: 'CURRENT_RETAINED_PROVIDER_RESPONSE_NOT_HISTORICAL_PUBLICATION' });

export function soccerCalibrationHasExtraPeriods(payload, competition = payload?.header?.competitions?.[0] ?? payload?.competitions?.[0]) {
  const statuses = [payload?.status, payload?.header?.status, competition?.status].filter(Boolean);
  return statuses.some(status => Number(status.period) > 2
    || /EXTRA|SHOOTOUT|PENALT|(?:^|[^A-Z0-9])(?:AET|PEN|PENS|PSO)(?=$|[^A-Z0-9])/i.test(status.type?.name || ''))
    || (Array.isArray(payload?.keyEvents) ? payload.keyEvents : []).some(event => Number(event.period?.number) > 2)
    || (competition?.competitors || []).some(team => Array.isArray(team.linescores)
      && (team.linescores.length > 2 || team.linescores.some(line => Number(line.period) > 2)));
}

function verifyDocument(document, { kind, league, eventId = null, now }) {
  const competition = soccerLeague(league), slug = competition?.espnSlug;
  if (!slug || document?.ok !== true || !document.data || !sha(document.source?.contentHash)
    || document.source.contentHash !== providerHash(document.data) || document.source.provider !== 'ESPN'
    || !Number.isFinite(instant(document.source.fetchedAt)) || instant(document.source.fetchedAt) > now) return false;
  if (kind === 'summary') {
    const header = document.data.header, reportedLeague = header?.league;
    if (!reportedLeague || String(reportedLeague.id) !== competition.espnId || reportedLeague.slug !== slug
      || String(header.id) !== eventId || reportedLeague.uid != null && reportedLeague.uid !== `s:600~l:${competition.espnId}`)
      return false;
    for (const [uid, expected] of [[header.uid, `s:600~l:${competition.espnId}~e:${eventId}`],
      [header.competitions?.[0]?.uid, `s:600~l:${competition.espnId}~e:${eventId}~c:${eventId}`]])
      if (uid != null && uid !== expected) return false;
  }
  try {
    const url = new URL(document.source.url);
    return url.protocol === 'https:' && url.hostname === 'site.api.espn.com' && !url.username && !url.password && !url.port && !url.hash
      && url.pathname === `/apis/site/v2/sports/soccer/${slug}/${kind}`
      && (kind !== 'summary' || url.searchParams.get('event') === eventId);
  } catch { return false; }
}

/** Recompute development rows from retained full provider documents. Historical
 * publication times are unnecessary for a model used AFTER this new artifact,
 * but are never invented or used to certify a past prediction. */
export function buildSoccerCalibrationRows({ league, scoreboard, summaries = [], from, through, now = Date.now() } = {}) {
  if (!dateValid(from) || !dateValid(through) || through < from || !Number.isFinite(now)
    || !verifyDocument(scoreboard, { kind: 'scoreboard', league, now })) throw Error('CALIBRATION_SOURCE_DOCUMENT_INVALID');
  const years = new Set((scoreboard.data.events || []).map(event => String(event.date || '').slice(0, 4)));
  const rows = [], excluded = [], sources = [sourceMetadata(scoreboard)], summaryByEvent = new Map(), inspectedGameIds = new Set();
  const boardEvents = new Map((scoreboard.data.events || []).map(event => [String(event.id), event]));
  for (const document of summaries) {
    const id = String(document?.data?.header?.id || '');
    if (!verifyDocument(document, { kind: 'summary', league, eventId: id, now })) throw Error('CALIBRATION_SUMMARY_DOCUMENT_INVALID');
    if (!summaryByEvent.has(id)) summaryByEvent.set(id, []);
    summaryByEvent.get(id).push(document); sources.push(sourceMetadata(document));
  }
  for (const year of [...years].sort()) {
    if (!/^\d{4}$/.test(year)) throw Error('CALIBRATION_SOURCE_YEAR_INVALID');
    const normalized = normalizeSoccerHistory(scoreboard.data, league, scoreboard.source, Number(year));
    if (!normalized.ok) throw Error('CALIBRATION_SCOREBOARD_NORMALIZATION_FAILED');
    for (const row of normalized.rows) inspectedGameIds.add(gameKey(row));
    for (const exclusion of normalized.excluded) if (exclusion.startTime?.slice(0, 10) >= from && exclusion.startTime.slice(0, 10) <= through
      && exclusion.reason !== 'OUTSIDE_REQUESTED_UTC_YEAR') excluded.push(soccerCalibrationHasExtraPeriods(boardEvents.get(exclusion.eventId))
        ? { ...exclusion, reason: 'CALIBRATION_RESULT_DOCUMENT_CONFLICT' } : exclusion);
    for (const original of normalized.rows) {
      if (original.startTime.slice(0, 10) < from || original.startTime.slice(0, 10) > through) continue;
      if (instant(original.startTime) >= now) { excluded.push({ eventId: original.eventId, reason: 'CALIBRATION_RESULT_NOT_PAST' }); continue; }
      const eventSummaries = summaryByEvent.get(original.eventId);
      if (!eventSummaries) { excluded.push({ eventId: original.eventId, reason: 'CALIBRATION_SUMMARY_MISSING' }); continue; }
      // A valid normal-time response cannot outvote explicit extra-time or
      // shootout evidence for the same real game, even if another response
      // still reports period two. Preserve the conflict for validation replay
      // so an older accepted result is quarantined as well.
      if (soccerCalibrationHasExtraPeriods(boardEvents.get(original.eventId)) || eventSummaries.some(document => soccerCalibrationHasExtraPeriods(document.data))) {
        excluded.push({ eventId: original.eventId, reason: 'CALIBRATION_RESULT_DOCUMENT_CONFLICT' }); continue;
      }
      const verified = [], failed = [];
      for (const summary of eventSummaries) {
        const reportedNeutral = summary.data.header?.competitions?.[0]?.neutralSite;
        if (typeof reportedNeutral === 'boolean' && reportedNeutral !== Boolean(original.neutralSite)) {
          failed.push('CALIBRATION_SUMMARY_NEUTRAL_SITE_CONFLICT'); continue;
        }
        const enriched = enrichSoccerHistoryHalfTime(original, summary.data, summary.source);
        if (enriched.ok) verified.push(enriched.row); else failed.push(enriched.code);
      }
      if (failed.some(code => ['HALF_TIME_SUMMARY_FT_REVISION_OR_IDENTITY_MISMATCH', 'CALIBRATION_SUMMARY_NEUTRAL_SITE_CONFLICT'].includes(code))
        || verified.some(row => scoreKey(row) !== scoreKey(verified[0]) || Boolean(row.neutralSite) !== Boolean(verified[0].neutralSite))) {
        excluded.push({ eventId: original.eventId, reason: 'CALIBRATION_RESULT_DOCUMENT_CONFLICT' }); continue;
      }
      if (!verified.length) { excluded.push({ eventId: original.eventId, reason: failed[0] || 'CALIBRATION_SUMMARY_UNVERIFIED' }); continue; }
      verified.sort((a, b) => instant(a.halfTime.source.fetchedAt) - instant(b.halfTime.source.fetchedAt));
      rows.push({ ...verified[0], calibrationResultSources: verified.map(row => row.halfTime.source) });
    }
  }
  const deduped = new Map();
  for (const row of rows) {
    const previous = deduped.get(gameKey(row));
    if (previous && (scoreKey(previous) !== scoreKey(row) || previous.startTime !== row.startTime
      || previous.homeId !== row.homeId || previous.awayId !== row.awayId)) throw Error('CALIBRATION_GAME_RESULT_CONFLICT');
    deduped.set(gameKey(row), row);
  }
  return seal({ version: SOCCER_CALIBRATION_RESEARCH_VERSION, type: 'SOURCE_RECOMPUTED_CALIBRATION_ROWS', league, from, through,
    checkedAt: new Date(now).toISOString(), rows: [...deduped.values()].sort((a, b) => a.startTime.localeCompare(b.startTime) || a.eventId.localeCompare(b.eventId)),
    excluded, sources, inspectedGameIds: [...inspectedGameIds].sort(), normalizedDocumentHashRecomputed: true,
    rawSourceHashRecomputed: false, sourceRepresentation: 'COMPLETE_PARSED_PROVIDER_JSON_NOT_ORIGINAL_HTTP_BYTES',
    historicalPitVerified: false, ...restrictions });
}

function exactScoreLogProbability(score, distribution) {
  const { homeRate, awayRate, rho } = distribution;
  if (homeRate > 0 && awayRate > 0) return soccerScoreLogProbability(score.home, score.away, homeRate, awayRate, rho);
  // A zero conditional HT share is an admissible binomial boundary, never an
  // epsilon rate. On the support of a zero-rate marginal the DC factor is one.
  const poisson = (goals, rate) => {
    if (rate === 0) return goals === 0 ? 0 : -Infinity;
    let factorial = 0; for (let n = 2; n <= goals; n++) factorial += Math.log(n);
    return -rate + goals * Math.log(rate) - factorial;
  };
  if (![homeRate, awayRate].every(rate => Number.isFinite(rate) && rate >= 0)) throw Error('CALIBRATION_LOG_PROBABILITY_INVALID');
  return poisson(score.home, homeRate) + poisson(score.away, awayRate);
}

function summarizePredictions(records, period, modelHash, fold = 'CALIBRATION_DEVELOPMENT_REUSED') {
  const scoreLoss = records.reduce((sum, row) => sum - exactScoreLogProbability(row.actualScore, row.distribution), 0);
  const loss = records.reduce((sum, row) => {
    const actual = row.actualScore.home > row.actualScore.away ? 'home' : row.actualScore.home === row.actualScore.away ? 'draw' : 'away';
    return sum - Math.log(row.distribution.outcomes[actual]);
  }, 0);
  return { games: records.length,
    scoreLogLoss: records.length && Number.isFinite(scoreLoss) ? scoreLoss / records.length : null,
    scoreLogLossState: !records.length ? 'UNAVAILABLE' : scoreLoss === Infinity ? 'POSITIVE_INFINITY' : 'FINITE',
    logLoss: records.length && Number.isFinite(loss) ? loss / records.length : null,
    logLossState: !records.length ? 'UNAVAILABLE' : loss === Infinity ? 'POSITIVE_INFINITY' : 'FINITE',
    brier: records.length ? records.reduce((sum, row) => sum + ['home', 'draw', 'away'].reduce((value, key) => value
      + (row.distribution.outcomes[key] - Number(key === (row.actualScore.home > row.actualScore.away ? 'home' : row.actualScore.home === row.actualScore.away ? 'draw' : 'away'))) ** 2, 0), 0) / records.length : null,
    probabilityAudit: buildSoccerProbabilityAudit(records.map(row => ({ status: 'EVALUATED', eventId: row.eventId, league: row.league,
      period, modelHash, fold, ...soccerProbabilityAuditFields(row.distribution,
        row.actualScore.home > row.actualScore.away ? 'home' : row.actualScore.home === row.actualScore.away ? 'draw' : 'away') })), { period, modelHash }) };
}

/** Closed-form marginal likelihood fit, not joint DC MLE or an acceptance test.
 * Every eligible whole game has one weight; no per-price pseudoreplication. */
export function fitSoccerCalibrationResearch({ dataset, model, halfTimeModel, modelCreatedAt, halfTimeModelCreatedAt,
  createdAt = new Date().toISOString(), validationThrough = null } = {}) {
  const now = instant(createdAt), available = Math.max(instant(modelCreatedAt), instant(halfTimeModelCreatedAt));
  if (!validSeal(dataset) || dataset.type !== 'SOURCE_RECOMPUTED_CALIBRATION_ROWS' || dataset.version !== SOCCER_CALIBRATION_RESEARCH_VERSION
    || !Number.isFinite(now) || !Number.isFinite(available) || available >= now || instant(dataset.checkedAt) > now
    || dataset.league !== model?.league || model.league !== halfTimeModel?.league || model.period !== 'REGULATION_FT'
    || halfTimeModel.period !== 'REGULATION_HT' || !sha(model.trainingHash) || !sha(halfTimeModel.trainingHash)
    || !Number.isFinite(instant(model.cutoff)) || !Number.isFinite(instant(halfTimeModel.cutoff))) throw Error('CALIBRATION_FIT_CONTEXT_INVALID');
  if (validationThrough !== null && (!(instant(validationThrough) > now))) throw Error('CALIBRATION_VALIDATION_MUST_BE_FUTURE');
  const eligible = [], excluded = [...dataset.excluded], seen = new Set();
  const lower = Math.max(available, instant(model.cutoff), instant(halfTimeModel.cutoff));
  for (const row of dataset.rows) {
    let reason = null;
    if (seen.has(gameKey(row))) throw Error('CALIBRATION_DUPLICATE_GAME');
    seen.add(gameKey(row));
    if (row.league !== model.league || instant(row.startTime) <= lower) reason = 'CALIBRATION_GAME_NOT_AFTER_FROZEN_MODEL';
    else if (![row.startTime, row.source?.fetchedAt, row.halfTime?.source?.fetchedAt].every(value => Number.isFinite(instant(value)))
      || instant(row.startTime) >= now || instant(row.source?.fetchedAt) > now || instant(row.halfTime?.source?.fetchedAt) > now)
      reason = 'CALIBRATION_LABEL_UNAVAILABLE_AT_FIT';
    else try {
      if (![row.homeGoals, row.awayGoals, row.halfTime?.home, row.halfTime?.away].every(value => Number.isSafeInteger(value) && value >= 0 && value <= 30)
        || row.halfTime.verified !== true || row.halfTime.home > row.homeGoals || row.halfTime.away > row.awayGoals) throw Error('CALIBRATION_SCORE_INVALID');
      const fullTime = predictScoreModel(model, row), halfTime = predictHalfTimeDistribution(fullTime, halfTimeModel, row);
      eligible.push({ row, fullTime, halfTime });
    } catch (error) { reason = error.message; }
    if (reason) excluded.push({ eventId: row.eventId, reason });
  }
  const totals = { games: eligible.length, homeGoals: 0, awayGoals: 0, homeHalfGoals: 0, awayHalfGoals: 0, predictedHomeGoals: 0, predictedAwayGoals: 0 };
  for (const { row, fullTime } of eligible) {
    totals.homeGoals += row.homeGoals; totals.awayGoals += row.awayGoals;
    totals.homeHalfGoals += row.halfTime.home; totals.awayHalfGoals += row.halfTime.away;
    totals.predictedHomeGoals += fullTime.homeRate; totals.predictedAwayGoals += fullTime.awayRate;
  }
  const parameters = eligible.length && totals.homeGoals > 0 && totals.awayGoals > 0 ? {
    fullTimeRateScales: { home: totals.homeGoals / totals.predictedHomeGoals, away: totals.awayGoals / totals.predictedAwayGoals },
    halfTimeGoalShares: { home: totals.homeHalfGoals / totals.homeGoals, away: totals.awayHalfGoals / totals.awayGoals },
    rho: model.rho,
  } : null;
  const before = { FT: [], HT: [] }, after = { FT: [], HT: [] }, failures = [];
  for (const { row, fullTime, halfTime } of eligible) {
    const base = { eventId: row.eventId, league: row.league };
    before.FT.push({ ...base, actualScore: { home: row.homeGoals, away: row.awayGoals }, distribution: fullTime });
    before.HT.push({ ...base, actualScore: { home: row.halfTime.home, away: row.halfTime.away }, distribution: halfTime });
    if (parameters) try {
      const calibrated = scoreDistribution(fullTime.homeRate * parameters.fullTimeRateScales.home,
        fullTime.awayRate * parameters.fullTimeRateScales.away, fullTime.rho, fullTime.tolerance);
      const calibratedHalfTime = predictHalfTimeDistribution(calibrated, { ...halfTimeModel, shares: parameters.halfTimeGoalShares }, row);
      after.FT.push({ ...base, actualScore: before.FT.at(-1).actualScore, distribution: calibrated });
      after.HT.push({ ...base, actualScore: before.HT.at(-1).actualScore, distribution: calibratedHalfTime });
    } catch (error) { failures.push({ eventId: row.eventId, reason: error.message }); }
  }
  const modelHash = soccerCalibrationHash(model), halfTimeModelHash = soccerCalibrationHash(halfTimeModel);
  const jointHalfTimeModelHash = soccerCalibrationHash({ fullTimeModelHash: modelHash, halfTimeModelHash });
  const calibratedModelHashes = { FT: soccerCalibrationHash({ modelHash, parameters, datasetHash: dataset.contentHash }),
    HT: soccerCalibrationHash({ fullTimeModelHash: modelHash, halfTimeModelHash, parameters, datasetHash: dataset.contentHash }) };
  const inspectedGameIds = [...new Set([...seen, ...(dataset.inspectedGameIds || [])])].sort();
  const observations = eligible.flatMap(({ row, fullTime, halfTime }) => ['FT', 'HT'].map(period => ({
    league: row.league, gameId: `soccer:${row.league}:${row.eventId}`, eventId: row.eventId, period: `REGULATION_${period}`,
    kickoff: row.startTime, predictedAt: null, predictionSemantics: 'RECONSTRUCTED_FROM_UNCHANGED_FROZEN_MODEL_FOR_DEVELOPMENT',
    baselineModelHash: period === 'FT' ? modelHash : jointHalfTimeModelHash,
    fullTimeModelHash: modelHash, halfTimeModelHash: period === 'HT' ? halfTimeModelHash : null,
    homeRate: (period === 'FT' ? fullTime : halfTime).homeRate, awayRate: (period === 'FT' ? fullTime : halfTime).awayRate,
    rho: (period === 'FT' ? fullTime : halfTime).rho,
    actualScore: period === 'FT' ? { home: row.homeGoals, away: row.awayGoals } : { home: row.halfTime.home, away: row.halfTime.away },
    resultAvailableAt: new Date(Math.max(instant(row.source.fetchedAt), instant(row.halfTime.source.fetchedAt), ...(row.calibrationResultSources || []).map(source => instant(source.fetchedAt)))).toISOString(),
    sourceHashes: [...new Set([row.source.contentHash, row.halfTime.source.contentHash, ...(row.calibrationResultSources || []).map(source => source.contentHash)])], untouchedVerified: false,
  })));
  const fitStatus = !eligible.length ? 'MISSING_DEVELOPMENT_GAMES' : !parameters ? 'NO_FINITE_POSITIVE_RATE_SCALE'
    : failures.length ? 'CALIBRATED_DISTRIBUTION_INVALID' : 'DEVELOPMENT_FIT_AVAILABLE';
  return seal({ version: SOCCER_CALIBRATION_RESEARCH_VERSION, type: 'CALIBRATION_RESEARCH_CANDIDATE', league: model.league, createdAt,
    status: fitStatus, method: SOCCER_CALIBRATION_METHOD, modelHash, halfTimeModelHash, jointHalfTimeModelHash, calibratedModelHashes,
    modelAvailability: { modelCreatedAt, halfTimeModelCreatedAt, historicalFreezeReceiptVerified: false,
      currentInputsAvailableAtFit: true, durableCurrentInputArchiveVerified: false },
    datasetHash: dataset.contentHash, window: { from: dataset.from, through: dataset.through }, totals, parameters, excluded, failures,
    developmentGameIds: eligible.map(({ row }) => gameKey(row)),
    inspectedGameIds, observations,
    diagnostic: { interpretation: 'IN_SAMPLE_DEVELOPMENT_DIAGNOSTICS_NOT_A_NEW_UNTOUCHED_TEST',
      before: { FT: summarizePredictions(before.FT, 'REGULATION_FT', modelHash), HT: summarizePredictions(before.HT, 'REGULATION_HT', jointHalfTimeModelHash) },
      after: fitStatus === 'DEVELOPMENT_FIT_AVAILABLE' ? { FT: summarizePredictions(after.FT, 'REGULATION_FT', calibratedModelHashes.FT), HT: summarizePredictions(after.HT, 'REGULATION_HT', calibratedModelHashes.HT) } : null },
    prospectiveValidation: { status: 'PREPARED_REQUIRES_DURABLE_FREEZE_AND_PREGAME_CAPTURE', beginsStrictlyAfter: createdAt,
      through: validationThrough, wholeGameSplit: true, baseModelsFrozen: true, parametersFrozen: true,
      selection: 'FIRST_VALID_DURABLY_SAVED_PREGAME_PREDICTION_PER_REAL_GAME_EXACT_MODEL',
      scoring: ['EXACT_SCORE_LOG_LOSS', 'CLASSWISE_1X2_FIXED_BIN_AUDIT'],
      usedGamesExcluded: inspectedGameIds, observedGames: 0, untouchedVerifiedGames: 0,
      durableFreezeVerified: false, automaticAcceptance: false, resultRetrainingAllowed: false },
    baselineChanged: false, historicalPitVerified: false, improvementEstablished: false, ...restrictions });
}

/** Apply only the exact frozen candidate to a future match. This is an isolated
 * research interface; it never registers or replaces the production baseline. */
export function predictSoccerCalibrationResearch({ candidate, model, halfTimeModel, game, now = Date.now() } = {}) {
  const eventId = game?.eventId ?? game?.sourceId;
  if (!validSeal(candidate) || candidate.status !== 'DEVELOPMENT_FIT_AVAILABLE' || candidate.accepted !== false
    || candidate.modelHash !== soccerCalibrationHash(model) || candidate.halfTimeModelHash !== soccerCalibrationHash(halfTimeModel)
    || game?.league !== candidate.league || !/^\d+$/.test(eventId || '')
    || game.eventId != null && game.sourceId != null && game.eventId !== game.sourceId
    || game.id != null && game.id !== `soccer:${game.league}:${eventId}`
    || game.homeId != null && game.home?.sourceId != null && game.homeId !== game.home.sourceId
    || game.awayId != null && game.away?.sourceId != null && game.awayId !== game.away.sourceId
    || !(now >= instant(candidate.createdAt)) || !(instant(game.startTime) > now)
    || candidate.inspectedGameIds.includes(`${game.league}:${eventId}`)) throw Error('CALIBRATION_PREDICTION_CONTEXT_INVALID');
  const normalizedGame = { ...game, eventId, homeId: game.homeId ?? game.home?.sourceId, awayId: game.awayId ?? game.away?.sourceId };
  const original = predictScoreModel(model, normalizedGame), parameters = candidate.parameters;
  const fullTime = { ...scoreDistribution(original.homeRate * parameters.fullTimeRateScales.home,
    original.awayRate * parameters.fullTimeRateScales.away, original.rho, original.tolerance),
    league: game.league, modelVersion: `${model.version}:RATE-CALIBRATION-RESEARCH-v1`,
    trainingHash: soccerCalibrationHash({ baselineTrainingHash: model.trainingHash, calibrationHash: candidate.contentHash }),
    trainedThrough: candidate.createdAt, calibrationHash: candidate.contentHash, baselineModelHash: candidate.modelHash,
    status: 'RESEARCH_ONLY', formalEnabled: false, executable: false };
  const calibratedHalfTimeModel = { ...halfTimeModel, shares: { ...parameters.halfTimeGoalShares },
    trainingHash: soccerCalibrationHash({ baselineTrainingHash: halfTimeModel.trainingHash, calibrationHash: candidate.contentHash }) };
  const halfTime = { ...predictHalfTimeDistribution(fullTime, calibratedHalfTimeModel, normalizedGame), calibrationHash: candidate.contentHash,
    trainedThrough: candidate.createdAt, baselineModelHash: candidate.halfTimeModelHash };
  return { fullTime, halfTime, original, ...restrictions };
}

/** The plan can be committed now, before later matches occur. A content hash
 * or a declared date alone is not evidence of that external durable freeze. */
export function buildSoccerCalibrationValidationPlan(candidate) {
  if (!validSeal(candidate) || candidate.status !== 'DEVELOPMENT_FIT_AVAILABLE') throw Error('CALIBRATION_PLAN_CANDIDATE_INVALID');
  return seal({ version: SOCCER_CALIBRATION_RESEARCH_VERSION, type: 'CALIBRATION_PROSPECTIVE_VALIDATION_PLAN',
    league: candidate.league, candidateHash: candidate.contentHash, modelHash: candidate.modelHash,
    halfTimeModelHash: candidate.halfTimeModelHash, jointHalfTimeModelHash: candidate.jointHalfTimeModelHash,
    createdAt: candidate.createdAt, beginsStrictlyAfter: candidate.createdAt, through: candidate.prospectiveValidation.through,
    selection: candidate.prospectiveValidation.selection, usedGamesExcluded: [...candidate.inspectedGameIds],
    immutableCandidateRequired: true, immutablePregamePredictionRequired: true, fullResultDocumentsRequired: true,
    wholeGameSplit: true, resultRetrainingAllowed: false, automaticAcceptance: false, ...restrictions });
}

/** Research validation intake. Trusted adapters must verify the actual durable
 * freeze AND actual immutable pregame capture receipt. Request booleans/hashes
 * never substitute for these callbacks. Result bytes are independently parsed
 * and normalized again. No validation statistic promotes the candidate. */
export function evaluateSoccerCalibrationProspectiveValidation({ candidate, plan, model, halfTimeModel, freezeReceipt,
  records = [], verifyFreezeReceipt = null, verifyCaptureReceipt = null, requestedScopeComplete = false, now = Date.now() } = {}) {
  if (!validSeal(candidate) || !validSeal(plan) || plan.type !== 'CALIBRATION_PROSPECTIVE_VALIDATION_PLAN'
    || plan.candidateHash !== candidate.contentHash || soccerCalibrationHash(plan) !== soccerCalibrationHash(buildSoccerCalibrationValidationPlan(candidate))
    || candidate.modelHash !== soccerCalibrationHash(model) || candidate.halfTimeModelHash !== soccerCalibrationHash(halfTimeModel)
    || !Number.isFinite(now) || instant(candidate.createdAt) > now) throw Error('CALIBRATION_VALIDATION_CONTEXT_INVALID');
  const reasons = {}, exclusions = [], accepted = new Map(), scoreSignatures = new Map(), quarantined = new Set();
  const exclude = (reason, eventId = null) => { reasons[reason] = (reasons[reason] || 0) + 1; exclusions.push({ eventId, reason }); };
  const frozenAt = instant(freezeReceipt?.frozenAt);
  let frozen = false;
  if (typeof verifyFreezeReceipt === 'function' && Number.isFinite(frozenAt) && frozenAt >= instant(candidate.createdAt) && frozenAt <= now) {
    try { frozen = verifyFreezeReceipt({ receipt: freezeReceipt, candidateHash: candidate.contentHash, planHash: plan.contentHash }) === true; } catch {}
  }
  if (!frozen) exclude('CALIBRATION_DURABLE_FREEZE_NOT_VERIFIED');
  for (const record of records) {
    const capture = record?.prediction, game = capture?.game, eventId = game?.eventId ?? game?.sourceId;
    let trustedGameKey = null;
    try {
      if (!frozen) throw Error('CALIBRATION_DURABLE_FREEZE_NOT_VERIFIED');
      const capturedAt = instant(capture?.capturedAt), kickoff = instant(game?.startTime);
      if (!Number.isFinite(capturedAt) || !Number.isFinite(kickoff) || !(capturedAt > instant(plan.beginsStrictlyAfter))
        || capturedAt < frozenAt || capturedAt >= kickoff || capturedAt > now || kickoff >= now
        || plan.through !== null && kickoff >= instant(plan.through)) throw Error('CALIBRATION_VALIDATION_PREGAME_TIME_INVALID');
      if (capture.candidateHash !== candidate.contentHash || game.league !== plan.league || !/^\d+$/.test(eventId || '')
        || plan.usedGamesExcluded.includes(`${game.league}:${eventId}`)) throw Error('CALIBRATION_VALIDATION_GAME_ALREADY_USED_OR_SCOPE_INVALID');
      if (typeof verifyCaptureReceipt !== 'function' || verifyCaptureReceipt({ receipt: record.captureReceipt,
        predictionHash: soccerCalibrationHash(capture), capturedAt: capture.capturedAt }) !== true)
        throw Error('CALIBRATION_PREGAME_DATABASE_RECEIPT_NOT_VERIFIED');
      const expected = predictSoccerCalibrationResearch({ candidate, model, halfTimeModel, game, now: capturedAt });
      if (soccerCalibrationHash(capture.fullTime) !== soccerCalibrationHash(expected.fullTime)
        || soccerCalibrationHash(capture.halfTime) !== soccerCalibrationHash(expected.halfTime)) throw Error('CALIBRATION_SAVED_PREDICTION_RECOMPUTE_FAILED');
      trustedGameKey = `${game.league}:${eventId}`;
      const date = new Date(kickoff).toISOString().slice(0, 10), dataset = buildSoccerCalibrationRows({ ...record.resultDocuments, league: game.league, from: date, through: date, now });
      const row = dataset.rows.find(value => value.eventId === eventId);
      if (!row && dataset.excluded.some(value => value.eventId === eventId && ['HALF_TIME_SUMMARY_FT_REVISION_OR_IDENTITY_MISMATCH', 'CALIBRATION_RESULT_DOCUMENT_CONFLICT'].includes(value.reason)))
        throw Error('CALIBRATION_VALIDATION_RESULT_REVISION_CONFLICT');
      if (!row || instant(row.startTime) !== kickoff || row.homeId !== (game.homeId ?? game.home?.sourceId)
        || row.awayId !== (game.awayId ?? game.away?.sourceId)
        || Boolean(row.neutralSite) !== Boolean(game.neutralSite)
        || [row.source.fetchedAt, row.halfTime.source.fetchedAt].some(time => instant(time) <= kickoff)) throw Error('CALIBRATION_VALIDATION_RESULT_SCOPE_INVALID');
      const key = gameKey(row), signature = scoreKey(row), previous = scoreSignatures.get(key);
      if (previous && previous !== signature) quarantined.add(key);
      scoreSignatures.set(key, signature);
      if (!accepted.has(key) || capturedAt < accepted.get(key).capturedAt) accepted.set(key, { row, expected, capturedAt });
    } catch (error) {
      if (trustedGameKey && ['CALIBRATION_RESULT_DOCUMENT_CONFLICT', 'CALIBRATION_GAME_RESULT_CONFLICT', 'CALIBRATION_VALIDATION_RESULT_REVISION_CONFLICT'].includes(error.message))
        quarantined.add(trustedGameKey);
      exclude(error.message, eventId);
    }
  }
  for (const key of quarantined) { accepted.delete(key); exclude('CALIBRATION_VALIDATION_CONFLICTING_GAME_RESULT', key); }
  const before = { FT: [], HT: [] }, after = { FT: [], HT: [] };
  for (const { row, expected } of accepted.values()) {
    const common = { league: row.league, eventId: row.eventId }, actual = { FT: { home: row.homeGoals, away: row.awayGoals }, HT: { home: row.halfTime.home, away: row.halfTime.away } };
    const originalHalfTime = predictHalfTimeDistribution(expected.original, halfTimeModel, row);
    for (const period of ['FT', 'HT']) {
      before[period].push({ ...common, actualScore: actual[period], distribution: period === 'FT' ? expected.original : originalHalfTime });
      after[period].push({ ...common, actualScore: actual[period], distribution: period === 'FT' ? expected.fullTime : expected.halfTime });
    }
  }
  return seal({ version: SOCCER_CALIBRATION_RESEARCH_VERSION, type: 'CALIBRATION_PROSPECTIVE_VALIDATION_REPORT',
    league: plan.league, candidateHash: candidate.contentHash, planHash: plan.contentHash, checkedAt: new Date(now).toISOString(),
    status: accepted.size ? 'PROSPECTIVE_DESCRIPTIVE_OBSERVATIONS' : 'MISSING_VERIFIED_PROSPECTIVE_OBSERVATIONS',
    receivedRecords: records.length, untouchedVerifiedGames: accepted.size, quarantinedGames: quarantined.size,
    durableFreezeVerified: frozen, completeWithinRequestedScope: requestedScopeComplete === true, excludedReasons: reasons, exclusions,
    before: { FT: summarizePredictions(before.FT, 'REGULATION_FT', candidate.modelHash, 'CALIBRATION_PROSPECTIVE_FROZEN'), HT: summarizePredictions(before.HT, 'REGULATION_HT', candidate.jointHalfTimeModelHash, 'CALIBRATION_PROSPECTIVE_FROZEN') },
    after: { FT: summarizePredictions(after.FT, 'REGULATION_FT', candidate.calibratedModelHashes.FT, 'CALIBRATION_PROSPECTIVE_FROZEN'), HT: summarizePredictions(after.HT, 'REGULATION_HT', candidate.calibratedModelHashes.HT, 'CALIBRATION_PROSPECTIVE_FROZEN') },
    interpretation: 'PAIRED_FROZEN_CANDIDATE_DESCRIPTIVE_TEST_NOT_AUTOMATIC_ACCEPTANCE_OR_IMPROVEMENT_CLAIM',
    improvementEstablished: false, ...restrictions });
}
