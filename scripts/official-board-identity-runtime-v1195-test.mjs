import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { register } from 'node:module';
import { parseKboOfficialSchedulePayload } from '../lib/asian-baseball.js';
import { LEAGUE_IDS, leagueConfig } from '../lib/leagues.js';
import { allLeagueBoardDate, createAllLeagueAnalysisRun, summarizeAllLeagueBatchResult, updateAllLeagueAnalysisLeague } from '../lib/all-league-analysis-v117.js';
import { gameIsPrestartNow, touchReaderHeartbeat } from '../lib/client-analysis-state.js';
import { isHistoricalIdentityConflict, reconcileOfficialBoardIdentity } from '../lib/official-board-identity-v1195.js';
import { createAnalysisBoardCacheEntry, restoreAnalysisBoardCache } from '../lib/analysis-board-cache-v1.js';
import { createCompletedAnalysisReceipt, findMissingCompletedAnalysisReceipt } from '../lib/analysis-completed-receipt-v1.js';

register('./next-route-test-loader.mjs', import.meta.url);
process.env.APP_PASSWORD = process.env.APP_PASSWORD || 'isolated-identity-runtime-password';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'isolated-identity-runtime-session-secret-with-sufficient-length';
const { createSessionToken } = await import('../lib/security.js');
const { GET: getSchedule } = await import('../app/api/schedule/route.js');
const authHeaders = { cookie: `mlb_session=${encodeURIComponent(await createSessionToken(600))}`, 'x-forwarded-for': '203.0.113.197' };
const DATE = '2099-08-18';
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
let passed = 0;

function providerRow(away, home, { finished = false, link = '' } = {}) {
  return { row: [
    { Class: 'day', Text: '08.18(화)' }, { Class: 'time', Text: '<b>14:00</b>' },
    { Class: 'play', Text: `<span>${away}</span><em>${finished ? '<span class="lose">2</span>:<span class="win">3</span>' : 'vs'}</em><span>${home}</span>` },
    { Class: 'relay', Text: link }, { Text: '' }, { Text: '' }, { Text: '고척' }, { Text: finished ? '종료' : '-' },
  ] };
}
const providerPayload = { rows: [providerRow('NC', '키움', { finished: true }), providerRow('LG', '두산'),
  providerRow('KIA', '삼성'), providerRow('KT', 'SSG'), providerRow('롯데', '한화')] };
const officialGames = parseKboOfficialSchedulePayload(providerPayload, DATE);
const [oldGame] = parseKboOfficialSchedulePayload({ rows: [providerRow('NC', '키움', {
  link: "<a href='/Schedule/GameCenter/Main.aspx?gameId=20990818NCWO0&section=PREVIEW'>preview</a>",
})] }, DATE);
assert.equal(officialGames.length, 5);
const currentGame = officialGames.find(game => game.awayTeamId === oldGame.awayTeamId && game.homeTeamId === oldGame.homeTeamId);
assert.ok(currentGame);
assert.notEqual(oldGame.gamePk, currentGame.gamePk);

function item(game, score) {
  const payload = { league: 'KBO', game, pitPersistence: { confirmed: true, snapshotId: `isolated:${game.gamePk}` },
    analysis: { pitSnapshotId: `isolated:${game.gamePk}`, analysisAsOf: new Date(Date.now() - 60_000).toISOString(),
      calculatedDirectionCount: 8, results: [{ status: 'CALCULATED', formulaDiagnosticScore: score,
        modelEV: -0.0123456789012345, robustEV: -0.02000000000000001 }], evidence: { original: [0, -1, 0.12345678901234566] } } };
  return { game, customData: payload, referenceData: payload, customMarkets: [{ market: 'isolated fixture' }],
    readerPayloadHash: 'historical-reader-authority', actualSource: { provider: 'TAI888_READER_AUTO' } };
}
const originalBoard = [item(oldGame, 7.3), ...officialGames.map((game, index) => item(game, 7.7 + index / 10))];

function functionSource(name) {
  const prefix = page.includes(`  async function ${name}(`) ? `  async function ${name}(` : `  function ${name}(`;
  const start = page.indexOf(prefix);
  const end = page.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, `${name} must remain executable`);
  return page.slice(start, end + 4);
}

