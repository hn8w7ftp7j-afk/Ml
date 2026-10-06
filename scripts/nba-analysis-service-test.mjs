import assert from 'node:assert/strict';
import { nbaQuoteFingerprint } from '../lib/nba/quote-fingerprint.js';
import { loadNbaAnalysis, validNbaAnalysisQuery } from '../lib/nba/analysis-service.js';
import { createSessionToken } from '../lib/security.js';
import { requestedLeagueId, leagueCanAnalyze } from '../lib/leagues.js';
import { cloudBetLeagueCanWrite } from '../lib/cloud-bet-store.js';

const epoch = Date.parse('2026-10-05T00:00:00Z');
const date = '2026-10-05', observedAt = new Date(epoch).toISOString();
const team = id => ({ id: `nba:espn:team:${id}`, league: 'NBA', sourceId: String(id) });
const game = { id: 'nba:espn:game:401999001', sourceId: '401999001', league: 'NBA', taipeiDate: date,
  season: { year: 2027 }, seasonType: 'preseason', startTime: '2026-10-05T01:00:00Z',
  timeConfirmed: true, status: 'scheduled', completed: false, away: team(2), home: team(5) };
const row = { league: 'NBA', captureKey: 'fixture-capture', boardDate: date, boardTime: '09:00',
  away: game.away, home: game.home, marketStatus: 'open', fullTotal: { line: '220+50', overWater: .94, underWater: .96 } };
const snapshot = { league: 'NBA', boardDate: date, observedAt, pageActivityAt: observedAt, games: [row], gameCount: 1 };
const schedule = { league: 'NBA', status: 'ready', qa: { status: 'WARNING' }, data: { games: [game] }, sources: [{ status: 'ready', fetchedAt: observedAt, hash: 'fixture' }] };
const query = { date, id: game.sourceId, observedAt };
assert.equal(validNbaAnalysisQuery(query), true);
for (const invalid of [{ ...query, date: '2026-02-30' }, { ...query, id: 'nba:espn:team:5' }, { ...query, observedAt: '2026-10-05' }]) assert.equal(validNbaAnalysisQuery(invalid), false);
let modelCalls = 0;
const model = (actualGame, quote) => {
  modelCalls++; assert.equal(actualGame.id, game.id); assert.deepEqual(quote, row.fullTotal);
  return { status: 'ready', prediction: { home: 110, away: 110, baseTotal: 220, total: 219, correction: -1 }, assessment: { direction: 'under' }, probabilityEstimate: null };
};
const options = (s = schedule, b = snapshot, more = {}) => ({ now: epoch, loadSchedule: async () => s, loadReader: async () => b, analyzeModel: model, ...more });
const ready = await loadNbaAnalysis(query, options());
assert.equal(ready.status, 'ready'); assert.equal(ready.gameId, game.id); assert.equal(ready.observedAt, observedAt);
assert.equal(ready.executable, false); assert.equal(ready.probabilityEstimate, null); assert.equal(ready.quote.period, 'full');
assert.equal(ready.scope, 'NBA_full_game_total_only'); assert.match(ready.quoteHash, /^[a-f0-9]{64}$/);
assert.equal(modelCalls, 1);
async function blocked(expected, s = schedule, b = snapshot, more = {}, q = query) {
  const before = modelCalls, result = await loadNbaAnalysis(q, options(s, b, more));
  assert.equal(result.status, 'blocked'); assert.equal(result.issues[0].code, expected); assert.equal(modelCalls, before);
}
await blocked('NBA_ANALYSIS_QUOTE_CHANGED', schedule, null);
await blocked('NBA_ANALYSIS_QUOTE_CHANGED', schedule, { ...snapshot, observedAt: new Date(epoch + 1).toISOString() });
await blocked('NBA_ANALYSIS_QUOTE_EXPIRED', schedule, { ...snapshot, observedAt: new Date(epoch - 180001).toISOString(), pageActivityAt: new Date(epoch - 180001).toISOString() }, {}, { ...query, observedAt: new Date(epoch - 180001).toISOString() });
await blocked('NBA_ANALYSIS_SCHEDULE_UNVERIFIED', { ...schedule, sources: [{ status: 'stale' }] });
await blocked('NBA_ANALYSIS_GAME_UNVERIFIED', { ...schedule, data: { games: [game, game] } });
await blocked('NBA_ANALYSIS_GAME_UNVERIFIED', { ...schedule, data: { games: [{ ...game, home: team(6) }] } });
for (const change of [{ status: 'live' }, { completed: true }, { timeConfirmed: false }, { startTime: observedAt }]) {
  const candidate = { ...game, ...change };
  const b = { ...snapshot, games: [{ ...row, boardTime: change.startTime ? '08:00' : row.boardTime }] };
  await blocked('NBA_ANALYSIS_GAME_STARTED', { ...schedule, data: { games: [candidate] } }, b);
}
await blocked('NBA_ANALYSIS_TOTAL_UNAVAILABLE', schedule, { ...snapshot, games: [{ ...row, marketStatus: 'locked', fullTotal: null }] });
await blocked('NBA_ANALYSIS_TOTAL_UNAVAILABLE', { ...schedule, data: { games: [{ ...game, seasonType: 'regular' }] } }, { ...snapshot, games: [{ ...row, fullTotal: null, firstHalfTotal: row.fullTotal }] });
const during = await loadNbaAnalysis(query, options(schedule, snapshot, { analyzeModel: () => { modelCalls++; return { status: 'ready' }; }, now: (() => { let calls = 0; return () => ++calls > 2 ? epoch + 180001 : epoch; })() }));
assert.equal(during.status, 'blocked'); assert.equal(during.issues[0].code, 'NBA_ANALYSIS_EXPIRED_DURING_REQUEST');
const changedDuring = await loadNbaAnalysis(query, options(schedule, snapshot, { loadReader: (() => { let reads = 0; return async () => ++reads === 1 ? snapshot : { ...snapshot, observedAt: new Date(epoch + 1).toISOString() }; })() }));
assert.equal(changedDuring.status, 'blocked'); assert.equal(changedDuring.issues[0].code, 'NBA_ANALYSIS_QUOTE_CHANGED');
const insufficient = await loadNbaAnalysis(query, options(schedule, snapshot, { analyzeModel: () => ({ status: 'insufficient', training: { seasonYear: 2027, seasonType: 'preseason', availableGames: 0, minimumResiduals: 50 }, issues: [{ code: 'NBA_MODEL_HISTORY_INSUFFICIENT', message: 'fixture' }] }) }));
assert.equal(insufficient.status, 'reference'); assert.equal(insufficient.training.seasonYear, 2027); assert.equal(insufficient.executable, false);
assert.equal(insufficient.referencePrediction.calibrated, false);
assert.equal(insufficient.referencePrediction.probabilityEstimate, null);
const missing = await loadNbaAnalysis(query, options(schedule, snapshot, { trainingData: { history: [] }, analyzeModel: () => ({ status: 'insufficient' }) }));
assert.equal(missing.status, 'insufficient');

