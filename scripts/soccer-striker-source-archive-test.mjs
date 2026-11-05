import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture = await soccerSqlFixture(), { db } = fixture;
const envKeys = ['DATABASE_URL', 'DATABASE_V2_URL', 'SOCCER_STRIKER_RESEARCH_ENABLED', 'SOCCER_STRIKER_API_KEY',
  'SOCCER_STRIKER_BUDGET_ID', 'SOCCER_STRIKER_BUDGET_WINDOW_START'];
const oldEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const oldFetch = globalThis.fetch;
const ENDPOINT = 'https://mcp.strikerapi.com/v1/get_events';
const KEY = 'synthetic-secret-unique-not-a-real-key';
const sha = value => createHash('sha256').update(value, 'utf8').digest('hex');
const shot = (seq, teamId, period, xg) => ({ seq, type: 'shot', team_id: teamId, period,
  shot: { xg, penalty: false, x: 0.2, y: 0.3, outcome: 'saved', body_part: 'head' }, own_goal: false, shootout: false });
const wrap = (events, next_offset) => ({ data: { events, count: events.length, next_offset } });
let mode = 'two', calls = [], mutateAfterFirst = null, lastBody = null;
globalThis.fetch = async (url, options) => {
  const body = JSON.parse(options.body);
  assert.equal(url, ENDPOINT);
  assert.equal(options.headers['x-api-key'], KEY);
  calls.push({ url, body, requestId: options.headers['x-request-id'] });
  if (mode === 'abort') throw Object.assign(Error('synthetic request aborted'), { name: 'AbortError' });
  if (mode === 'timeout') return await new Promise((_resolve, reject) => {
    const guard = setTimeout(() => reject(Error('synthetic deadline guard expired')), 15000);
    options.signal.addEventListener('abort', () => { clearTimeout(guard); reject(Object.assign(Error('synthetic deadline'), { name: 'AbortError' })); }, { once: true });
  });
  let content = wrap([shot(1, '382', 1, 0.2)], null);
  if (mode === 'two') {
    content = body.offset === 0 ? wrap([shot(1, '382', 1, 0.2)], 1) : wrap([shot(2, '359', 2, 0.4)], null);
    if (body.offset === 0 && mutateAfterFirst) mutateAfterFirst();
  } else if (mode === 'secret' || mode === 'escaped-secret') content.data.internal_note = KEY;
  else if (mode === 'unicode' || mode === 'bom') content.data.note = '球員射門';
  lastBody = (mode === 'bom' ? '\ufeff' : '') + JSON.stringify(content);
  if (mode === 'escaped-secret') lastBody = lastBody.replace(KEY, '\\u0073' + KEY.slice(1));
  const response = new Response(lastBody, { status: mode === 'http' ? 503 : 200, headers: { 'content-type': 'application/json' } });
  Object.defineProperty(response, 'url', { value: ENDPOINT });
  return response;
};
process.env.DATABASE_URL = 'postgres://fixture.invalid/striker-archive';
delete process.env.DATABASE_V2_URL;
delete process.env.SOCCER_STRIKER_RESEARCH_ENABLED;
delete process.env.SOCCER_STRIKER_API_KEY;
delete process.env.SOCCER_STRIKER_BUDGET_ID;
delete process.env.SOCCER_STRIKER_BUDGET_WINDOW_START;
const scope = () => ({ league: 'epl', gameId: '740916', homeTeamId: '382', awayTeamId: '359' });
const optionsCount = () => calls.length;
try {
  const { captureStrikerResearch: capture, archiveStrikerResearch: archive, loadStrikerResearchCapture: load } = await import('../lib/soccer/striker-source-archive.js');
  const { ensureStrikerCreditBudgetStore, createStrikerCreditBudget } = await import('../lib/soccer/striker-credit-budget.js');
  assert.equal((await capture(scope())).reason, 'STRIKER_ARCHIVE_DISABLED');
  assert.equal(optionsCount(), 0, 'disabled connector cannot contact the provider');
  process.env.SOCCER_STRIKER_RESEARCH_ENABLED = 'true';
  assert.equal((await capture(scope())).reason, 'STRIKER_CONFIG_MISSING');
  assert.equal(optionsCount(), 0, 'enabled without configuration cannot contact the provider');
  await ensureStrikerCreditBudgetStore();
  const budgetId = randomUUID(), startMs = Date.now() + 1500;
  const windowStart = new Date(startMs).toISOString(), windowEnd = new Date(startMs + 60000).toISOString();
  assert.equal((await createStrikerCreditBudget({ enabled: true, budgetId, windowStart, windowEnd, maxCredits: 200 })).status, 'CREATED');
  process.env.SOCCER_STRIKER_API_KEY = KEY;
  process.env.SOCCER_STRIKER_BUDGET_ID = budgetId;
  process.env.SOCCER_STRIKER_BUDGET_WINDOW_START = windowStart;
  assert.equal((await capture(scope())).ok, false, 'inactive future window must fail closed');
  assert.equal(optionsCount(), 0);
  await new Promise(resolve => setTimeout(resolve, Math.max(0, startMs - Date.now() + 60)));
  const mutable = scope();
  mutateAfterFirst = () => { mutable.gameId = '99999'; mutable.league = 'ucl'; mutable.homeTeamId = '777'; };
  const first = await capture(mutable);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map(c => c.body.offset), [0, 1]);
  assert.deepEqual(calls.map(c => c.body.game_id), ['740916', '740916'], 'each page must retain the original fixture identity');
  assert.deepEqual(calls.map(c => c.body.league), ['soccer', 'soccer']);
  assert.deepEqual(first.scope, scope());
  assert.equal(JSON.stringify(first).includes(KEY), false);
  assert.equal(JSON.stringify(first).includes('events'), false, 'source pages stay in the private capture capability');
  assert.equal(first.strictOosEligible, false);
  assert.equal(first.historicalAvailabilityVerified, false);
  assert.equal((await archive(structuredClone(first))).ok, false, 'cloned handles cannot grant source authority');
  const altered = first.scope.homeTeamId; first.scope.homeTeamId = '123';
  assert.equal((await archive(first)).ok, false, 'tampered live handle cannot grant source authority');
  first.scope.homeTeamId = altered;
  const receipt = await archive(first);
  assert.equal(receipt.ok, true, JSON.stringify(receipt));
  assert.equal(receipt.status, 'ARCHIVED_RESEARCH_ONLY');
  assert.equal(receipt.receipts.length, 2);
  assert.equal(receipt.strictOosEligible, false);
  assert.equal(receipt.formalEligible, false);
  assert.equal(JSON.stringify(receipt).includes(KEY), false);
  assert.match(receipt.sourceModelNotice, /NOT_STRICT_OOS/);
  assert.deepEqual(await archive(first), receipt, 'repeat archival returns the immutable original receipt');
  const audit = await load(first.captureId);
  assert.equal(audit.ok, true, JSON.stringify(audit));
  assert.equal(audit.status, 'ARCHIVED_RESEARCH_AUDIT_ONLY');
  assert.equal(audit.documents.length, 2);
  assert.equal(audit.strictOosEligible, false);
  assert.equal(audit.historicalAvailabilityVerified, false);
  assert.equal((await load(randomUUID())).ok, false);
  assert.equal((await load('not-a-uuid')).ok, false);
  for (const pageReceipt of receipt.receipts) {
    const exact = (await db.query('SELECT recorded_at <= $2::timestamptz AS safe FROM sports_soccer_striker_observations_v1 WHERE receipt_id=$1', [pageReceipt.receiptId, pageReceipt.recordedAtUpperBound])).rows[0];
    assert.equal(exact.safe, true, 'millisecond upper bound may not backdate the PostgreSQL receipt');
    assert.ok(Date.parse(pageReceipt.recordedAtUpperBound) - Date.parse(pageReceipt.recordedAt) >= 0);
    assert.ok(Date.parse(pageReceipt.recordedAtUpperBound) - Date.parse(pageReceipt.recordedAt) <= 1);
  }

  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_striker_documents_v1')).rows[0].n, 2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_striker_observations_v1')).rows[0].n, 2);
  for (const table of ['sports_soccer_striker_documents_v1', 'sports_soccer_striker_observations_v1']) {
    await assert.rejects(() => db.query(`DELETE FROM ${table}`), /SOCCER_IMMUTABLE_HISTORY/);
  }
  let reserved = (await db.query('SELECT reserved_credits FROM sports_soccer_striker_credit_windows_v1 WHERE budget_id=$1::uuid', [budgetId])).rows[0].reserved_credits;
  assert.equal(reserved, 20);
  for (const failureMode of ['http', 'abort', 'timeout', 'secret', 'escaped-secret']) {
    mode = failureMode; const previous = reserved; const result = await capture(scope());
    assert.equal(result.ok, false, `${failureMode} must fail closed`);
    assert.equal(JSON.stringify(result).includes(KEY), false);
    reserved = (await db.query('SELECT reserved_credits FROM sports_soccer_striker_credit_windows_v1 WHERE budget_id=$1::uuid', [budgetId])).rows[0].reserved_credits;
    assert.equal(reserved, previous + 10, `${failureMode} retains its pessimistic reservation`);
  }
  // A DB reservation may finish *after* the signal deadline. It must not lead
  // to a late upstream request, and the eventual reservation remains charged.
  const originalSql = globalThis.__SOCCER_TEST_SQL;
  let releaseReservation, signalStarted, signalSettled, intercepted = false;
  const gate = new Promise(resolve => { releaseReservation = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  const settled = new Promise(resolve => { signalSettled = resolve; });
  globalThis.__SOCCER_TEST_SQL = async (queries, isTransaction) => {
    if (!intercepted && queries.some(q => q.query.includes('sports_soccer_striker_reserve_credits_v1'))) {
      intercepted = true; signalStarted(); await gate;
      try { return await originalSql(queries, isTransaction); } finally { signalSettled(); }
    }
    return originalSql(queries, isTransaction);
  };
  const priorCalls = calls.length, priorCredits = reserved;
  const guard = setTimeout(() => {}, 15000);
  try {
    const delayed = capture(scope());
    await started;
    const result = await delayed;
    clearTimeout(guard);
    assert.equal(result.ok, false, 'reservation timeout must fail closed');
    assert.equal(calls.length, priorCalls, 'no upstream request before a delayed reservation');
    releaseReservation();
    await settled;
    await Promise.resolve();
    reserved = (await db.query('SELECT reserved_credits FROM sports_soccer_striker_credit_windows_v1 WHERE budget_id=$1::uuid', [budgetId])).rows[0].reserved_credits;
    assert.equal(reserved, priorCredits + 10, 'late successful DB reservation remains charged');
    assert.equal(calls.length, priorCalls, 'late reservation must never trigger an upstream request');
  } finally {
    clearTimeout(guard);
    releaseReservation();
    globalThis.__SOCCER_TEST_SQL = originalSql;
  }
  mode = 'one'; const ucl = await capture({ ...scope(), league: 'ucl' });
  assert.equal(ucl.ok, true, JSON.stringify(ucl));
  assert.equal(calls.at(-1).body.league, 'ucl');
  assert.equal((await archive(ucl)).ok, true);
  mode = 'unicode'; const unicode = await capture(scope()); const unicodeBody = lastBody;
  assert.equal(unicode.ok, true, JSON.stringify(unicode));
  const unicodeReceipt = await archive(unicode); assert.equal(unicodeReceipt.ok, true);
  const unicodeRow = (await db.query("SELECT encode(document_data,'hex') AS data_hex FROM sports_soccer_striker_documents_v1 WHERE content_hash=$1", [sha(unicodeBody)])).rows[0];
  assert.equal(Buffer.from(unicodeRow.data_hex, 'hex').toString('utf8'), unicodeBody, 'non-ASCII source bytes survive UTF-8 roundtrip');
  mode = 'bom'; const bom = await capture(scope()); const bomBody = lastBody;
  if (bom.ok) {
    const r = await archive(bom); assert.equal(r.ok, true, JSON.stringify(r));
    const rows = (await db.query("SELECT encode(document_data,'hex') AS data_hex FROM sports_soccer_striker_documents_v1 WHERE content_hash=$1", [sha(bomBody)])).rows;
    assert.equal(rows.length, 1, 'BOM source must be rejected or preserved byte-for-byte with original hash');
    assert.equal(Buffer.from(rows[0].data_hex, 'hex').toString('utf8'), bomBody);
  }
  const stored = await db.query("SELECT encode(document_data,'hex') AS data_hex FROM sports_soccer_striker_documents_v1");
  assert.equal(stored.rows.some(row => Buffer.from(row.data_hex, 'hex').toString('utf8').includes(KEY)), false);
  console.log('soccer Striker source archive: PASS (PGlite and fake fetch only; no upstream requests)');
} finally {
  globalThis.fetch = oldFetch;
  for (const key of envKeys) { if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]; }
  await fixture.close();
}
