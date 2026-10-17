import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { mergePreparedLeagueBoard } from '../lib/all-league-analysis-v117.js';
import { analysisGameIdentity, sameAnalysisGame } from '../lib/analysis-game-identity-v1.js';
import { analysisHasCalculatedDirections, shouldPreserveCalculatedAnalysis, analysisIsUnopenedOnly } from '../lib/analysis-display-state-v116.js';
import { readerTaskGameRevisionIsStale, gameIsPrestartNow, bindVerifiedReaderContractsForItem } from '../lib/client-analysis-state.js';
import { evaluateBetAction } from '../lib/bet-action-state-v118.js';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const extract = (start, end) => page.slice(page.indexOf(start), page.indexOf(end, page.indexOf(start)));
const now = Date.parse('2026-10-17T08:00:00Z');
const date = '2026-10-18';
const game = { gamePk: 849816, leagueId: 'MLB', awayTeamId: 139, homeTeamId: 114,
  gameDate: '2026-10-18T00:00:00Z', status: 'Scheduled' };
const source = { provider: 'TAI888_READER_AUTO' };
const provenance = hash => ({ provider: source.provider, boardDate: date,
  payloadHash: 'board-B', readerGameMarketHash: hash });
const market = hash => ({ market: '全場大小', pick: '大7+90', water: .94,
  sourceType: 'ACTUAL_TW_CREDIT', provider: source.provider,
  readerGameMarketHash: hash, executable: true, modelEV: .222, robustEV: .172,
  evCalibration: { actualReaderEligible: true } });
const payload = hash => ({ game, pitPersistence: { confirmed: true },
  analysis: { readerGameMarketHash: hash, calculatedDirectionCount: 1, results: [market(hash)] } });
const previous = { game, actualSource: source, readerProvenance: provenance('game-A'),
  status: 'done', pendingReaderEvidenceHash: null, customMarkets: [market('game-A')],
  customData: payload('game-A') };
const readerGameEvidenceHash = value => String(value?.readerProvenance?.readerGameMarketHash
  || value?.readerGameMarketHash || value?.readerPayloadHash || '');

function fixture(hash = 'game-B') {
  const task = { game, actualSource: source, actualMarkets: [market(hash)],
    readerProvenance: provenance(hash), readerPayloadHash: 'board-B' };
  const live = { gamePk: game.gamePk, game, markets: task.actualMarkets,
    source, readerProvenance: task.readerProvenance };
  const credit = { league: 'MLB', boardDate: date, provider: source.provider,
    readerFresh: true, blocked: false, payloadHash: 'board-B', pageActivityAt: new Date(now).toISOString(),
    games: [live] };
  const result = { league: 'MLB', date, total: 1,
    results: [{ ok: true, task, payload: payload(hash) }] };
  const storage = new Map();
  const cleared = [], errors = [];
  let polls = 0;
  const noop = () => {};
  const context = {
    Date: class extends Date { static now() { return now; } },
    league: 'MLB', date, storageReady: true, analysisEnabled: true,
    boardRef: { current: [previous] }, currentDateRef: { current: date },
    currentLeagueRef: { current: 'MLB' }, analysisGenerationRef: { current: 1 },
    coreDataBlockRetryRef: { current: new Map() }, snapshots: { current: new Map() },
    backgroundJobPollsRef: { current: new Map() }, allLeagueBoardsRef: { current: new Map() },
    allLeagueBusyRef: { current: false }, allLeagueRunning: false,
    independentRunsRef: { current: new Map() }, manualAnalysisScopesRef: { current: new Set() },
    restoredBoardNeedsValidationRef: {}, operationBusyRef: {}, requestedRecoveryScopeRef: {},
    backgroundJobsInMemory: new Map(), supersededBackgroundRuns: new Set(),
    ANALYSIS_JOB_STORAGE: 'jobs', ANALYSIS_TRANSIENT_RETRY_DELAYS_MS: [],
    safeParse: value => { try { return JSON.parse(value); } catch { return null; } },
    backgroundJobKey: (league, date) => `${league}:${date}`,
    window: { localStorage: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value) } },
    analysisGameIdentity, sameAnalysisGame, analysisHasCalculatedDirections,
    shouldPreserveCalculatedAnalysis, analysisIsUnopenedOnly, readerGameEvidenceHash,
    readerTaskGameRevisionIsStale, gameIsPrestartNow, mergePreparedLeagueBoard,
    compactAnalysisData: value => value, coreDataBlockKey: () => 'task', uid: () => 'request',
    analysisFailureState: () => ({ blocked: false }),
    setBoard: value => { context.boardRef.current = typeof value === 'function' ? value(context.boardRef.current) : value; },
    setError: value => errors.push(value), setNotice: noop, setProgress: noop, setSchedule: noop,
    setIndependentRunRevision: noop, setBackgroundJobRevision: noop, setBusy: noop,
    markAppOperationBusy: noop, releaseOperation: noop, saveAnalysisBoardCache: noop,
    saveCompletedAnalysisReceipt: () => ({ completed: 1, stored: true }),
    clearBackgroundJob: (...args) => cleared.push(args),
    leagueConfig: () => ({ capabilities: { analysis: true, reader: true } }),
    prepareLeagueReaderPreflight: async () => ({ games: [game], credit }),
    fetchReferenceLines: async () => ({}), referenceGameMap: () => new Map(),
    loadAnalysisBoardCache: () => [previous],
    startBackgroundAnalysisJob: async () => ({ runId: 'run-B' }),
    fetchSchedule: async () => [game], requestJSONWithTransientRetry: async () => credit,
    requestJSON: async () => { polls++; return { status: 'completed', result }; },
  };
  vm.createContext(context);
  for (const code of [
    extract('function saveBackgroundJob(', '\nfunction clearBackgroundJob('),
    extract('  function taskReaderStateIsStale(', '\n  function directRepriceAuthorityMatches('),
    extract('  function commitAnalysisPayload(', '\n  function commitAnalysisFailure('),
    extract('  function pollBackgroundJob(', '\n  async function runDurableAnalysisTasks('),
    extract('  async function prepareAllLeagueBatch(', '\n  async function prepareNbaBatch('),
    extract('  async function startIndependentAnalysis(', '\n  async function oneClickAnalyze('),
  ]) vm.runInContext(code, context);
  return { context, task, credit, result, storage, cleared, errors, polls: () => polls };
}

