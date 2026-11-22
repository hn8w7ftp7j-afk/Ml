import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerPredictionLiveFixture } from './helpers/soccer-prediction-live-fixture.mjs';
import { fetchSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { parseSoccerCapture } from '../reader/soccer-parser.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';

// Execute real SQL, stores, identity checks, models and publication. Only the
// invented upstream fixtures and a shared test-only JS/PostgreSQL clock differ
// from production; advancing time never changes a saved evidence timestamp.
const fixture = await soccerSqlFixture(), NativeDate = Date;
const epoch = value => value instanceof NativeDate ? value.getTime() : Date.parse(value);
let clock = Math.floor(NativeDate.now() / 1000) * 1000, analyzing = false, beforeQueueRelease = null;
class TestDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
  static [Symbol.hasInstance](value) { return value instanceof NativeDate; }
}
const originalTransport = globalThis.__SOCCER_TEST_SQL;
await fixture.db.exec(`CREATE FUNCTION soccer_refresh_test_clock() RETURNS timestamptz
  LANGUAGE SQL VOLATILE AS $$ SELECT current_setting('soccer.refresh_test_clock')::timestamptz $$`);
const setClock = async value => {
  assert.ok(Number.isFinite(value) && value >= clock, 'the test clock only moves forward');
  clock = value;
  await fixture.db.query("SELECT set_config('soccer.refresh_test_clock',$1,false)", [new NativeDate(clock).toISOString()]);
};
await setClock(clock);
const transport = async (queries, transaction) => {
  if (beforeQueueRelease && queries.some(item => /UPDATE sports_soccer_reader_analysis_queue_v1 SET lease_token=NULL/.test(item.query))) {
    const hook = beforeQueueRelease; beforeQueueRelease = null; await hook();
  }
  // Distinct real store operations retain their causal ordering, including
  // calibration freeze before capture. Boundary checks themselves are frozen.
  if (analyzing) await setClock(clock + 5);
  return originalTransport(queries.map(item => ({ ...item,
    query: item.query.replaceAll('clock_timestamp()', 'soccer_refresh_test_clock()') })), transaction);
};
const query = async (sql, params = []) => (await transport([{ query: sql, params }], false))[0];
const previousEnv = Object.fromEntries(['DATABASE_URL', 'DATABASE_V2_URL'].map(key => [key, process.env[key]]));
globalThis.Date = TestDate;
globalThis.__SOCCER_TEST_SQL = transport;
process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-refresh-scheduling';
delete process.env.DATABASE_V2_URL;
try {
  const { enqueueSoccerReaderAnalysis, drainSoccerReaderAnalysis, soccerReaderAnalysisCandidates } = await import('../lib/soccer/reader-auto-analysis.js');
  const { claimSoccerReaderCurrentRefresh } = await import('../lib/soccer/reader-current-refresh.js');
  const { runSoccerReaderContinuationPass } = await import('../lib/soccer/reader-analysis-continuation.js');
  const { saveSoccerReaderSnapshot, loadSoccerReaderSnapshot } = await import('../lib/soccer/reader-store.js');
  const { analyzeSoccerGame } = await import('../lib/soccer/analysis-service.js');
  const { beginSoccerAnalysisRun, getSoccerCurrentResearchStatus } = await import('../lib/soccer/journal.js');
  const f = await soccerPredictionLiveFixture({ now: clock - 2000 });
  const raw = JSON.parse(fs.readFileSync('scripts/fixtures/soccer/epl-summary.json', 'utf8'));
  const rawGames = [0, 1].map(index => {
    const header = structuredClone(raw.header), competition = header.competitions[0];
    header.id = String(Number(f.game.sourceId) + index);
    if (header.uid) header.uid = header.uid.replace(/~e:\d+/, `~e:${header.id}`);
    header.date = new Date(Date.parse(f.start) + index * 3600000).toISOString();
    competition.id = header.id; competition.date = header.date;
    if (competition.uid) competition.uid = competition.uid.replace(/~e:\d+/, `~e:${header.id}`).replace(/~c:\d+/, `~c:${header.id}`);
    competition.status = { type: { state: 'pre', completed: false, name: 'STATUS_SCHEDULED' } };
    header.status = competition.status;
    return header;
  });
  const board = await fetchSoccerSchedule(f.league, f.date, { now: () => clock,
    fetchImpl: async () => Response.json({ leagues: [raw.header.league], events: rawGames }) });
  assert.equal(board.ok, true, JSON.stringify(board)); assert.equal(board.games.length, 2);
  const capture = structuredClone(f.capture);
  for (const table of capture.tables) {
    const second = structuredClone(table.rows[0]);
    second.cells[0].pair[1] = new Date(Date.parse(rawGames[1].date) + 8 * 3600000).toISOString().slice(11, 16);
    table.rows.push(second);
  }
  const parsed = parseSoccerCapture(capture, new Date(clock));
  const checked = validateSoccerCapture({ ...parsed, readerVersion: '2.1.60', pageActivityAt: capture.observedAt },
    { now: clock, headerVersion: '2.1.60' });
  assert.equal(checked.ok, true, JSON.stringify(checked));
  let payload = checked.payload, calls = [], enqueueCount = 0;
  const responses = new Map();
  const deps = { query, league: f.league, date: f.date, now: () => clock,
    loadReader: loadSoccerReaderSnapshot, schedule: async () => board,
    analyze: async (input, overrides) => {
      calls.push(input.eventId); analyzing = true;
      try {
        const game = board.games.find(item => item.sourceId === input.eventId);
        const summary = structuredClone(raw); summary.header = structuredClone(rawGames.find(item => item.id === input.eventId));
        const response = await analyzeSoccerGame(input, { ...overrides,
          fetchSoccerPrematch: async () => {
            // The second game's independent source is older, so its true due
            // time precedes the first game's despite the same Reader upload.
            const at = clock - (input.eventId === rawGames[1].id ? 15000 : 1000);
            return normalizeSoccerPrematch(summary, game, { provider: 'ESPN',
              url: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${input.eventId}`,
              requestedAt: new Date(at).toISOString(), fetchedAt: new Date(at).toISOString(),
              contentHash: createHash('sha256').update(JSON.stringify(summary)).digest('hex') }, clock);
          },
          fetchSoccerWorkload: async () => ({ ok: false, status: 'INCOMPLETE', teams: {}, sources: [], modelEffectApplied: false, executable: false }),
          fetchSoccerTeamXg: async () => ({ ok: false, reason: 'SYNTHETIC_NO_MATCH_NPXG' }),
          enrichSoccerPrematchInputs: async evidence => evidence,
        });
        responses.set(input.eventId, response); return response;
      } finally { analyzing = false; }
    },
  };
  const enqueue = async () => { enqueueCount++; return enqueueSoccerReaderAnalysis(f.league, f.date, { query }); };
  const drain = overrides => drainSoccerReaderAnalysis({ ...deps, ...overrides });
  const queue = async () => (await query(`SELECT generation::text,retry_at,last_reason,lease_token
    FROM sports_soccer_reader_analysis_queue_v1 WHERE league=$1 AND board_date=$2::date`, [f.league, f.date]))[0];
  const heartbeat = async () => {
    payload = structuredClone(payload); payload.observedAt = new Date(clock - 1000).toISOString();
    payload.pageActivityAt = payload.observedAt;
    return saveSoccerReaderSnapshot(payload);
  };
  const candidates = async () => soccerReaderAnalysisCandidates(await loadSoccerReaderSnapshot(f.league, f.date), board,
    { league: f.league, date: f.date, now: clock });
  const claims = async () => Promise.all((await candidates()).map(candidate => claimSoccerReaderCurrentRefresh(candidate, { query })));

  await saveSoccerReaderSnapshot(payload); await enqueue();
  const initial = await drain();
  assert.equal(initial.captured, 2, JSON.stringify({ initial, responses: [...responses].map(([id, r]) => [id, r.status, r.payload?.error, r.payload?.forwardCapture, r.payload?.calibrationShadowCapture]) }));
  assert.equal(calls.length, 2);
  const publishedDue = (await claims()).map(item => Date.parse(item.nextDueAt));
  assert.ok(publishedDue.every(Number.isFinite));
  assert.equal(epoch((await queue()).retry_at), Math.min(...publishedDue),
    'a successful publication schedules its absolute deadline without another upload or batch-duration drift');
  const originalRows = await query('SELECT analysis_hash,payload FROM sports_soccer_analysis_v1 ORDER BY analysis_hash');
  const initialCalls = calls.length;
  await setClock(clock + 10000); await heartbeat(); await enqueue();
  const earlyClaims = await claims();
  assert.ok(earlyClaims.every(item => item.reason === 'REFRESH_NOT_DUE'), JSON.stringify(earlyClaims));
  const dueTimes = earlyClaims.map(item => Date.parse(item.nextDueAt));
  assert.ok(dueTimes.every(Number.isFinite), 'NOT_DUE returns an absolute server due timestamp');
  assert.equal(new Set(dueTimes).size, 2, 'independent evidence deadlines create two distinct due times');
  const earliest = Math.min(...dueTimes), early = await drain();
  assert.equal(early.refreshed, 0); assert.equal(calls.length, initialCalls);
  assert.equal(early.continuation.needed, true, 'NOT_DUE cannot acknowledge/delete the scope');
  assert.equal(epoch((await queue()).retry_at), earliest, 'the earliest game controls the durable wake');
  const runState = { startedAt: clock, deadlineAt: clock + 180000 }, uploadCount = enqueueCount;

  await setClock(earliest - 1);
  const justBefore = await runSoccerReaderContinuationPass({ league: f.league, date: f.date }, runState,
    { now: () => clock, drain: options => drain(options) });
  assert.equal(justBefore.stopped, false); assert.equal(justBefore.summary.checked, 0);
  assert.equal(justBefore.delayMs, 1, 'a 1ms future due time does not run early');
  assert.equal(calls.length, initialCalls);
  await setClock(earliest);
  const duePasses = await Promise.all([0, 1].map(() => runSoccerReaderContinuationPass({ league: f.league, date: f.date }, runState,
    { now: () => clock, drain: options => drain(options) })));
  assert.equal(duePasses.reduce((sum, pass) => sum + pass.summary.refreshed, 0), 1,
    'two continuation workers use one scope/refresh lease at the exact due time');
  assert.equal(calls.length, initialCalls + 1);
  assert.equal(calls.at(-1), rawGames[1].id, 'the earlier game wakes before the later game');
  assert.equal(enqueueCount, uploadCount, 'the wake consumes the already stored fresh observation without another POST');
  for (const old of originalRows) assert.deepEqual((await query('SELECT payload FROM sports_soccer_analysis_v1 WHERE analysis_hash=$1', [old.analysis_hash]))[0].payload, old.payload,
    'waking never extends or rewrites immutable evidence');

  // Every price can consume the newer observation once. When that same receipt
  // is all that remains, due scheduling must stop instead of perpetually
  // publishing the old evidence or keeping an immediately-due busy loop.
  let boundedWakes = 0;
  while (await queue()) {
    const row = await queue(), at = epoch(row.retry_at);
    if (!Number.isFinite(at)) break;
    assert.ok(++boundedWakes <= 4, 'unchanged source stops within the remaining per-game due boundaries');
    await setClock(Math.max(clock, at));
    const result = await drain();
    assert.notEqual(result.continuation.needed && result.continuation.delayMs === 0 && result.checked === 0, true,
      'no-source work cannot continuously reschedule itself immediately');
    if (!result.continuation.needed) break;
  }
  assert.equal(calls.length, initialCalls + 2, 'each game renewed exactly once from the one newer receipt');
  assert.equal(enqueueCount, uploadCount);
  const stopped = await drain(); assert.equal(stopped.continuation.needed, false);

  // A racing upload owns the newer queue generation. A finishing old worker
  // must not move it to its own future due time or acknowledge it as complete.
  await setClock(clock + 1000); await heartbeat(); await enqueue();
  const refreshed = await drain(); assert.ok(refreshed.refreshed > 0, JSON.stringify(refreshed));
  await setClock(clock + 1000); await enqueue();
  const beforeRace = await queue();
  beforeQueueRelease = async () => { await enqueue(); await setClock(clock + 2); };
  const raced = await drain({ timeBudgetMs: 1 });
  assert.equal(beforeQueueRelease, null, 'the race occurred under the old queue lease');
  assert.equal(raced.continuation.generation, String(Number(beforeRace.generation) + 1));
  assert.equal(raced.continuation.delayMs, 0, 'the new upload remains immediately due');

  // A manual request still revokes the published head and owns the request
  // sequence. Scheduled renewal may wait, but cannot replace that manual run.
  const manualRuns = await Promise.all(board.games.map(game => beginSoccerAnalysisRun({ league: f.league, date: f.date, gameId: game.id })));
  const beforeManual = calls.length;
  const manual = await drain();
  assert.equal(manual.refreshed, 0); assert.equal(calls.length, beforeManual);
  assert.equal(manual.refreshSkipped.REFRESH_ANALYSIS_PENDING, 2);
  for (const [index, game] of board.games.entries()) {
    const status = await getSoccerCurrentResearchStatus(f.league, f.date, game.id);
    assert.equal(status.analysisRunId, manualRuns[index].runId); assert.equal(status.publishedCurrent, false);
  }
  assert.equal((await query("SELECT count(*)::int n FROM sports_soccer_reader_analysis_queue_v1 WHERE league='ucl'"))[0].n, 0);
  console.log('PASS PostgreSQL Reader refresh scheduling: exact due ±1ms, two-game earliest deadline, automatic wake without a new POST, shared leases, one-use newer observation, immutable deadlines, bounded no-source stop, upload generation race and manual/league fences.');
} finally {
  globalThis.Date = NativeDate;
  globalThis.__SOCCER_TEST_SQL = originalTransport;
  for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  await fixture.close();
}