function clientHarness(scheduleBody) {
  const posted = [];
  const calls = [];
  const context = vm.createContext({ Date, Number, String, encodeURIComponent, leagueConfig, gameIsPrestartNow,
    isHistoricalIdentityConflict, reconcileOfficialBoardIdentity,
    league: 'KBO', date: DATE, boardRef: { current: originalBoard }, currentLeagueRef: { current: 'KBO' },
    currentDateRef: { current: DATE }, analysisGenerationRef: { current: 1 },
    officialIdentityEvidenceRef: { current: new Map() }, setOfficialIdentityRevision: () => {},
    operationBusyRef: { current: false }, readerPollBusyRef: { current: false }, allLeagueBusyRef: { current: false },
    allLeagueRunning: false, readerStatusRef: { current: null }, creditRevisionRef: { current: '' },
    officialPrestartCheckedAtRef: { current: 0 }, lastReferenceRefreshAtRef: { current: 0 }, queuedAnalysisRef: { current: null },
    REFERENCE_REFRESH_INTERVAL_MS: 300_000, OFFICIAL_PRESTART_RECHECK_MS: 300_000, ANALYSIS_TRANSIENT_RETRY_DELAYS_MS: [],
    setReaderPolling: () => {}, markAppOperationBusy: () => {}, setNotice: () => {}, setQueuedAnalysis: () => {},
    setBoard: value => { context.boardRef.current = typeof value === 'function' ? value(context.boardRef.current) : value; },
    setSchedule: value => { context.schedule = value; },
    commitReaderStatus: value => { context.readerStatusRef.current = value; },
    invalidateReaderStatus: value => { context.readerError = value; },
    readerHashKey: (date, hash) => hash ? `${date}:${hash}` : '', uid: () => 'isolated-request',
    requestJSON: async url => { calls.push(url); return { fresh: true, boardDate: DATE, payloadHash: 'current-reader' }; },
    requestJSONWithTransientRetry: async (url, options) => {
      calls.push(url);
      if (url.startsWith('/api/schedule?')) return scheduleBody;
      if (url === '/api/credit-lines') {
        posted.push(JSON.parse(options.body));
        // Stop after observing the exact real request boundary; this test does
        // not invent a model result or grant executable Reader authority.
        return { provider: 'ISOLATED_NO_MODEL', readerFresh: false };
      }
      throw new Error(`Unexpected isolated request ${url}`);
    },
  });
  for (const name of ['fetchScheduleForLeague', 'fetchSchedule', 'pollReaderAndReprice']) vm.runInContext(functionSource(name), context);
  return { context, posted, calls };
}

