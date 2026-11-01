import { fetchSoccerJson, normalizeSoccerSchedule } from './data.js';
import { createHash } from 'node:crypto';
import { normalizeSoccerSettlementResult } from './settlement-result.js';
import { soccerLeague } from './contracts.js';
import { evaluateSoccerCalibrationProspectiveValidation, soccerCalibrationHash, soccerCalibrationHasExtraPeriods } from './calibration-research.js';
import { getSoccerCalibrationShadowReport, loadSoccerCalibrationShadowValidationEvidence,
  listSoccerCalibrationShadowCaptureIds } from './calibration-shadow-store.js';
import { archiveSoccerCalibrationShadowEvaluation, loadSoccerCalibrationShadowEvaluationHistory,
  listSoccerCalibrationShadowPendingCaptureIds, SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION } from './calibration-shadow-evaluation-store.js';

const restrictions = { accepted: false, formalEligible: false, promotionEligible: false, executable: false,
  baselineChanged: false, W: null, R: null, S: null, empiricalErrorMargin: null };
const dependencies = { fetchJson: fetchSoccerJson, baseReport: getSoccerCalibrationShadowReport,
  loadEvidence: loadSoccerCalibrationShadowValidationEvidence, listCaptureIds: listSoccerCalibrationShadowCaptureIds,
  readHistory: loadSoccerCalibrationShadowEvaluationHistory, archive: archiveSoccerCalibrationShadowEvaluation,
  listPending: listSoccerCalibrationShadowPendingCaptureIds, now: Date.now };
const iso = value => new Date(value).toISOString();
const gameKey = record => record.prediction.game.id;
const bad = () => Object.assign(Error('CALIBRATION_SHADOW_VALIDATION_SCOPE_INVALID'), { status: 400 });
const unavailable = reason => Object.assign(Error(reason || 'CALIBRATION_SHADOW_VALIDATION_STORAGE_UNAVAILABLE'), { status: 503 });
function leagueScope(value) {
  if (!['epl', 'ucl'].includes(value)) throw bad();
  return soccerLeague(value);
}

