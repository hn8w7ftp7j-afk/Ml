import assert from 'node:assert/strict';
import { createAnalysisJobProgress, applyAnalysisJobProgress } from '../lib/analysis-job-progress.js';
import { validateCompletedGamesWithReader } from '../lib/completed-game-reader-validation.js';
import { bindVerifiedReaderContractsForItem } from '../lib/client-analysis-state.js';
import { evaluateBetAction } from '../lib/bet-action-state-v118.js';

const now = Date.parse('2026-09-30T06:00:00Z');
const scope = { league: 'MLB', date: '2026-09-30', gamePks: [1, 2] };
const games = [1, 2].map(gamePk => ({ gamePk, league: 'MLB', awayTeamId: gamePk * 2,
  homeTeamId: gamePk * 2 + 1, gameDate: '2026-09-30T12:00:00Z', status: 'Scheduled' }));
const market = { market: '全場大小', pick: '大8+50', water: 0.95, sourceType: 'ACTUAL_TW_CREDIT',
  provider: 'TAI888_READER_AUTO', readerGameMarketHash: 'game-content', executable: true,
  evCalibration: { actualReaderEligible: true } };
const source = { provider: 'TAI888_READER_AUTO' };
const provenance = { provider: 'TAI888_READER_AUTO', boardDate: scope.date, payloadHash: 'board-old', readerGameMarketHash: 'game-content' };
const tasks = games.map(game => ({ game, actualMarkets: [market], actualSource: source, readerProvenance: provenance }));
const payload = { game: games[0], pitPersistence: { confirmed: true },
  context: { game: games[0], fetchedAt: new Date(now).toISOString() },
  analysis: { pitSnapshotId: 'saved-pit', readerGameMarketHash: 'game-content', results: [market] } };
const progress = createAnalysisJobProgress({ ...scope, tasks }, [{ ok: true, task: tasks[0], payload }], [2]);
const partial = applyAnalysisJobProgress(progress, games.map(game => ({ game, status: 'queued' })), scope);
const credit = { league: scope.league, boardDate: scope.date, provider: source.provider,
  readerFresh: true, blocked: false, payloadHash: 'board-new', pageActivityAt: new Date(now).toISOString(),
  games: [{ gamePk: 1, game: games[0], markets: [market], source,
    readerProvenance: { ...provenance, payloadHash: 'board-new' } }] };
const action = (board, state = credit) => {
  const item = board[0];
  const [row] = bindVerifiedReaderContractsForItem(item, item.customData.analysis.results);
  return evaluateBetAction({ item, row, now, readerAuthority: { fresh: state.readerFresh,
    boardDate: state.boardDate, expectedBoardDate: scope.date, payloadHash: state.payloadHash } });
};
assert.equal(action(partial.board).recordable, false);
const verified = validateCompletedGamesWithReader(partial.board, credit, scope, now);
assert.equal(action(verified).recordable, true, 'first finished game can be recorded while sibling runs');
assert.equal(verified[1].status, 'running');
assert.equal(verified[1].readerPayloadHash, null);
assert.equal(verified[0].customData.analysis.pitSnapshotId, 'saved-pit');
assert.deepEqual(verified[0].customData.analysis.results[0].evCalibration, market.evCalibration);
for (const patch of [{ league: 'NPB' }, { boardDate: '2026-10-01' }, { readerFresh: false },
  { blocked: true }, { payloadHash: '' }, { games: [] },
  { games: [{ ...credit.games[0], game: { ...games[0], homeTeamId: 99 } }] },
  { games: [{ ...credit.games[0], markets: [{ ...market, water: 0.96 }] }] },
  { games: [{ ...credit.games[0], readerProvenance: { ...credit.games[0].readerProvenance, readerGameMarketHash: 'changed' } }] },
]) assert.equal(action(validateCompletedGamesWithReader(partial.board, { ...credit, ...patch }, scope, now)).recordable, false);
for (const patch of [{ pitPersistence: { confirmed: false } },
  { context: { game: games[0], fetchedAt: '2026-09-29T00:00:00Z' } }]) {
  const board = [{ ...partial.board[0], customData: { ...payload, ...patch } }, partial.board[1]];
  assert.equal(action(validateCompletedGamesWithReader(board, credit, scope, now)).recordable, false);
}
assert.equal(validateCompletedGamesWithReader(partial.board, credit, scope, Date.parse(games[0].gameDate))[0].readerPayloadHash, null);
console.log('PASS: partial result + current signed Reader enables finished game only; stale/moved/missing/wrong identity/PIT/core remain locked');

// Execute the real client polling and verification functions with a running
// server response, then completion. Assert readiness before completion arrives.
const { readFileSync } = await import('node:fs');
const vm = await import('node:vm');
const { materializeAllLeagueResult } = await import('../lib/all-league-result-board.js');
const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const client = page.slice(page.indexOf('  async function verifyCompletedBoard('), page.indexOf('  async function runDurableAnalysisTasks('));
const noop = () => {};
const boardRef = { current: partial.board };
let polls = 0, verificationCalls = 0;
const context = {
  Date: class extends Date { static now() { return now; } },
  league: scope.league, boardRef, analysisGenerationRef: { current: 1 },
  currentLeagueRef: { current: scope.league }, currentDateRef: { current: scope.date },
  backgroundJobPollsRef: { current: new Map() }, allLeagueBoardsRef: { current: new Map() },
  applyAnalysisJobProgress, validateCompletedGamesWithReader: (board, credit, scope) => validateCompletedGamesWithReader(board, credit, scope, now), materializeAllLeagueResult,
  compactAnalysisData: value => value, gameIsPrestartNow: game => Date.parse(game.gameDate) > now,
  analysisItemMatchesScope: item => item.game.league === scope.league,
  uid: () => 'test-request', commitReaderStatus: noop, setBoard: value => { boardRef.current = value; },
  setProgress: noop, setSchedule: noop, saveAnalysisBoardCache: noop, clearBackgroundJob: noop,
  saveCompletedAnalysisReceipt: () => ({ completed: true, stored: true }), setNotice: noop,
  window: { setTimeout: fn => { fn(); } },
  requestJSON: async url => {
    if (url === '/api/credit-lines') { verificationCalls++; return credit; }
    polls++;
    if (polls === 1) return { status: 'running', progress };
    assert.equal(action(boardRef.current).recordable, true, 'actual polling unlocks completed game before whole-job response');
    assert.equal(boardRef.current[1].status, 'running');
    return { status: 'completed', result: { ...scope, total: 1, results: progress.results } };
  },
};
vm.createContext(context);
vm.runInContext(client, context);
await context.pollBackgroundJob('run-client-progress', 1, scope.date, scope.gamePks, { displayOnly: true });
assert.equal(polls, 2);
assert.equal(verificationCalls, 2, 'both incremental and final results use signed Reader validation');
assert.equal(action(boardRef.current).recordable, true);
console.log('PASS: actual client poll loop opens recording during all-league progress and retains it at completion');
