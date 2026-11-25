import { soccerLeague, validSoccerDate } from './contracts.js';
import { publishSoccerAnalysisCandidates } from './candidate-publication.js';
import { fetchSoccerSchedule } from './data.js';
import { fetchSoccerPrematch } from './prematch.js';
import { fetchSoccerTeamXg, unavailableSoccerTeamXg } from './team-xg.js';
import { archiveSoccerTeamXg, unavailableSoccerTeamXgArchive } from './team-xg-store.js';
import { archiveSoccerSourceDocument, unavailableSoccerSourceDocumentArchive, restoreSoccerCurrentSourceAvailability } from './source-document-store.js';
import { fetchSoccerWorkload } from './workload.js';
import { loadSoccerReaderSnapshot } from './reader-store.js';
import { buildSoccerReaderDiagnostics } from './reader-diagnostics.js';
import { buildSoccerAnalysis, soccerAnalysisHash } from './analysis.js';
import { saveSoccerAnalysis, listSoccerAnalysis } from './analysis-store.js';
import { ensureSoccerForwardProtocol, captureSoccerForwardSnapshot } from './forward-validation-service.js';
import { beginSoccerAnalysisRun, finishSoccerAnalysisRun, recordSoccerCohort,
  ensureSoccerJournal, soccerJournalQuery, getSoccerCurrentResearchStatus } from './journal.js';
import { captureSoccerCalibrationShadow } from './calibration-shadow-store.js';
import { fetchSoccerWeather } from './weather.js';
import { enrichSoccerPrematchInputs, restoreSoccerPrematchInputAvailability, SOCCER_PREMATCH_INPUT_TIMEOUT_MS } from './prematch-inputs.js';
import { ensureSoccerMinutesForwardProtocol, captureSoccerMinutesForward } from './minutes-forward-validation.js';

export function validSoccerAnalysisQuery(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['league', 'date', 'eventId'].includes(key))
    && soccerLeague(value.league) && validSoccerDate(value.date)
    && typeof value.eventId === 'string' && /^[1-9]\d{0,15}$/.test(value.eventId)
    && Number.isSafeInteger(Number(value.eventId)) && Number(value.eventId) > 0);
}

async function optional(operation, fallback) {
  try { return await operation(); } catch { return fallback; }
}

async function acquirePrematchEvidence(game, deps) {
  const evidence = await deps.fetchSoccerPrematch(game);
  if (!evidence.ok) return { evidence };
  // Weather only needs the normalizer's private, game-bound venue proof.
  // A custom enrichment provider remains responsible for its own acquisitions.
  const weatherRequest = deps.enrichSoccerPrematchInputs === enrichSoccerPrematchInputs
    ? optional(() => deps.fetchSoccerWeather(evidence.game, { evidence, timeoutMs: SOCCER_PREMATCH_INPUT_TIMEOUT_MS }), null)
    : undefined;
  evidence.sourceDocumentArchive = await optional(
    () => deps.archiveSoccerSourceDocument(evidence), unavailableSoccerSourceDocumentArchive());
  return { evidence, weatherRequest };
}

