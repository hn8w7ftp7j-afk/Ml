// Executes the actual Reader route bodies with dependency doubles. This verifies
// route ordering and failure receipts, not PostgreSQL concurrency or Production.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const deviceId = 'history-ingest-fixture';
const date = '2026-10-15';
const baseTime = Date.now() - 20_000;
const iso = offset => new Date(baseTime + offset).toISOString();
const sourceHost = 'tai888.in';
const hash = value => value.repeat(64);
const schedule = [{ gamePk: 777, league: 'MLB' }];
const traces = [];
let previous = null;
let historyMode = 'success';
let databaseConfigured = true;
let historyRows = [];
let stores = 0;
let refreshes = 0;
let failOnHistoryCall = null;

function reset(snapshot = null) {
  previous = snapshot ? structuredClone(snapshot) : null;
  traces.length = 0;
  historyRows = [];
  historyMode = 'success';
  databaseConfigured = true;
  stores = 0;
  refreshes = 0;
  failOnHistoryCall = null;
}

function baseball(offset = 0, rawBoardHash = hash('a')) {
  return {
    league: 'MLB', boardDate: date, deviceId, sourceHost,
    observedAt: iso(offset), pageActivityAt: iso(offset), receivedAt: iso(offset),
    readerVersion: '2.1.31', rawBoardHash, payloadHash: hash('b'),
    matchedGameCount: 1, rawGameCount: 1, marketCount: 1,
    directionCount: 2, partialGameCount: 0, unopenedGameCount: 0,
    scheduleGameCount: 1, identityBlockedGameCount: 0,
    identityIssues: [], unmatched: [], unopenedGames: [],
    games: [{ gamePk: 777, league: 'MLB', markets: [
      { market: '全場大小', pick: '大8+20', water: 0.95 },
      { market: '全場大小', pick: '小8+20', water: 0.95 },
    ] }],
  };
}

function nba(offset = 0, clientPayloadHash = hash('c')) {
  return {
    league: 'NBA', boardDate: date, deviceId, sourceHost,
    observedAt: iso(offset), pageActivityAt: iso(offset), receivedAt: iso(offset),
    readerVersion: '2.1.31', clientPayloadHash, executable: false,
    gameCount: 1, marketCount: 1,
    games: [{ boardTime: '07:00', awayCode: 'GSW', homeCode: 'LAL',
      fullTotal: { line: '224+50', overWater: 0.95, underWater: 0.95 } }],
  };
}

async function recordHistory(snapshot) {
  traces.push({ kind: 'history', observedAt: snapshot.observedAt, pageActivityAt: snapshot.pageActivityAt });
  historyRows.push(structuredClone(snapshot));
  if (historyMode === 'throw' || historyRows.length === failOnHistoryCall) throw Error('synthetic archive failure');
  if (historyMode === 'failed') return { configured: true, checked: 1, inserted: 0, unchanged: 0, failed: 1 };
  if (!databaseConfigured) return { configured: false, checked: 1, inserted: 0, unchanged: 1, failed: 0 };
  return { configured: true, checked: 1, inserted: 1, unchanged: 0, failed: 0 };
}

