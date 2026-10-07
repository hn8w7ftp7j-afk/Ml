import assert from 'node:assert/strict';
import { createSessionToken } from '../lib/security.js';
import { loadNbaTrainingContext } from '../lib/nba/training-service.js';
import { readNbaHistoryStatus } from '../lib/nba/history-status.js';
import { loadNbaAnalysis } from '../lib/nba/analysis-service.js';
import { defaultTraining } from '../lib/nba/analysis-training.js';

// Run with the existing next-route-test-loader. No provider or database call is
// necessary: route acceptance boundaries stop before their server-side work.
const keys = ['APP_PASSWORD', 'SESSION_SECRET', 'CRON_SECRET'];
const previous = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(process.env, key)]));
const originalFetch = globalThis.fetch;
let networkCalls = 0;
try {
  process.env.APP_PASSWORD = 'nba-completion-boundary-fixture';
  process.env.SESSION_SECRET = 'nba-completion-boundary-fixture-secret';
  process.env.CRON_SECRET = '';
  globalThis.fetch = async () => { networkCalls++; throw Error('Boundary tests must not access network'); };

  const historyRoute = await import('../app/api/nba/history-training/route.js');
  const cronRoute = await import('../app/api/cron/nba-maintenance/route.js');
  const validationRoute = await import('../app/api/nba/validation/route.js');
  const cookie = `mlb_session=${await createSessionToken()}`;
  let requestId = 0;
  const request = (path, { auth = true, method = 'GET', origin, body } = {}) => new Request(`https://fixture.test${path}`, {
    method,
    headers: { ...(auth ? { cookie } : {}), ...(origin ? { origin } : {}),
      'x-forwarded-for': `fixture-boundary-${++requestId}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  for (const route of [historyRoute, validationRoute]) {
    const response = await route.GET(request('/api/nba/history-training', { auth: false }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal((await route.POST(request('/api/nba/history-training', { auth: false, method: 'POST', body: { action: 'sync' } }))).status, 401);
    assert.equal((await route.POST(request('/api/nba/history-training', { method: 'POST', origin: 'https://attacker.test', body: { action: 'sync' } }))).status, 403);
  }
  for (const query of ['?trainingData=x', '?beforeDate=2026-10-01', '?action=sync', '?score=999']) {
    assert.equal((await historyRoute.GET(request(`/api/nba/history-training${query}`))).status, 400);
  }
  for (const body of [{}, { action: 'evaluate' }, { action: 'sync', scores: [999, 0] },
    { action: 'sync', trainingData: {} }, { action: 'sync', throughDate: '2026-10-01' },
    { action: 'sync', lookbackDays: 365 }, { action: 'sync', players: [] }]) {
    const response = await historyRoute.POST(request('/api/nba/history-training', { method: 'POST', origin: 'https://fixture.test', body }));
    assert.equal(response.status, 400, `Unexpected acceptance: ${JSON.stringify(body)}`);
  }
  assert.equal((await cronRoute.GET(request('/api/cron/nba-maintenance', { auth: false }))).status, 401);
  process.env.CRON_SECRET = 'nba-cron-boundary-fixture';
  const wrongSecret = new Request('https://fixture.test/api/cron/nba-maintenance', { headers: { authorization: 'Bearer wrong-fixture' } });
  assert.equal((await cronRoute.GET(wrongSecret)).status, 401);

  const epoch = Date.parse('2026-10-05T00:00:00Z');
  const game = { league: 'NBA', taipeiDate: '2026-10-05', season: { year: 2027 } };
  let lists = 0;
  const unavailable = await loadNbaTrainingContext(game, { now: epoch, configured: true, list: async () => { lists++; throw Error('fixture unavailable'); } });
  assert.equal(lists, 1);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.trainingData, undefined, 'A failed permanent history read must not use frozen fallback');
  assert.equal(unavailable.issue.code, 'NBA_LIVE_TRAINING_UNAVAILABLE');
  const archive = await loadNbaTrainingContext(game, { now: () => epoch, configured: false, list: async () => { throw Error('Unconfigured storage must not be queried'); } });
  assert.equal(archive.status, 'archive_only');
  assert.equal(archive.trainingData, defaultTraining);
  assert.equal(archive.provenance.status, 'not_configured');

  const rows = [
    { year: 2027, seasonType: 'preseason', date: '2026-10-04', capturedAt: '2026-10-04T15:00:00Z' },
    { year: 2027, seasonType: 'preseason', date: '2026-10-05', capturedAt: '2026-10-05T00:00:00Z' },
    { year: 2026, seasonType: 'regular', date: '2026-04-01', capturedAt: '2026-10-03T00:00:00Z' },
  ];
  let range;
  const history = await readNbaHistoryStatus({ now: () => epoch, list: async query => { range = query; return rows; } });
  assert.equal(range.beforeDate, '2026-10-06');
  assert.equal(history.games, 3);
  assert.deepEqual(history.groups, [
    { seasonYear: 2027, seasonType: 'preseason', games: 2, through: '2026-10-05' },
    { seasonYear: 2026, seasonType: 'regular', games: 1, through: '2026-04-01' },
  ]);
  assert.equal(history.latestCapturedAt, '2026-10-05T00:00:00Z');
  assert.equal(history.strictPointInTime, false);
  assert.equal((await readNbaHistoryStatus({ now: epoch, list: async () => [] })).latestCapturedAt, null);
  await assert.rejects(readNbaHistoryStatus({ now: epoch, list: async () => { throw Error('fixture history unavailable'); } }), /fixture history unavailable/);

  const team = value => ({ id: `nba:espn:team:${value}`, league: 'NBA', sourceId: String(value) });
  const target = { ...game, id: 'nba:espn:game:401999991', sourceId: '401999991', seasonType: 'regular',
    startTime: '2026-10-05T01:00:00Z', timeConfirmed: true, status: 'scheduled', completed: false, away: team(2), home: team(5) };
  const observedAt = new Date(epoch).toISOString();
  const row = { league: 'NBA', captureKey: 'completion-boundary', boardDate: game.taipeiDate, boardTime: '09:00',
    away: target.away, home: target.home, marketStatus: 'open', fullTotal: { line: '220+50', overWater: .94, underWater: .96 } };
  const snapshot = { league: 'NBA', boardDate: game.taipeiDate, observedAt, pageActivityAt: observedAt, games: [row], gameCount: 1 };
  let captureCalls = 0;
  const analysis = await loadNbaAnalysis({ date: game.taipeiDate, id: target.sourceId, observedAt }, {
    now: epoch, loadSchedule: async () => ({ league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, data: { games: [target] }, sources: [{ status: 'ready' }] }),
    loadReader: async () => snapshot,
    loadTraining: async () => ({ status: 'blocked', trainingData: null, halfTraining: null, preseasonTrainingData: null,
      issues: [{ code: 'NBA_LIVE_TRAINING_FROZEN_SCORE_CONFLICT', message: 'fixture conflict' }] }),
    saveCapture: async () => { captureCalls++; throw Error('Blocked history must not produce a capture'); },
  });
  assert.equal(analysis.status, 'blocked', 'Corrupt verified history must fail closed rather than fall back to frozen training');
  assert.equal(analysis.issues[0].code, 'NBA_LIVE_TRAINING_FROZEN_SCORE_CONFLICT');
  assert.equal(captureCalls, 0);
  assert.equal(networkCalls, 0);
  console.log(JSON.stringify({ status: 'PASS', historyAuth: true, csrf: true, trainingInjectionRejected: true,
    cronMissingAndWrongSecretRejected: true, historyFailureNoFallback: true, blockedHistoryNoFallback: true,
    groupedHistoryCounts: true, networkCalls }));
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(process.env, key, descriptor);
    else delete process.env[key];
  }
}