// The authenticated single-game route and durable workflow share this service.
// The model, journal qualification, immutable save and publication checks are
// identical; the transport never supplies odds, settings or execution flags.
export async function analyzeSoccerGame(query, overrides = {}) {
  const deps = { fetchSoccerSchedule, fetchSoccerPrematch, fetchSoccerWeather, fetchSoccerTeamXg, archiveSoccerTeamXg, fetchSoccerWorkload, loadSoccerReaderSnapshot,
    buildSoccerAnalysis, soccerAnalysisHash, saveSoccerAnalysis, listSoccerAnalysis,
    beginSoccerAnalysisRun, finishSoccerAnalysisRun, recordSoccerCohort, getSoccerCurrentResearchStatus,
    ensureSoccerForwardProtocol, captureSoccerForwardSnapshot, captureSoccerCalibrationShadow, archiveSoccerSourceDocument,
    enrichSoccerPrematchInputs, ensureSoccerMinutesForwardProtocol, captureSoccerMinutesForward, ...overrides };
  if (!validSoccerAnalysisQuery(query)) return { status: 400, payload: { ok: false, error: '足球分析條件無效',
    formalScoringEnabled: false, executable: false } };
  const league = soccerLeague(query.league), { date, eventId } = query;
  let run = null;
  const failure = async (error, status, analysisStatus = 'INSUFFICIENT_DATA', code = null) => {
    let journalPersisted = false;
    if (run) {
      try { await deps.finishSoccerAnalysisRun(run, { analysisStatus, qaFlag: 'BLOCKED', reasons: [code || 'SOCCER_SOURCE_UNAVAILABLE'] }); journalPersisted = true; }
      catch {}
    }
    return { status, payload: { ok: false, error, code, analysisRunId: run?.runId || null,
      analysisStatus, qaFlag: 'BLOCKED', selectionResult: null, publishedCurrent: false,
      journalPersisted, formalScoringEnabled: false, executable: false } };
  };
  try {
    // Prospective policy is activated before this run. A failure is visible
    // through its separate receipt and does not change analysis publication.
    const [forwardProtocol, minutesProtocol] = await Promise.allSettled([
      Promise.resolve().then(() => deps.ensureSoccerForwardProtocol()),
      Promise.resolve().then(() => deps.ensureSoccerMinutesForwardProtocol(league.id)),
    ]);
    run = await deps.beginSoccerAnalysisRun({ league: league.id, date, gameId: `soccer:${league.id}:${eventId}` });
    const board = await deps.fetchSoccerSchedule(league.id, date);
    if (!board.ok) return failure('賽程資料暫時無法核對', 503, 'INSUFFICIENT_DATA', board.code);
    await deps.recordSoccerCohort(board.games);
    const game = board.games.find(value => value.sourceId === eventId && value.league === league.id && value.date === date
      && value.id === `soccer:${league.id}:${eventId}`);
    if (!game) return failure('找不到同聯盟同日期的場次', 404, 'INSUFFICIENT_DATA', 'SOCCER_GAME_NOT_FOUND');
    const [{ evidence, weatherRequest }, workload, teamXg] = await Promise.all([
      acquirePrematchEvidence(game, deps),
      deps.fetchSoccerWorkload(game, { timeoutMs: 8000 }).catch(() => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [], modelEffectApplied: false, executable: false })),
      Promise.resolve().then(() => deps.fetchSoccerTeamXg(game, { timeoutMs: 8000 })).catch(() => unavailableSoccerTeamXg('TEAM_XG_SOURCE_UNAVAILABLE', game)),
    ]);
    if (!evidence.ok) return failure('賽前資料身分或來源核對未通過', 503, 'INSUFFICIENT_DATA', evidence.code);
    // Current team aggregates remain a separate provider observation. Archive
    // the actual fetch proof before saving; unavailable storage never becomes a
    // successful receipt or changes the fitted score distributions.
    const xgScope = teamXg?.ok === true && teamXg.status === 'PROVIDER_REPORTED'
      && teamXg.gameId === game.id && teamXg.league === game.league && teamXg.date === game.date && teamXg.startTime === game.startTime
      && ['home', 'away'].every(side => teamXg.teams?.[side]?.sourceId === game[side].sourceId)
      && teamXg.modelEffectApplied === false && teamXg.formalEligible === false && teamXg.executable === false;
    evidence.xg = xgScope ? teamXg : unavailableSoccerTeamXg(teamXg?.ok === true ? 'TEAM_XG_GAME_SCOPE_MISMATCH' : teamXg?.reason, game);
    if (xgScope) {
      try { evidence.xg.sourceDocumentArchive = await deps.archiveSoccerTeamXg(evidence.xg); }
      catch { evidence.xg.sourceDocumentArchive = unavailableSoccerTeamXgArchive(); }
    }
    // The prematch normalizer derives its game from the summary response;
    // game.source therefore identifies that summary, not this original board.
    // Preserve the verified schedule receipt separately before the model/save.
    evidence.scheduleSource = game.source ? { ...game.source } : null;
    evidence.workload = workload;
    try { await deps.enrichSoccerPrematchInputs(evidence, { game: evidence.game, workload, weatherRequest }); }
    catch { evidence.prematchInputConnection = { status: 'UNAVAILABLE', reason: 'PREMATCH_INPUT_CONNECTION_FAILED',
      formalEligible: false, modelEffectApplied: false, executable: false }; }
    // Both reads stay after evidence enrichment, close to the scoring cutoff.
    // Personnel comparison consumes only the latest verified prior revision.
    const [readerRead, versions] = await Promise.allSettled([
      Promise.resolve().then(() => deps.loadSoccerReaderSnapshot(league.id, date)),
      Promise.resolve().then(() => deps.listSoccerAnalysis(league.id, game.id, date, { limit: 1 })),
    ]);
    const readerUnavailable = readerRead.status === 'rejected';
    const reader = readerUnavailable ? null : readerRead.value;
    const previous = versions.status === 'fulfilled' ? versions.value?.[0] || null : undefined;
    const analysisNow = Date.now();
    const readerDiagnostics = buildSoccerReaderDiagnostics({ reader, game: evidence.game, schedule: board, unavailable: readerUnavailable, now: analysisNow });
    const built = deps.buildSoccerAnalysis({ evidence, reader, schedule: board, previous, now: analysisNow });
    const { analysisHash: discardedHash, ...body } = built;
    const evidenceExpiry = Date.parse(evidence.source.fetchedAt) + 180000;
    const validUntil = new Date(body.status === 'RESEARCH_ONLY' ? Math.min(evidenceExpiry, Date.parse(game.startTime)) : evidenceExpiry).toISOString();
    const result = { ...body, readerUnavailable, readerDiagnostics, analysisRunId: run.runId, qualificationVersion: run.requestSeq,
      quoteGeneration: run.quoteGeneration, runStartedAt: run.startedAt, validUntil };
    result.analysisHash = deps.soccerAnalysisHash(result);
    const saved = await deps.saveSoccerAnalysis(result);
    // Each research ledger checks the same immutable save independently. Wait
    // for all three receipts before publication, including explicit failures.
    const calibrationUnavailable = { status: 'NOT_CAPTURED', persisted: false, reason: 'CALIBRATION_SHADOW_STORAGE_UNAVAILABLE',
      formalEligible: false, executable: false };
    const minutesUnavailable = { status: 'NOT_CAPTURED', persisted: false, reason: 'MINUTES_FORWARD_STORAGE_UNAVAILABLE',
      formalEligible: false, executable: false };
    const forwardUnavailable = { status: 'NOT_CAPTURED', persisted: false, reason: 'FORWARD_STORAGE_UNAVAILABLE' };
    const [calibrationShadowCapture, minutesForwardCapture, forwardCapture] = await Promise.all([
      optional(() => deps.captureSoccerCalibrationShadow(result, saved.revision), calibrationUnavailable),
      minutesProtocol.status === 'fulfilled'
        ? optional(() => deps.captureSoccerMinutesForward(result, saved.revision), minutesUnavailable) : minutesUnavailable,
      forwardProtocol.status === 'fulfilled'
        ? optional(() => deps.captureSoccerForwardSnapshot(result, saved.revision), forwardUnavailable) : forwardUnavailable,
    ]);
    const publication = await deps.finishSoccerAnalysisRun(run, { analysisStatus: result.analysisStatus, qaFlag: result.qaFlag,
      selectionResult: result.selectionResult, revision: saved.revision,
      validUntil,
      reasons: result.predictionReason ? [result.predictionReason] : [] },
    { result, saved, forwardCapture, calibrationShadowCapture, minutesForwardCapture });
    // Publication can be superseded before either transport receives its result.
    // A failed read preserves history but cannot certify current qualification.
    let currentResearch = null;
    try { currentResearch = await deps.getSoccerCurrentResearchStatus(league.id, date, game.id); } catch {}
    const publishedCurrent = publication.publishedCurrent && currentResearch?.publishedCurrent === true
      && currentResearch.revision === saved.revision && currentResearch.analysisRunId === run.runId;
    return { status: 200, payload: publishSoccerAnalysisCandidates({ ...result, ...saved, ...publication,
      publishedCurrent, readerUnavailable, forwardCapture, calibrationShadowCapture, minutesForwardCapture, journalPersisted: true }, { currentStatus: currentResearch }) };
  } catch { return failure('足球資料核對暫時無法完成', 503, 'FAILED', 'SOCCER_ANALYSIS_OR_STORAGE_FAILED'); }
}