async function test(name, action) { await action(); passed += 1; console.log(`PASS ${name}`); }
const originalFetch = globalThis.fetch;
let scheduleBody;
try {
  await test('schedule API keeps four executable games but exposes identity-only evidence for all five official games', async () => {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => providerPayload });
    const response = await getSchedule(new Request(`https://app.test/api/schedule?league=KBO&date=${DATE}`, { headers: authHeaders }));
    assert.equal(response.status, 200);
    scheduleBody = await response.json();
    assert.equal(scheduleBody.games.length, 4);
    assert.equal(scheduleBody.identitySlate.length, 5);
    assert.ok(scheduleBody.identitySlate.some(game => game.gamePk === currentGame.gamePk));
    assert.ok(!scheduleBody.games.some(game => game.gamePk === currentGame.gamePk), 'finished identity evidence must never enter the executable games list');
    assert.ok(scheduleBody.identitySlate.every(game => game.league === 'KBO' && game.taipeiDate === DATE));
    assert.ok(Number.isFinite(Date.parse(scheduleBody.identityAsOf)));
    assert.equal(scheduleBody.identitySlate[0].analysis, undefined);
  });

  await test('actual Reader poll refreshes official identities and posts four fresh games instead of six restored cards', async () => {
    const state = clientHarness(scheduleBody);
    state.context.schedule = originalBoard.map(row => row.game);
    await state.context.pollReaderAndReprice();
    assert.equal(state.posted.length, 1);
    assert.deepEqual(state.posted[0].schedule.map(game => game.gamePk), scheduleBody.games.map(game => game.gamePk));
    assert.ok(!state.posted[0].schedule.some(game => game.gamePk === oldGame.gamePk));
    assert.ok(state.calls.findIndex(url => url.startsWith('/api/schedule?')) < state.calls.indexOf('/api/credit-lines'));
    const history = state.context.boardRef.current.filter(isHistoricalIdentityConflict);
    assert.equal(history.length, 1);
    assert.equal(history[0].game.gamePk, oldGame.gamePk);
    assert.equal(history[0].identityConflict.officialGamePk, currentGame.gamePk);
    assert.equal(state.context.boardRef.current.filter(row => !isHistoricalIdentityConflict(row)).length, 5);
    assert.deepEqual(history[0].customData, originalBoard[0].customData);
    assert.equal(history[0].readerPayloadHash, null);
    assert.match(page, /const shadowRanking = useMemo\(\(\) => activeBoard\.flatMap/);
    assert.match(page, /activeBoard\.map\(item => <GameCard/);
    assert.match(page, /historicalIdentityBoard\.length > 0 && <details/);
    assert.match(page, /歷史識別衝突/);
    assert.match(page, /betsEnabled=\{false\}[\s\S]{0,220}fresh: false/);
  });

  await test('quarantine survives cache reload without changing receipt coverage or any original analysis values', async () => {
    const evidence = { league: 'KBO', date: DATE, identitySlate: scheduleBody.identitySlate, identityAsOf: scheduleBody.identityAsOf };
    const board = reconcileOfficialBoardIdentity(originalBoard, evidence);
    const cached = createAnalysisBoardCacheEntry({ league: 'KBO', date: DATE, board });
    const restored = restoreAnalysisBoardCache(cached, { league: 'KBO', date: DATE });
    assert.equal(restored.filter(isHistoricalIdentityConflict).length, 1);
    assert.deepEqual(restored[0].customData.analysis, originalBoard[0].customData.analysis);
    assert.deepEqual(restored[0].identityConflict, board[0].identityConflict);
    const receipt = createCompletedAnalysisReceipt({ runId: 'old-immutable-run', league: 'KBO', date: DATE }, {
      league: 'KBO', date: DATE, results: [{ ok: true, task: { game: oldGame }, payload: originalBoard[0].customData }],
    });
    assert.ok(receipt);
    assert.equal(findMissingCompletedAnalysisReceipt([receipt], { league: 'KBO', date: DATE, board: restored }), null,
      'keeping the original immutable card must stop completed-receipt restore loops');
    const again = reconcileOfficialBoardIdentity(board, evidence);
    assert.equal(again, board, 'the React synchronization effect must settle rather than update on every render');
  });

  await test('Reader heartbeats cannot reauthorize a quarantined card and the actual record handler rejects it', async () => {
    const [historical] = reconcileOfficialBoardIdentity(originalBoard, { league: 'KBO', date: DATE,
      identitySlate: scheduleBody.identitySlate, identityAsOf: scheduleBody.identityAsOf });
    assert.equal(isHistoricalIdentityConflict(historical), true);
    assert.equal(touchReaderHeartbeat(historical, 'historical-reader-authority', new Date().toISOString()), historical);
    const errors = [];
    let posted = 0;
    const context = vm.createContext({ isHistoricalIdentityConflict, setError: message => { errors.push(message); },
      requestJSON: () => { posted += 1; throw new Error('a historical identity cannot create a new bet'); } });
    vm.runInContext(functionSource('recordBet'), context);
    await context.recordBet(historical, historical.customData.analysis.results[0]);
    assert.equal(posted, 0);
    assert.match(errors[0], /歷史場次識別/);
    assert.deepEqual(historical.customData.analysis, originalBoard[0].customData.analysis);
  });

  await test('official source failure cannot submit a stale cached slate or quarantine prior results', async () => {
    const state = clientHarness(scheduleBody);
    state.context.requestJSONWithTransientRetry = async () => { throw new Error('isolated official source failure'); };
    await state.context.pollReaderAndReprice();
    assert.equal(state.posted.length, 0);
    assert.equal(state.context.boardRef.current, originalBoard);
    assert.match(state.context.readerError, /official source failure/);
    globalThis.fetch = async () => { throw new Error('isolated provider failure'); };
    const response = await getSchedule(new Request(`https://app.test/api/schedule?league=KBO&date=${DATE}`, { headers: authHeaders }));
    const body = await response.json();
    assert.notEqual(response.status, 200);
    assert.equal(body.identitySlate, undefined);
    assert.equal(body.identityAsOf, undefined);
  });

  await test('a league/date switch during the fresh schedule await prevents any old credit POST or new-board mutation', async () => {
    const state = clientHarness(scheduleBody);
    let resolveSchedule;
    state.context.requestJSONWithTransientRetry = url => {
      assert.ok(url.startsWith('/api/schedule?'));
      return new Promise(resolve => { resolveSchedule = resolve; });
    };
    const pending = state.context.pollReaderAndReprice();
    await new Promise(setImmediate);
    assert.equal(typeof resolveSchedule, 'function');
    state.context.currentLeagueRef.current = 'CPBL';
    state.context.currentDateRef.current = '2099-08-19';
    state.context.analysisGenerationRef.current = 2;
    const newBoard = [{ game: { league: 'CPBL', gamePk: 12345 }, status: 'queued' }];
    state.context.boardRef.current = newBoard;
    resolveSchedule(scheduleBody);
    await pending;
    assert.equal(state.posted.length, 0);
    assert.equal(state.context.boardRef.current, newBoard);
    assert.equal(state.context.schedule, undefined);
  });

  await test('terminal summary uses the current run when quota left a different older run in durable storage', async () => {
    const start = page.indexOf('  useEffect(() => {\n    if (!storageReady || !allLeagueRun?.runId');
    const ending = '}, [storageReady, date, allLeagueRun?.runId, allLeagueRun?.state]);';
    const end = page.indexOf(ending, start);
    assert.ok(start >= 0 && end > start);
    for (const outcome of ['completed', 'failed', 'not-found']) {
      const running = { ...createAllLeagueAnalysisRun(DATE), runId: 'current-memory-run', state: 'running' };
      const older = { ...createAllLeagueAnalysisRun('2099-08-17'), runId: 'old-disk-run', state: 'completed' };
      const originalOlder = JSON.stringify(older);
      const published = [];
      const cleared = [];
      const context = vm.createContext({ Date, Number, String, encodeURIComponent, LEAGUE_IDS,
        allLeagueBoardDate, summarizeAllLeagueBatchResult, updateAllLeagueAnalysisLeague,
        storageReady: true, date: DATE, allLeagueRun: running, allLeagueRunRef: { current: running },
        useEffect: effect => effect(), loadAllLeagueAnalysisRun: () => older,
        publishAllLeagueRun: value => { published.push(value); },
        setProgress: () => {}, setBackgroundJobRevision: () => {}, setError: () => {},
        clearBackgroundJob: (league, date, runId) => { cleared.push({ league, date, runId }); },
        analysisFailureState: cause => ({ permanent: true, status: cause.status, message: cause.message }),
        requestJSON: async () => {
          if (outcome === 'not-found') throw Object.assign(new Error('isolated current run missing'), { status: 404 });
          return { status: outcome, result: { batches: LEAGUE_IDS.map(league => ({ league, date: DATE,
            total: 0, results: [], emptyReason: 'no_games' })) } };
        },
        window: { setTimeout: () => { throw new Error('terminal summary must not poll forever'); }, clearTimeout: () => {} },
      });
      vm.runInContext(page.slice(start, end + ending.length), context);
      await new Promise(setImmediate);
      assert.equal(published.length, 1);
      assert.equal(published[0].runId, 'current-memory-run');
      assert.equal(published[0].date, DATE);
      assert.equal(JSON.stringify(older), originalOlder);
      assert.ok(cleared.every(row => row.runId === 'current-memory-run' && row.date === DATE));
    }
  });
} finally {
  globalThis.fetch = originalFetch;
}

console.log(`Official board identity runtime: ${passed} groups passed; authenticated mocked API and actual page handlers, no live database writes.`);