const deps = {
  NextResponse: { json: (body, options = {}) => new Response(JSON.stringify(body), {
    status: options.status || 200, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  }) },
  console: { info() {}, warn() {}, error() {} },
  fetchLeagueTaipeiSlate: async () => schedule,
  filterLeaguePrestartGames: (_league, games) => games,
  bearerToken: () => 'fixture-token',
  readerCorsHeaders: () => ({}),
  readerOriginAllowed: () => true,
  verifyReaderToken: async () => ({ deviceId }),
  loadReaderSnapshot: async () => previous ? structuredClone(previous) : null,
  loadNbaReaderSnapshot: async () => previous ? structuredClone(previous) : null,
  storeReaderSnapshot: async snapshot => {
    traces.push({ kind: 'store', observedAt: snapshot.observedAt }); stores++;
    previous = structuredClone(snapshot);
    return { runtimeCache: false, database: true, durable: true, allRequiredWritesSucceeded: true };
  },
  refreshReaderSnapshot: async (snapshot, times) => {
    traces.push({ kind: 'refresh', observedAt: times.observedAt }); refreshes++;
    previous = { ...structuredClone(snapshot), ...times };
    return { snapshot: previous, storage: { runtimeCache: false, database: true, durable: true, allRequiredWritesSucceeded: true } };
  },
  readerSnapshotStatus: () => ({ available: true, fresh: true }),
  normalizeTai888ReaderPayload: body => structuredClone(body),
  readerSnapshotIsComplete: () => true,
  validateTai888ReaderEnvelope: body => structuredClone(body),
  leagueConfig: () => ({ capabilities: { reader: true }, shortLabel: '美棒', label: '美棒' }),
  requestedLeagueId: league => league,
  checkRateLimit: () => ({ allowed: true }),
  cleanText: (value, limit) => String(value || '').slice(0, limit),
  rateLimitResponse: () => new Response(null, { status: 429 }),
  readJsonBody: request => request.json(),
  validDateString: () => true,
  validDate: () => true,
  requireApiAuth: async () => null,
  updateOpenCloudBetClosingSnapshots: async () => ({ configured: true, checked: 0, updated: 0, skipped: 0, failed: 0 }),
  marketLineHistoryDatabaseConfigured: () => databaseConfigured,
  buildMarketLineHistoryRows: snapshot => snapshot?.games || [],
  recordMarketLineHistory: recordHistory,
  normalizeNbaReaderPayload: body => structuredClone(body),
  nbaReaderPublicView: snapshot => snapshot,
  assertNbaReaderMonotonic: (old, incoming) => {
    if (!old) return;
    if (Date.parse(incoming.observedAt) <= Date.parse(old.observedAt)
      || Date.parse(incoming.pageActivityAt) < Date.parse(old.pageActivityAt)
      || (incoming.clientPayloadHash !== old.clientPayloadHash
        && Date.parse(incoming.pageActivityAt) <= Date.parse(old.pageActivityAt))) {
      throw Object.assign(Error('NBA 時間倒退或重播'), { code: 'NBA_READER_REPLAY', status: 409 });
    }
  },
  storeNbaReaderSnapshot: async snapshot => {
    // Match the actual database monotonic contract rather than accepting any
    // mock write; exact duplicates must avoid this call entirely.
    deps.assertNbaReaderMonotonic(previous, snapshot);
    traces.push({ kind: 'store', observedAt: snapshot.observedAt }); stores++;
    previous = structuredClone(snapshot);
    return { runtimeCache: false, storage: 'database', durable: true, persisted: true };
  },
};

const historyReceiptSource = readFileSync(new URL('../lib/reader-history-receipt.js', import.meta.url), 'utf8')
  .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '')
  .replace(/^export\s+/gm, '');
deps.requireReaderHistorySaved = new Function(...Object.keys(deps), `${historyReceiptSource}\nreturn requireReaderHistorySaved;`)(...Object.values(deps));

function loadRoute(relativePath) {
  const source = readFileSync(new URL(relativePath, import.meta.url), 'utf8')
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '')
    .replace(/^export\s+/gm, '');
  return new Function(...Object.keys(deps), `${source}\nreturn { POST };`)(...Object.values(deps));
}

const baseballRoute = loadRoute('../app/api/reader/ingest/route.js');
const nbaRoute = loadRoute('../app/api/nba/reader/route.js');
async function post(route, body) {
  const response = await route.POST(new Request('https://fixture.test/api/reader', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Device-Id': deviceId }, body: JSON.stringify(body),
  }));
  return { status: response.status, body: await response.json() };
}

function assertArchiveFailure(result, label) {
  assert.equal(result.status, 503, `${label}: failed archive must return HTTP 503`);
  assert.equal(result.body.ok, false, `${label}: failed archive cannot be ok:true`);
  assert.equal(result.body.allRequiredWritesSucceeded, false, `${label}: failed archive cannot claim all writes succeeded`);
  assert.equal(result.body.historyTracking.failed, 1, `${label}: failure receipt must be retained`);
}

for (const mode of ['throw', 'failed']) {
  reset(); historyMode = mode;
  assertArchiveFailure(await post(baseballRoute, baseball()), `baseball new/${mode}`);
  assert.equal(stores, 0, 'baseball failed archive cannot advance live authority');
  assert.equal(previous, null);
}
reset(); databaseConfigured = false;
const missingBaseball = await post(baseballRoute, baseball());
assert.equal(missingBaseball.status, 503, 'missing archive configuration must fail closed');
assert.equal(missingBaseball.body.ok, false);
assert.equal(stores, 0);

reset();
const firstBaseball = await post(baseballRoute, baseball());
assert.equal(firstBaseball.status, 200, firstBaseball.body.error);
assert.equal(firstBaseball.body.ok, true);
assert.equal(firstBaseball.body.allRequiredWritesSucceeded, true);
assert.deepEqual(traces.map(row => row.kind), ['history', 'store'], 'new capture must archive before advancing board authority');