function normalResult(game, documents, checkedAt) {
  const league = leagueScope(game.league), now = Date.parse(checkedAt);
  if (!documents?.scoreboard?.ok || !Array.isArray(documents.summaries) || !documents.summaries.length)
    return { ok: false, reason: 'CALIBRATION_RESULT_DOCUMENTS_UNAVAILABLE' };
  for (const [index, document] of [documents.scoreboard, ...documents.summaries].entries()) {
    if (document?.ok !== true || document.source?.provider !== 'ESPN' || !document.data
      || document.source.contentHash !== createHash('sha256').update(JSON.stringify(document.data)).digest('hex')
      || !(Date.parse(document.source.fetchedAt) > Date.parse(game.startTime)) || Date.parse(document.source.fetchedAt) > now)
      return { ok: false, reason: 'CALIBRATION_RESULT_DOCUMENT_HASH_OR_TIME_INVALID' };
    try {
      const url = new URL(document.source.url), kind = index === 0 ? 'scoreboard' : 'summary';
      if (url.protocol !== 'https:' || url.hostname !== 'site.api.espn.com' || url.username || url.password || url.port || url.hash
        || url.pathname !== `/apis/site/v2/sports/soccer/${league.espnSlug}/${kind}`
        || kind === 'summary' && url.searchParams.get('event') !== game.sourceId)
        return { ok: false, reason: 'CALIBRATION_RESULT_DOCUMENT_URL_INVALID' };
    } catch { return { ok: false, reason: 'CALIBRATION_RESULT_DOCUMENT_URL_INVALID' }; }
  }
  const board = normalizeSoccerSchedule(documents.scoreboard.data, league.id, documents.scoreboard.source);
  if (!board.ok) return { ok: false, reason: 'CALIBRATION_RESULT_BOARD_SCOPE_INVALID' };
  const boardEvent = documents.scoreboard.data.events.find(event => String(event?.id) === game.sourceId);
  const contextChanged = (observed, competition) => observed && (observed.startTime !== game.startTime
    || ['home', 'away'].some(side => observed[side]?.id !== game[side]?.id)
    || typeof competition?.neutralSite === 'boolean' && competition.neutralSite !== game.neutralSite);
  // A verified reschedule or identity correction invalidates the original
  // prediction's scope even when the corrected event is no longer final.
  // Normalize both endpoints first so numeric IDs or malformed UIDs cannot
  // manufacture a contradiction with an otherwise unchanged game.
  const explicitContextConflict = contextChanged(board.games.find(event => event.id === game.id), boardEvent?.competitions?.[0])
    || documents.summaries.some(document => {
      const header = document.data.header, competition = header?.competitions?.[0];
      const normalized = normalizeSoccerSchedule({ leagues: [header?.league],
        events: [{ ...header, date: competition?.date, status: competition?.status }] }, league.id, document.source);
      return normalized.ok && contextChanged(normalized.games.find(event => event.id === game.id), competition);
    });
  if (explicitContextConflict) return { ok: false, quarantine: true, reason: 'CALIBRATION_RESULT_CONTEXT_CHANGED' };
  // Both provider endpoints can carry period evidence at different levels.
  // Use only the normalized matching event, never another game on the board.
  const explicitExtra = board.games.some(event => event.id === game.id) && soccerCalibrationHasExtraPeriods(boardEvent)
    || documents.summaries.some(document => {
      const header = document?.data?.header, competition = header?.competitions?.[0];
      if (String(header?.id) !== game.sourceId || String(header?.league?.id) !== league.espnId
        || header.league.slug !== league.espnSlug) return false;
      const normalized = normalizeSoccerSchedule({ leagues: [header.league],
        events: [{ ...header, date: competition?.date, status: competition?.status }] }, league.id, document.source);
      return normalized.ok && normalized.games.some(event => event.id === game.id)
        && soccerCalibrationHasExtraPeriods(document.data, competition);
    });
  if (explicitExtra) return { ok: false, quarantine: true, reason: 'RESULT_EXTRA_PERIODS_REQUIRE_REVIEW' };
  const checks = documents.summaries.map(summary => normalizeSoccerSettlementResult({ league: league.id, gameId: game.id,
    date: game.date, startTime: game.startTime, teamIds: { home: game.home.id, away: game.away.id } }, summary, board, now));
  const contradictions = new Set(['RESULT_ENDPOINTS_DISAGREE', 'RESULT_EXTRA_PERIODS_REQUIRE_REVIEW', 'RESULT_REGULATION_FORMAT_UNVERIFIED']);
  const conflict = checks.find(value => contradictions.has(value.reason));
  if (conflict) return { ...conflict, quarantine: true };
  const usable = checks.filter(value => value.ok && value.halfTime?.verified === true);
  if (usable.length && usable.some(value => soccerCalibrationHash([value.fullTime, value.halfTime.home, value.halfTime.away])
    !== soccerCalibrationHash([usable[0].fullTime, usable[0].halfTime.home, usable[0].halfTime.away])))
    return { ok: false, quarantine: true, reason: 'CALIBRATION_CONFLICTING_NORMAL_FINAL_RESULTS' };
  return usable[0] || { ok: false, reason: checks.find(value => !value.ok)?.reason || 'CALIBRATION_HALF_TIME_RESULT_PENDING' };
}

async function fetchResultDocuments(game, deps, deadline) {
  const league = leagueScope(game.league), eventId = game.sourceId;
  if (!/^\d{1,16}$/.test(eventId || '') || game.id !== `soccer:${league.id}:${eventId}`) throw bad();
  const remaining = deadline - deps.now();
  if (remaining <= 0) return { documents: null, reason: 'CALIBRATION_VALIDATION_TIME_BUDGET', budget: true };
  const date = new Date(game.startTime).toISOString().slice(0, 10).replaceAll('-', '');
  const options = { ttlMs: 0, timeoutMs: Math.min(8000, remaining), now: deps.now };
  const [summary, scoreboard] = await Promise.all([
    deps.fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${eventId}`, options),
    deps.fetchJson(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/scoreboard?dates=${date}&limit=1000`, options),
  ]);
  const documents = { scoreboard, summaries: [summary] };
  return { documents, reason: !summary.ok ? summary.code : !scoreboard.ok ? scoreboard.code : null };
}