const first = fixture();
const original = JSON.stringify(previous);
assert.equal(await first.context.startIndependentAnalysis(game.gamePk), true);
const prepared = first.context.boardRef.current[0];
assert.equal(prepared.pendingReaderEvidenceHash, 'game-B', 'new task revision survives retained old provenance');
assert.equal(prepared.readerProvenance.readerGameMarketHash, 'game-A', 'old display evidence stays frozen');
assert.equal(prepared.customData, previous.customData);
const saved = JSON.parse(first.storage.get('jobs'))[`MLB:${date}`];
assert.equal(saved.preparedBoard[0].pendingReaderEvidenceHash, 'game-B', 'lightweight reconnect retains task revision');
const resumed = mergePreparedLeagueBoard([previous], saved.preparedBoard);
assert.equal(resumed[0].pendingReaderEvidenceHash, 'game-B', 'reload must not restore old/null pending revision');
first.context.boardRef.current = resumed;
await first.context.pollBackgroundJob('run-B', 2, date, [game.gamePk]);
assert.equal(first.polls(), 1, 'completed-only poll must work without any incremental result');
const completed = first.context.boardRef.current[0];
assert.equal(completed.status, 'done');
assert.equal(completed.pendingReaderEvidenceHash, null);
assert.equal(completed.customData.analysis.readerGameMarketHash, 'game-B');
assert.equal(first.cleared.length, 1);
const [row] = bindVerifiedReaderContractsForItem(completed, completed.customData.analysis.results);
assert.equal(evaluateBetAction({ item: completed, row, now, readerAuthority: {
  fresh: true, boardDate: date, expectedBoardDate: date, payloadHash: 'board-B',
} }).recordable, true, 'unchanged recording gates accept fully validated completed result');
assert.equal(JSON.stringify(previous), original, 'retaining/replacing analysis must never rewrite frozen old scores');
const newerPending = { ...previous, status: 'queued', pendingReaderEvidenceHash: 'game-C' };
assert.equal(mergePreparedLeagueBoard([newerPending], saved.preparedBoard)[0].pendingReaderEvidenceHash,
  'game-C', 'recovery of saved B cannot replace the current newer task C');
assert.equal(mergePreparedLeagueBoard([newerPending], saved.preparedBoard, { replacePendingRevision: true })[0].pendingReaderEvidenceHash,
  'game-B', 'a newly requested task deliberately owns its prepared revision');

// Quota fallback strips preparedBoard from the reconnect handle. Its final
// signed Reader validation may bind a missing revision, but never override one.
const legacy = fixture();
legacy.context.boardRef.current = [{ ...previous, status: 'queued', pendingReaderEvidenceHash: null }];
await legacy.context.pollBackgroundJob('legacy-handle', 1, date, [game.gamePk]);
assert.equal(legacy.context.boardRef.current[0].status, 'done');
assert.equal(legacy.context.boardRef.current[0].customData.analysis.readerGameMarketHash, 'game-B');

const stale = fixture();
const newer = { ...previous, status: 'queued', pendingReaderEvidenceHash: 'game-C' };
stale.context.boardRef.current = [newer];
await assert.rejects(stale.context.pollBackgroundJob('old-run-B', 1, date, [game.gamePk]), /尚未載入/);
assert.equal(stale.cleared.length, 0, 'rejected commit cannot clear its recoverable result');
assert.equal(stale.context.boardRef.current[0], newer, 'old job cannot release or overwrite a newer task');
assert.equal(stale.context.commitAnalysisPayload(stale.task, { ...stale.result.results[0].payload,
  game: { ...game, homeTeamId: 999 } }), false, 'wrong-team identity stays rejected');

const unchanged = fixture('game-A');
unchanged.context.boardRef.current = [{ ...previous, status: 'queued', pendingReaderEvidenceHash: 'game-A' }];
await unchanged.context.pollBackgroundJob('same-game-new-board', 1, date, [game.gamePk]);
assert.equal(unchanged.context.boardRef.current[0].status, 'done');
assert.equal(unchanged.context.boardRef.current[0].readerPayloadHash, 'board-B');
assert.deepEqual(unchanged.context.boardRef.current[0].customData.analysis.results[0], market('game-A'));
console.log('PASS completed-only A→B reanalysis, retained scores, saved/reloaded revision, quota fallback, stale C and identity rejection, unchanged game revision');
