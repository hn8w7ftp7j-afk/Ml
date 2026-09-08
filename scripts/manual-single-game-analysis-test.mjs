import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { referenceGameMap } from '../lib/reference-acquisition-evidence.js';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const source = page.slice(page.indexOf('  async function oneClickAnalyze('), page.indexOf('  function blockedReaderHashRecheckDue('));
const picker = page.slice(page.indexOf('  async function loadGamePicker('), page.indexOf('  async function fetchReferenceLines('));
assert.doesNotMatch(page, /(?:await |void |=> )pollReaderAndReprice\(/);
assert.doesNotMatch(page, /pollReaderAndReprice\(\);/);
assert.doesNotMatch(picker, /credit-lines|runDurable|startBackground|oneClickAnalyze/);
assert.match(page, /oneClickAnalyze\('', queuedAnalysis.gamePk\)/);
assert.match(page, /queuedAnalysis.league !== league \|\| queuedAnalysis.date !== date/);
assert.match(page, /gamePicker.scope !== `\$\{league\}:\$\{date\}` \|\| !gamePicker.selected/);

async function exercise(selected, options = {}) {
  const games = [11, 22, 33].map(gamePk => ({ gamePk, leagueId: 'MLB', gameDate: '2026-09-09T00:00:00Z' }));
  const original = games.map(game => ({ game, status: 'done', customData: { marker: game.gamePk }, actualSource: { provider: 'TAI888_READER_AUTO' } }));
  let board = original;
  const requests = [], batches = [], errors = [];
  const noop = () => {};
  const context = {
    referenceGameMap,
    allLeagueRunning: false, readerPollBusyRef: { current: !!options.queue }, league: 'MLB', date: '2026-09-09',
    queuedAnalysisRef: {}, setQueuedAnalysis: noop, setError: value => errors.push(value), setNotice: noop,
    activeLeague: { id: 'MLB', shortLabel: '美棒' }, loadBackgroundJob: () => null, boardRef: { current: board },
    analysisEnabled: true, acquireOperation: () => true, releaseOperation: noop, setBackgroundJobRevision: noop,
    manualAnalysisScopesRef: { current: new Set() }, restoredBoardNeedsValidationRef: {},
    analysisGenerationRef: { current: 1 }, currentDateRef: { current: '2026-09-09' }, setTab: noop,
    setBoard: value => { board = typeof value === 'function' ? value(board) : value; }, setProgress: noop,
    fetchSchedule: async () => { if (options.dateChanged) context.currentDateRef.current = '2026-09-10'; return games; },
    requestJSONWithTransientRetry: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return { provider: 'TAI888_READER_AUTO', readerFresh: true, payloadHash: 'test',
        // Deliberately return extra rows: they must not expand the selected task scope.
        games: games.map(game => ({ gamePk: game.gamePk, markets: [{ market: 'moneyline' }], source: { provider: 'TAI888_READER_AUTO' } })) };
    },
    uid: () => 'test', ANALYSIS_TRANSIENT_RETRY_DELAYS_MS: [], fetchReferenceLines: async () => ({ games: [] }),
    analysisFailureState: () => ({ blocked: false }), readerMarketsLoseCalculatedCoverage: () => false,
    analysisHasCalculatedDirections: value => !!value, readerCoverageCounts: () => ({}),
    runDurableAnalysisTasks: async tasks => { batches.push(tasks); throw new Error('TEST_STOP_AFTER_SUBMISSION'); },
  };
  vm.createContext(context);
  await vm.runInContext(`(${source.trim()})`, context)('', selected);
  return { games, original, board, requests, batches, errors, context };
}
const single = await exercise('22');
assert.equal(single.batches.length, 1, single.errors.join('\n'));
assert.deepEqual(single.requests[0].schedule.map(game => game.gamePk), [22]);
assert.deepEqual(Array.from(single.batches[0], task => task.game.gamePk), [22]);
assert.strictEqual(single.board.find(item => item.game.gamePk === 11), single.original[0]);
assert.strictEqual(single.board.find(item => item.game.gamePk === 33), single.original[2]);
const all = await exercise(null);
assert.deepEqual(Array.from(all.batches[0], task => task.game.gamePk), [11, 22, 33]);
for (const invalid of ['', 'not-an-id', 999]) {
  const result = await exercise(invalid);
  assert.equal(result.requests.length, 0);
  assert.equal(result.batches.length, 0);
}
const queued = await exercise('22', { queue: true });
assert.equal(queued.context.queuedAnalysisRef.current.gamePk, '22');
assert.equal(queued.requests.length, 0);
const changed = await exercise('22', { dateChanged: true });
assert.equal(changed.requests.length, 0);
assert.equal(changed.batches.length, 0);
console.log('Manual-only triggers, read-only picker, single/all task scope, queue, stale selection and preserved unrelated rows PASS');