/** Rebuild from complete immutable check history, never stored PASS flags. */
function replay(context, history, { current = [], now = Date.now() } = {}) {
  const captures = new Map(context.records.map(record => [record.captureReceipt.captureId, record]));
  const records = [], blocked = new Set();
  for (const check of [...history, ...current]) {
    const original = captures.get(check.captureId);
    if (!original) throw unavailable('CALIBRATION_CHECK_CAPTURE_SCOPE_MISMATCH');
    if (!check.resultDocuments) continue;
    const sourceTimes = [check.resultDocuments.scoreboard, ...(check.resultDocuments.summaries || [])]
      .filter(value => value?.ok).map(value => Date.parse(value.source?.fetchedAt));
    if (!Number.isFinite(Date.parse(check.checkedAt)) || Date.parse(check.checkedAt) > now
      || sourceTimes.some(time => !Number.isFinite(time) || time > Date.parse(check.checkedAt)))
      throw unavailable('CALIBRATION_RESULT_RECEIPT_TIME_INVALID');
    const result = normalResult(original.prediction.game, check.resultDocuments, check.checkedAt);
    if (result.quarantine) blocked.add(gameKey(original));
    if (result.ok) records.push({ ...original, resultDocuments: check.resultDocuments });
  }
  const grouped = new Map();
  for (const record of records) { const key = gameKey(record); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(record); }
  for (const [key, gameRecords] of grouped) if (evaluateSoccerCalibrationProspectiveValidation({ ...context,
    records: gameRecords, requestedScopeComplete: true, now }).quarantinedGames) blocked.add(key);
  // Scope conflicts/extra-period evidence also remove an older valid result.
  // Recompute after removal so no contradictory game's loss enters metrics.
  const filtered = evaluateSoccerCalibrationProspectiveValidation({ ...context,
    records: records.filter(record => !blocked.has(gameKey(record))), requestedScopeComplete: true, now });
  return { ...filtered, quarantinedGames: blocked.size, resultScopeQuarantinedGames: blocked.size };
}

/** Server-only bounded execution. Requests provide league/action only; all
 * predictions, identities, URLs and receipts come from immutable server data. */
export async function evaluateSoccerCalibrationShadow({ league, limit = 3 } = {}, overrides = {}) {
  leagueScope(league);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 3) throw bad();
  const deps = { ...dependencies, ...overrides }, started = deps.now(), deadline = started + 18000;
  const initial = await deps.loadEvidence(league, { limit: 1 });
  const summary = { version: SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION, league, status: 'NO_PENDING_CAPTURES',
    checkedGames: 0, validatedGames: 0, pendingGames: 0, quarantinedGames: 0, budgetExhausted: false, persisted: true, ...restrictions };
  if (!initial.freezeReceipt) return { summary, report: null };
  const ids = await deps.listPending(league, { limit, freezeId: initial.freezeReceipt.freezeId });
  if (!ids.length) return { summary, report: null };
  const context = await deps.loadEvidence(league, { limit: 100, captureIds: ids });
  if (context.records.length !== ids.length) throw unavailable('CALIBRATION_PENDING_CAPTURE_READ_INCOMPLETE');
  const history = await deps.readHistory(league, { captureIds: ids });
  const current = await Promise.all(context.records.map(async record => {
    const captureId = record.captureReceipt.captureId, game = record.prediction.game;
    if (Date.parse(game.startTime) >= deps.now()) return { captureId, checkedAt: iso(deps.now()), resultDocuments: null, reason: 'CALIBRATION_MATCH_NOT_FINISHED' };
    const result = await fetchResultDocuments(game, deps, deadline);
    return { captureId, checkedAt: iso(deps.now()), resultDocuments: result.documents, reason: result.reason, budget: result.budget };
  }));
  let report = replay(context, history, { current, now: deps.now() });
  for (const check of current) {
    const isolated = replay({ ...context, records: context.records.filter(record => record.captureReceipt.captureId === check.captureId) },
      history.filter(value => value.captureId === check.captureId), { current: [check], now: deps.now() });
    const status = isolated.quarantinedGames ? 'QUARANTINED' : isolated.untouchedVerifiedGames ? 'EVALUATED' : 'PENDING';
    // Store complete provider documents even for pending normal-final checks.
    // A transport/storage failure is explicit; it is never a successful check.
    const receipt = await deps.archive({ league, captureId: check.captureId, resultDocuments: check.resultDocuments,
      status, report: isolated, reason: check.reason || null });
    if (receipt?.persisted !== true) throw unavailable('CALIBRATION_CHECK_NOT_DURABLY_SAVED');
    summary.checkedGames++; summary.budgetExhausted ||= check.budget === true;
    if (status === 'QUARANTINED') summary.quarantinedGames++;
    else if (status === 'EVALUATED') summary.validatedGames++;
    else summary.pendingGames++;
  }
  // Read the actual persisted receipt times and full history once more. A
  // concurrent check may have supplied a contradictory result while we fetched.
  const stored = await deps.readHistory(league, { captureIds: ids });
  report = replay(context, stored, { now: deps.now() });
  summary.validatedGames = report.untouchedVerifiedGames;
  summary.quarantinedGames = report.quarantinedGames;
  summary.pendingGames = Math.max(0, summary.checkedGames - summary.validatedGames - summary.quarantinedGames);
  summary.budgetExhausted ||= deps.now() >= deadline;
  summary.status = summary.validatedGames || summary.quarantinedGames ? 'EVALUATED' : 'PENDING';
  return { summary, report: { ...report, completeWithinRequestedScope: false, scope: 'THIS_BOUNDED_SERVER_BATCH' } };
}

