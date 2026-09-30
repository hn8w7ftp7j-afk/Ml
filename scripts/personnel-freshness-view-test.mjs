import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { personnelFreshnessView, personnelScheduleObservation } from '../lib/personnel-freshness-view.js';
import { evaluateBetAction } from '../lib/bet-action-state-v118.js';
import { gameIsPrestartNow } from '../lib/client-analysis-state.js';

const now = Date.parse('2026-09-30T10:00:00.000Z');
const game = { leagueId: 'MLB', gamePk: 12, gameDate: '2026-09-30T10:15:00.000Z', gameNumber: 1, awayTeamId: 101, homeTeamId: 102 };
const row = { market: '全場大小', pick: '小8平', water: 0.95, sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', evCalibration: { actualReaderEligible: true } };
const item = { game, status: 'done', actualSource: { provider: 'TAI888_READER_AUTO' }, customMarkets: [row],
  customData: { pitPersistence: { confirmed: true }, analysis: { results: [row], calculatedDirectionCount: 1 },
    context: { leagueId: 'MLB', game, fetchedAt: '2026-09-30T09:59:30.000Z',
      away: { starter: { id: 201 }, lineup: { official: false, projected: true } },
      home: { starter: { id: 202 }, lineup: { official: false, projected: true } } } } };
const body = { ok: true, league: 'MLB', date: '2026-09-30', identityAsOf: '2026-09-30T10:00:00.000Z',
  games: [{ ...game, awayProbableId: 203, homeProbableId: 202, identitySourceEvidence: { rawBody: 'omit' } }] };
const observation = personnelScheduleObservation(body, { league: 'MLB', date: body.date, now });
assert.equal(observation.games[0].identitySourceEvidence, undefined);
const before = JSON.stringify(item);
assert.equal(personnelFreshnessView(item, { now }).status, 'PROJECTED');
const changed = personnelFreshnessView(item, { now, observation });
assert.equal(changed.status, 'STARTER_DIFFERS');
assert.deepEqual(changed.differences, [{ side: 'away', savedId: '201', latestId: '203' }]);
assert.equal(changed.latestLineupsChecked, false);
assert.equal(changed.latestUmpireChecked, false);
assert.equal(changed.actualPersonnelChecked, false);
for (const patch of [
  { leagueId: 'NPB' }, { gamePk: 13 }, { awayTeamId: 103 }, { homeTeamId: 104 },
  { gameNumber: 2 }, { gameDate: '2026-09-30T11:15:00.000Z' }, { awayProbableId: null },
]) {
  const invalid = { ...observation, games: [{ ...body.games[0], ...patch }] };
  assert.notEqual(personnelFreshnessView(item, { now, observation: invalid }).status, 'STARTER_DIFFERS', JSON.stringify(patch));
}
for (const invalid of [
  { ...observation, league: 'KBO' },
  { ...observation, observedAt: '2026-09-30T09:50:00.000Z' },
  { ...observation, observedAt: '2026-09-30T10:05:00.000Z' },
  { ...observation, observedAt: item.customData.context.fetchedAt },
  { ...observation, games: [body.games[0], body.games[0]] },
]) assert.notEqual(personnelFreshnessView(item, { now, observation: invalid }).status, 'STARTER_DIFFERS');
const stale = structuredClone(item);
stale.customData.context.fetchedAt = '2026-09-30T08:00:00.000Z';
assert.equal(personnelFreshnessView(stale, { now }).status, 'RECHECK_DUE');
assert.equal(personnelFreshnessView(stale, { now }).differences.length, 0, 'TTL expiry alone cannot claim a personnel change');
assert.equal(evaluateBetAction({ item: stale, row, now }).recordable, true, 'personnel display cannot block an actual bet record');
assert.equal(personnelFreshnessView(item, { now: now + 20 * 60_000 }), null, 'historical PIT is not a new-analysis prompt');
assert.equal(personnelFreshnessView({ game }, { now }), null);
const mismatched = structuredClone(item);
mismatched.customData.context.game = { ...mismatched.customData.context.game, gamePk: 999 };
assert.equal(personnelFreshnessView(mismatched, { now, observation }).status, 'UNVERIFIED');
assert.equal(JSON.stringify(item), before, 'all personnel display comparisons leave PIT/model values immutable');
for (const patch of [{ ok: false }, { league: 'KBO' }, { date: '2026-09-29' }, { identityAsOf: null }, { identityAsOf: '2026-09-30T11:00:00Z' }]) {
  assert.equal(personnelScheduleObservation({ ...body, ...patch }, { league: 'MLB', date: body.date, now }), null);
}

// Execute the actual page read-only acquisition boundary: concurrent manual
// schedule and monitor requests share one GET; monitor itself cannot analyze.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const start = page.indexOf('  async function fetchScheduleForLeague(');
const end = page.indexOf('\n  async function fetchSchedule(', start);
let resolveRequest;
const request = new Promise(resolve => { resolveRequest = resolve; });
const calls = [], observations = {};
const runtime = vm.createContext({ Date, Map, Number, encodeURIComponent, gameIsPrestartNow, personnelScheduleObservation,
  leagueConfig: () => ({ scheduleEndpoint: '/api/schedule' }), scheduleRequestsRef: { current: new Map() },
  requestJSONWithTransientRetry: (...args) => { calls.push(args); return request; },
  setPersonnelObservations: update => Object.assign(observations, update(observations)),
  currentDateRef: { current: 'different-date' }, currentLeagueRef: { current: 'MLB' },
  officialIdentityEvidenceRef: { current: new Map() }, setOfficialIdentityRevision: () => {},
});
vm.runInContext(page.slice(start, end), runtime);
const first = runtime.fetchScheduleForLeague('MLB', body.date, { monitorOnly: true });
const second = runtime.fetchScheduleForLeague('MLB', body.date);
assert.equal(calls.length, 1);
assert.equal(JSON.stringify(calls[0][1]), '{}');
resolveRequest({ ...body, identityAsOf: new Date().toISOString() });
await Promise.all([first, second]);
assert.equal(runtime.scheduleRequestsRef.current.size, 0);
assert.ok(observations[`MLB:${body.date}`]);
const monitor = page.slice(page.indexOf('    const observePersonnelSchedule = async () => {'), page.indexOf('  const currentReaderHashKey'));
assert.match(monitor, /document.visibilityState !== 'visible'/);
assert.match(monitor, /monitorOnly: true/);
assert.doesNotMatch(monitor.slice(0, monitor.indexOf('  useEffect(() => {')), /oneClickAnalyze|pollReaderAndReprice|startBackgroundAnalysis/);
const recheck = page.slice(page.indexOf('  function recheckReaderItem('), page.indexOf('  // Preparation belongs'));
assert.doesNotMatch(recheck, /setTab|scrollTo/);
console.log('PASS personnel freshness: scoped starter differences, TTL-only warning, immutable PIT, read-only deduplicated observation, same-page manual recheck and unchanged recording');