// New forecasting endpoint never expands the baseball analysis/ledger registry.
assert.equal(requestedLeagueId('NBA'), null); assert.equal(leagueCanAnalyze('NBA'), false); assert.equal(cloudBetLeagueCanWrite('NBA'), false);
process.env.APP_PASSWORD = 'nba-analysis-local-fixture'; process.env.SESSION_SECRET = 'nba-analysis-local-fixture-secret';
const { GET } = await import('../app/api/nba/analysis/route.js');
assert.equal((await GET(new Request('https://fixture.test/api/nba/analysis'))).status, 401);
const cookie = `mlb_session=${await createSessionToken()}`;
for (const params of ['', 'date=2026-02-30&id=401999001&observedAt=' + encodeURIComponent(observedAt), 'date=2026-10-05&id=401999001&observedAt=' + encodeURIComponent(observedAt) + '&id=401999002', 'date=2026-10-05&id=401999001&observedAt=' + encodeURIComponent(observedAt) + '&score=999']) {
  const res = await GET(new Request(`https://fixture.test/api/nba/analysis?${params}`, { headers: { cookie } })); assert.equal(res.status, 400); assert.equal(res.headers.get('Cache-Control'), 'no-store');
}
console.log('NBA analysis service: trusted quote/schedule binding, freshness, event identity, start/lock guards, request expiry, private route, query rejection and baseball isolation PASS');

const bound = { ...query, quoteFingerprint: nbaQuoteFingerprint(row) };
const heartbeat = { ...snapshot, observedAt: new Date(epoch + 1000).toISOString(), pageActivityAt: new Date(epoch + 1000).toISOString(), clientPayloadHash: 'new-heartbeat' };
assert.equal((await loadNbaAnalysis(bound, options(schedule, heartbeat, { now: epoch + 2000 }))).status, 'ready');
const duringHeartbeat = await loadNbaAnalysis(bound, options(schedule, snapshot, { now: epoch + 2000, loadReader: (() => { let reads = 0; return async () => ++reads === 1 ? snapshot : heartbeat; })() }));
assert.equal(duringHeartbeat.status, 'ready');
assert.equal(duringHeartbeat.observedAt, query.observedAt); // Task binding retained; actual source timestamp separately archived.
const otherGame = { ...row, captureKey: 'other', away: team(8), home: team(9), fullTotal: { ...row.fullTotal, line: '230' } };
assert.equal((await loadNbaAnalysis(bound, options(schedule, snapshot, { now: epoch + 2000, loadReader: (() => { let reads = 0; return async () => ++reads === 1 ? snapshot : { ...heartbeat, games: [row, otherGame] }; })() }))).status, 'ready');
for (const changedRow of [{ ...row, fullTotal: { ...row.fullTotal, line: '221' } }, { ...row, fullTotal: { ...row.fullTotal, overWater: .90 } }, { ...row, marketStatus: 'locked', fullTotal: null }, { ...row, home: team(6) }]) {
 const result = await loadNbaAnalysis(bound, options(schedule, snapshot, { now: epoch + 2000, loadReader: (() => { let reads = 0; return async () => ++reads === 1 ? snapshot : { ...heartbeat, games: [changedRow] }; })() }));
 assert.equal(result.status, 'blocked'); assert.equal(result.issues[0].code, 'NBA_ANALYSIS_QUOTE_CHANGED');
}
await blocked('NBA_ANALYSIS_QUOTE_CHANGED', schedule, { ...heartbeat, games: [{ ...row, fullTotal: { ...row.fullTotal, line: '222' } }] }, { now: epoch + 2000 }, bound);
assert.equal(validNbaAnalysisQuery({...query,quoteFingerprint:'bad'}),false);
console.log('NBA heartbeat race PASS: same contract and other-game updates allowed; real price/water/lock/identity changes blocked');

const halfOnlyDefault = await loadNbaAnalysis(query, options({...schedule,data:{games:[{...game,seasonType:'regular',neutralSite:false}]}},{...snapshot,games:[{...row,fullTotal:null,firstHalfTotal:row.fullTotal}]},{analyzeModel:undefined}));
assert.equal(halfOnlyDefault.status,'insufficient');assert.equal(halfOnlyDefault.modelVersion,'nba-regular-four-market-v1');assert.notEqual(halfOnlyDefault.issues[0]?.code,'NBA_ANALYSIS_TOTAL_UNAVAILABLE');