// Current means the qualified head, never whichever immutable attempt happened
// to finish last. Read the head and its receipt in one query so a delayed job or
// a newer Reader generation cannot restore an old result as current.
export async function loadSoccerCurrentAnalysis(leagueValue, date, eventId) {
  if (!validSoccerAnalysisQuery({ league: leagueValue, date, eventId })) throw Error('SOCCER_ANALYSIS_SCOPE_INVALID');
  const league = soccerLeague(leagueValue).id, gameId = `soccer:${league}:${eventId}`;
  await ensureSoccerJournal();
  const rows = await soccerJournalQuery(`SELECT h.requested_run_id,h.requested_seq,h.quote_generation,h.published_revision,h.valid_until,
    r.started_at,e.finished_at,e.analysis_status,e.qa_flag,e.selection_result,e.reasons,a.analysis_hash,a.payload,clock_timestamp() AS checked_at
    FROM sports_soccer_analysis_heads_v2 AS h
    JOIN sports_soccer_analysis_runs_v2 AS r ON r.run_id=h.requested_run_id
      AND r.league=h.league AND r.game_id=h.game_id AND r.board_date=h.board_date
      AND r.request_seq=h.requested_seq AND r.quote_generation=h.quote_generation
    JOIN sports_soccer_analysis_events_v2 AS e ON e.run_id=r.run_id AND e.analysis_revision=h.published_revision
    JOIN sports_soccer_analysis_v1 AS a ON a.league=h.league AND a.game_id=h.game_id AND a.analysis_hash=h.published_revision
    LEFT JOIN sports_soccer_source_heads_v2 AS s ON s.league=h.league AND s.board_date=h.board_date
    WHERE h.league=$1 AND h.game_id=$2 AND h.board_date=$3::date
      AND e.analysis_status='COMPLETED' AND e.qa_flag<>'BLOCKED' AND e.selection_result='RESEARCH_SHADOW'
      AND h.quote_generation=COALESCE(s.quote_generation,0) AND h.valid_until>clock_timestamp()`, [league, gameId, date]);
  if (!rows.length) return { currentVersion: null, currentRun: null, currentResearch: null };
  if (rows.length !== 1) throw Error('SOCCER_ANALYSIS_HEAD_CONFLICT');
  const row = rows[0], payload = row.payload;
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  if (soccerAnalysisHash(canonical(payload)) !== row.analysis_hash || payload?.league !== league || payload?.gameId !== gameId
    || payload?.date !== date || payload?.analysisRunId !== row.requested_run_id || payload?.formalScoringEnabled !== false || payload?.executable !== false)
    throw Error('SOCCER_ANALYSIS_HEAD_CORRUPTED');
  const validUntil = new Date(row.valid_until).toISOString();
  const currentStatus = { analysisRunId: row.requested_run_id, qualificationVersion: String(row.requested_seq),
    quoteGeneration: String(row.quote_generation), revision: row.analysis_hash, checkedAt: new Date(row.checked_at).toISOString(),
    validUntil, publishedCurrent: true, reason: 'ACTIVE', analysisStatus: row.analysis_status,
    selectionResult: row.selection_result, formalScoringEnabled: false, executable: false };
  await restoreSoccerCurrentSourceAvailability(payload?.evidence);
  await restoreSoccerPrematchInputAvailability(payload?.evidence);
  return {
    currentResearch: currentStatus,
    currentVersion: publishSoccerAnalysisCandidates({ ...payload, persisted: true, revision: row.analysis_hash, publishedCurrent: true,
      qualificationValidUntil: validUntil, validUntil }, { currentStatus }),
    currentRun: { analysisRunId: row.requested_run_id, startedAt: row.started_at, finishedAt: row.finished_at,
      analysisStatus: row.analysis_status, qaFlag: row.qa_flag, selectionResult: row.selection_result,
      revision: row.analysis_hash, reasons: row.reasons || [], requestSeq: String(row.requested_seq),
      quoteGeneration: String(row.quote_generation), publishedCurrent: true, validUntil },
  };
}