function mergeMetric(left, right) {
  const a = left?.games || 0, b = right?.games || 0, games = a + b, result = { games };
  for (const key of ['scoreLogLoss', 'logLoss', 'brier']) {
    const state = key === 'brier' ? null : `${key}State`, infinite = state && [left?.[state], right?.[state]].includes('POSITIVE_INFINITY');
    result[key] = !games || infinite ? null : ((a ? left[key] * a : 0) + (b ? right[key] * b : 0)) / games;
    if (state) result[state] = !games ? 'UNAVAILABLE' : infinite ? 'POSITIVE_INFINITY' : 'FINITE';
  }
  return result;
}

/** GET aggregation revalidates actual immutable capture/result histories and
 * pages every capture sequence. Database errors propagate as unknown. */
export async function readSoccerCalibrationShadowReport(league, overrides = {}) {
  leagueScope(league);
  const deps = { ...dependencies, ...overrides }, base = await deps.baseReport(league), deadline = deps.now() + 18000;
  const aggregate = { version: SOCCER_CALIBRATION_SHADOW_EVALUATION_VERSION, league, untouchedVerifiedGames: 0,
    quarantinedGames: 0, before: { FT: { games: 0 }, HT: { games: 0 } }, after: { FT: { games: 0 }, HT: { games: 0 } }, ...restrictions };
  let afterSequence = '0', readCaptures = 0, complete = false;
  do {
    const page = await deps.listCaptureIds(league, { afterSequence, limit: 5 });
    if (page.captureIds.length) {
      const context = await deps.loadEvidence(league, { captureIds: page.captureIds, limit: 5 });
      if (context.records.length !== page.captureIds.length) throw unavailable('CALIBRATION_CAPTURE_HISTORY_READ_INCOMPLETE');
      const history = await deps.readHistory(league, { captureIds: page.captureIds });
      const report = replay(context, history, { now: deps.now() });
      aggregate.untouchedVerifiedGames += report.untouchedVerifiedGames; aggregate.quarantinedGames += report.quarantinedGames;
      for (const arm of ['before', 'after']) for (const period of ['FT', 'HT']) aggregate[arm][period] = mergeMetric(aggregate[arm][period], report[arm][period]);
      readCaptures += context.records.length;
    }
    if (page.completeWithinRequestedScope && page.nextSequence === null) { complete = true; break; }
    if (!page.nextSequence || BigInt(page.nextSequence) <= BigInt(afterSequence)) throw unavailable('CALIBRATION_CAPTURE_HISTORY_CURSOR_DID_NOT_ADVANCE');
    afterSequence = page.nextSequence;
  } while (deps.now() < deadline);
  if (complete && (!Number.isSafeInteger(base.captureGames) || readCaptures !== base.captureGames))
    throw unavailable('CALIBRATION_CAPTURE_COUNT_CHANGED_DURING_READ');
  return { ...base, untouchedValidatedGames: aggregate.untouchedVerifiedGames, quarantinedGames: aggregate.quarantinedGames,
    fullTimeValidatedGames: aggregate.untouchedVerifiedGames, halfTimeValidatedGames: aggregate.untouchedVerifiedGames,
    pendingValidationGames: Math.max(0, base.captureGames - aggregate.untouchedVerifiedGames - aggregate.quarantinedGames),
    validationStatus: !complete ? 'PARTIAL_HISTORY_READ' : aggregate.quarantinedGames ? 'CONFLICTS_QUARANTINED'
      : aggregate.untouchedVerifiedGames ? 'PROSPECTIVE_OBSERVATIONS_AVAILABLE' : base.captureGames ? 'PENDING_RESULTS' : 'AWAITING_PREGAME_CAPTURES',
    validationCoverage: { completeWithinRequestedScope: complete, readCaptures, totalCaptures: base.captureGames },
    validation: { ...aggregate, completeWithinRequestedScope: complete, interpretation: 'PAIRED_DESCRIPTIVE_FUTURE_VALIDATION_NOT_AUTOMATIC_ACCEPTANCE' },
    ...restrictions };
}
