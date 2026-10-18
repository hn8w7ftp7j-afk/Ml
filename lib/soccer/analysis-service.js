import { soccerLeague, validSoccerDate } from './contracts.js';
import { fetchSoccerSchedule } from './data.js';
import { fetchSoccerPrematch } from './prematch.js';
import { fetchSoccerWorkload } from './workload.js';
import { loadSoccerReaderSnapshot } from './reader-store.js';
import { buildSoccerAnalysis, soccerAnalysisHash } from './analysis.js';
import { saveSoccerAnalysis, listSoccerAnalysis } from './analysis-store.js';
import { beginSoccerAnalysisRun, finishSoccerAnalysisRun, recordSoccerCohort,
  ensureSoccerJournal, soccerJournalQuery } from './journal.js';

export function validSoccerAnalysisQuery(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => ['league', 'date', 'eventId'].includes(key))
    && soccerLeague(value.league) && validSoccerDate(value.date)
    && typeof value.eventId === 'string' && /^[1-9]\d{0,15}$/.test(value.eventId)
    && Number.isSafeInteger(Number(value.eventId)) && Number(value.eventId) > 0);
}

// The authenticated single-game route and durable workflow share this service.
// The model, journal qualification, immutable save and publication checks are
// identical; the transport never supplies odds, settings or execution flags.
export async function analyzeSoccerGame(query, overrides = {}) {
  const deps = { fetchSoccerSchedule, fetchSoccerPrematch, fetchSoccerWorkload, loadSoccerReaderSnapshot,
    buildSoccerAnalysis, soccerAnalysisHash, saveSoccerAnalysis, listSoccerAnalysis,
    beginSoccerAnalysisRun, finishSoccerAnalysisRun, recordSoccerCohort, ...overrides };
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
    run = await deps.beginSoccerAnalysisRun({ league: league.id, date, gameId: `soccer:${league.id}:${eventId}` });
    const board = await deps.fetchSoccerSchedule(league.id, date);
    if (!board.ok) return failure('賽程資料暫時無法核對', 503, 'INSUFFICIENT_DATA', board.code);
    await deps.recordSoccerCohort(board.games);
    const game = board.games.find(value => value.sourceId === eventId && value.league === league.id && value.date === date
      && value.id === `soccer:${league.id}:${eventId}`);
    if (!game) return failure('找不到同聯盟同日期的場次', 404, 'INSUFFICIENT_DATA', 'SOCCER_GAME_NOT_FOUND');
    const [evidence, workload] = await Promise.all([
      deps.fetchSoccerPrematch(game),
      deps.fetchSoccerWorkload(game, { timeoutMs: 8000 }).catch(() => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [], modelEffectApplied: false, executable: false })),
    ]);
    if (!evidence.ok) return failure('賽前資料身分或來源核對未通過', 503, 'INSUFFICIENT_DATA', evidence.code);
    evidence.workload = workload;
    let reader = null, readerUnavailable = false;
    try { reader = await deps.loadSoccerReaderSnapshot(league.id, date); } catch { readerUnavailable = true; }
    let previous;
    try { previous = (await deps.listSoccerAnalysis(league.id, game.id, date))[0] || null; } catch {}
    const built = deps.buildSoccerAnalysis({ evidence, reader, previous });
    const { analysisHash: discardedHash, ...body } = built;
    const result = { ...body, analysisRunId: run.runId, qualificationVersion: run.requestSeq,
      quoteGeneration: run.quoteGeneration, runStartedAt: run.startedAt };
    result.analysisHash = deps.soccerAnalysisHash(result);
    const saved = await deps.saveSoccerAnalysis(result);
    const publication = await deps.finishSoccerAnalysisRun(run, { analysisStatus: result.analysisStatus, qaFlag: result.qaFlag,
      selectionResult: result.selectionResult, revision: saved.revision,
      validUntil: new Date(Date.parse(evidence.source.fetchedAt) + 180000).toISOString(),
      reasons: result.predictionReason ? [result.predictionReason] : [] });
    return { status: 200, payload: { ...result, ...saved, ...publication, readerUnavailable, journalPersisted: true } };
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
    r.started_at,e.finished_at,e.analysis_status,e.qa_flag,e.selection_result,e.reasons,a.analysis_hash,a.payload
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
  if (!rows.length) return { currentVersion: null, currentRun: null };
  if (rows.length !== 1) throw Error('SOCCER_ANALYSIS_HEAD_CONFLICT');
  const row = rows[0], payload = row.payload;
  const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  if (soccerAnalysisHash(canonical(payload)) !== row.analysis_hash || payload?.league !== league || payload?.gameId !== gameId
    || payload?.date !== date || payload?.analysisRunId !== row.requested_run_id || payload?.formalScoringEnabled !== false || payload?.executable !== false)
    throw Error('SOCCER_ANALYSIS_HEAD_CORRUPTED');
  const validUntil = new Date(row.valid_until).toISOString();
  return {
    currentVersion: { ...payload, persisted: true, revision: row.analysis_hash, publishedCurrent: true,
      qualificationValidUntil: validUntil, validUntil },
    currentRun: { analysisRunId: row.requested_run_id, startedAt: row.started_at, finishedAt: row.finished_at,
      analysisStatus: row.analysis_status, qaFlag: row.qa_flag, selectionResult: row.selection_result,
      revision: row.analysis_hash, reasons: row.reasons || [], requestSeq: String(row.requested_seq),
      quoteGeneration: String(row.quote_generation), publishedCurrent: true, validUntil },
  };
}