for (const duplicate of [false, true]) {
  const original = baseball(); reset(original); historyMode = 'throw';
  const incoming = duplicate ? original : baseball(1000);
  assertArchiveFailure(await post(baseballRoute, incoming), `baseball ${duplicate ? 'duplicate' : 'heartbeat'}`);
  assert.equal(stores, 0); assert.equal(refreshes, 0);
  assert.equal(previous.pageActivityAt, original.pageActivityAt, 'archive failure must preserve original failed capture timestamp');
  assert.equal(historyRows[0].pageActivityAt, original.pageActivityAt, 'catch-up must archive original capture, not heartbeat time');
  historyMode = 'success';
  const recovered = await post(baseballRoute, incoming);
  assert.equal(recovered.status, 200, recovered.body.error);
  assert.equal(recovered.body.ok, true);
  assert.equal(recovered.body.historyTracking.failed, 0);
  assert.equal(historyRows.at(-1).pageActivityAt, original.pageActivityAt);
  assert.equal(refreshes, duplicate ? 0 : 1);
  assert.equal(stores, 0);
  if (duplicate) assert.equal(recovered.body.duplicateCapture, true);
}

const originalBaseball = baseball();
const changedBaseball = baseball(1000, hash('e'));
reset(originalBaseball);
const replacementBaseball = await post(baseballRoute, changedBaseball);
assert.equal(replacementBaseball.status, 200, replacementBaseball.body.error);
assert.deepEqual(traces.map(row => row.kind), ['history', 'history', 'store'], 'replacement must catch up original durable state before archiving and replacing it');
assert.deepEqual(historyRows.map(row => row.pageActivityAt), [originalBaseball.pageActivityAt, changedBaseball.pageActivityAt]);
for (const call of [1, 2]) {
  reset(originalBaseball); failOnHistoryCall = call;
  assertArchiveFailure(await post(baseballRoute, changedBaseball), `baseball replacement failure at archive ${call}`);
  assert.equal(stores, 0);
  assert.equal(previous.observedAt, originalBaseball.observedAt);
}

for (const mode of ['throw', 'failed']) {
  reset(); historyMode = mode;
  assertArchiveFailure(await post(nbaRoute, nba()), `NBA new/${mode}`);
  assert.equal(stores, 0, 'NBA failed archive cannot advance live authority');
}
reset(); databaseConfigured = false;
const missingNba = await post(nbaRoute, nba());
assert.equal(missingNba.status, 503, 'NBA missing archive configuration must fail closed');
assert.equal(missingNba.body.ok, false); assert.equal(stores, 0);

reset();
const firstNba = await post(nbaRoute, nba());
assert.equal(firstNba.status, 200, firstNba.body.error);
assert.equal(firstNba.body.ok, true);
assert.equal(firstNba.body.allRequiredWritesSucceeded, true);
assert.deepEqual(traces.map(row => row.kind), ['history', 'store'], 'NBA capture must archive before authority advances');

const originalNba = nba(); reset(originalNba); historyMode = 'throw';
assertArchiveFailure(await post(nbaRoute, originalNba), 'NBA exact duplicate recovery');
assert.equal(stores, 0, 'exact duplicate must not rewrite live authority or enter strict monotonic upsert');
assert.equal(historyRows[0].pageActivityAt, originalNba.pageActivityAt);
historyMode = 'success';
const duplicateNba = await post(nbaRoute, originalNba);
assert.equal(duplicateNba.status, 200, duplicateNba.body.error);
assert.equal(duplicateNba.body.duplicateCapture, true);
assert.equal(duplicateNba.body.ok, true);
assert.equal(stores, 0);
assert.equal(previous.observedAt, originalNba.observedAt);

const changedNba = nba(1000, hash('e'));
reset(originalNba);
const replacementNba = await post(nbaRoute, changedNba);
assert.equal(replacementNba.status, 200, replacementNba.body.error);
assert.deepEqual(traces.map(row => row.kind), ['history', 'history', 'store'], 'NBA replacement must preserve previous capture before incoming write');
assert.deepEqual(historyRows.map(row => row.pageActivityAt), [originalNba.pageActivityAt, changedNba.pageActivityAt]);
for (const call of [1, 2]) {
  reset(originalNba); failOnHistoryCall = call;
  assertArchiveFailure(await post(nbaRoute, changedNba), `NBA replacement failure at archive ${call}`);
  assert.equal(stores, 0);
  assert.equal(previous.observedAt, originalNba.observedAt);
}

for (const invalid of [nba(-1000), { ...nba(1000, hash('d')), pageActivityAt: originalNba.pageActivityAt }]) {
  reset(originalNba);
  const rejected = await post(nbaRoute, invalid);
  assert.equal(rejected.status, 409, 'NBA stale or changed-without-activity capture must remain rejected');
  assert.equal(rejected.body.ok, false);
  assert.equal(stores, 0);
  assert.equal(historyRows.length, 0, 'invalid NBA capture must be rejected before archive');
}

console.log('Reader history route simulation PASS: archive-before-authority, truthful failure receipts, original-time heartbeat/duplicate recovery, NBA replay isolation (not live DB/Production)');
