// Real PostgreSQL-engine tests, paired-device/site authentication and exact raw
// evidence readback. Synthetic sport fixtures are NOT Production capture proof.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { NextResponse } from 'next/server.js';
import * as auth from '../lib/reader-auth-v2.js';
import * as security from '../lib/security.js';
import { READER_SEEN_CAPTURE_SCHEMA as SCHEMA, READER_SEEN_CAPTURE_LEAGUES as LEAGUES,
  buildReaderSeenCapture, canonicalReaderSeenCapture, initializeReaderSeenCaptureStore, saveReaderSeenCapture, listReaderSeenCaptures, parseReaderSeenCaptureQuery } from '../lib/reader-seen-capture.js';

const db = new PGlite(), statements = [];
const sql = (parts, ...values) => {
  const query = parts.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
  statements.push(query);
  return { query, values, then: (resolve, reject) => db.query(query, values).then(result => result.rows).then(resolve, reject) };
};
sql.transaction = queries => db.transaction(async transaction => {
  const rows = []; for (const query of queries) rows.push((await transaction.query(query.query, query.values)).rows); return rows;
});
const deviceId = 'seen-capture-fixture-device', version = '2.1.50';
const observedAt = '2026-10-24T22:00:01.000Z', pageActivityAt = '2026-10-24T22:00:00.000Z';
const clock = Date.parse('2026-10-29T22:00:00.000Z');
const settings = { deviceId, headerVersion: version, now: clock, sql };
const clone = value => structuredClone(value), hash = value => createHash('sha256').update(value).digest('hex');
const cell = pair => ({ pair });
function fixture(league = 'NBA') {
  const evidence = { version: 'TAI888-DOM-CAPTURE-v2.2.0', league, readerVersion: version,
    sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/#/BS', frameUrl: 'https://www1.tai888.in/newapp/',
    observedAt, pageActivityAt, pageLeagueLabel: `${league} 聯盟`, captureReasons: ['PRE_NORMALIZATION', 'SOURCE_PARTIAL'], completeCapture: false,
    tables: [{ sectionTitle: `${league} 全場`, headers: ['時間', '主客隊伍', '讓球', '大小盤'],
      rows: [
        { marketLocked: false, cells: [cell(['not-a-date', '07:00']), cell(['不在隊名表的新隊名', 'LAL 洛杉磯湖人[主]']),
          cell([' 3+50  0.95\n1.5 ', '1.5 0.93']), cell(['大224+50 0.94', '小224-50 0.96'])] },
        { marketLocked: false, cells: [cell(['not-a-date', '07:00']), cell(['不在隊名表的新隊名', 'LAL 洛杉磯湖人[主]']), cell(['3+75 0.91', '1.5 0.97'])] },
        { marketLocked: true, cells: [cell(['10/25', '08:00']), cell(['GS 金州勇士', 'NY 紐約尼克[主]']), cell(['鎖盤', ''])] },
      ] }], diagnostics: { recordCount: 3, headerCount: 1, expectedGameCount: null, sawLeagueMarker: true,
      lastMutationAt: pageActivityAt, tableIssues: ['CONFLICTING_ROWS'], conflictingGameKeys: ['07:00|GS|LAL'] } };
  const evidenceHash = hash(canonicalReaderSeenCapture(evidence));
  const captureId = hash(canonicalReaderSeenCapture({ schema: SCHEMA, evidence }));
  return { schema: SCHEMA, evidence, captureId, evidenceHash };
}
const wrap = evidence => ({ schema: SCHEMA, evidence });
const build = input => buildReaderSeenCapture(input, settings);
const save = (input, extra = {}) => saveReaderSeenCapture(input, { ...settings, ...extra });
const count = async () => (await db.query('SELECT count(*)::int AS n FROM sports_reader_seen_captures_v1')).rows[0].n;
const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().reverse().map(key => [key, reordered(value[key])])) : value;
const envNames = ['READER_PAIR_SECRET', 'APP_PASSWORD', 'SESSION_SECRET'];
const before = Object.fromEntries(envNames.map(key => [key, process.env[key]]));
Object.assign(process.env, { READER_PAIR_SECRET: 'seen-fixture-reader-pair', APP_PASSWORD: 'seen-fixture-site-password', SESSION_SECRET: 'seen-fixture-site-session' });

try {
  const preRead = statements.length;
  await assert.rejects(() => listReaderSeenCaptures({}, { sql }), cause => cause.code === 'READER_SEEN_CAPTURE_TABLE_NOT_READY' && cause.status === 503);
  assert.ok(statements.slice(preRead).every(query => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(query)), 'GET on a missing table never creates schema or fabricates zeros');
  await Promise.all([initializeReaderSeenCaptureStore({sql}),initializeReaderSeenCaptureStore({sql})]);
  const activated=await listReaderSeenCaptures({}, {sql});
  assert.equal(activated.coverageComplete,false);
  assert.equal(activated.leagues.length,8);
  assert.ok(activated.leagues.every(row=>row.captureCount===0&&row.lastObservedAt===null));
  assert.equal(await count(),0,'schema activation never invents observations');
  assert.equal(statements.slice(preRead).filter(query=>/CREATE TABLE IF NOT EXISTS/.test(query)).length,1,'concurrent activation is coalesced');
  const source = fixture(), expected = build(source);
  assert.equal(expected.captureId, source.captureId); assert.equal(expected.evidenceHash, source.evidenceHash);
  assert.deepEqual(expected.evidence, source.evidence, 'sport evidence is exact, including whitespace, unresolved identity, malformed date and conflicting rows');
  assert.equal(expected.rowCount, 3); assert.equal(expected.lockedRowCount, 1);
  assert.equal(build(reordered(source)).captureId, source.captureId, 'Chrome dictionary key reordering cannot change archive identity');
  assert.equal(build(reordered(source)).evidenceHash, source.evidenceHash);
  for (const league of LEAGUES) {
    const input = fixture(league), receipt = await save(input);
    assert.equal(receipt.league, league); assert.equal(receipt.captureId, input.captureId);
    assert.equal(receipt.evidenceHash, input.evidenceHash); assert.equal(receipt.durable, true);
    assert.equal(receipt.evidenceStatus, 'EVIDENCE_UNVERIFIED'); assert.equal(receipt.status, 'EVIDENCE_UNVERIFIED');
    assert.equal(receipt.archiveOnly, true); assert.equal(receipt.currentBoardUpdated, false);
    assert.equal(receipt.historicalAvailabilityVerified, false); assert.equal(receipt.executable, false); assert.equal(receipt.coverageComplete, false);
    assert.equal(receipt.observedAt, observedAt); assert.equal(receipt.pageActivityAt, pageActivityAt);
    assert.equal(receipt.receivedAt, new Date(clock).toISOString(), 'delayed receipt never freshens original source time');
  }
  assert.equal(await count(), 8, 'all eight league archives remain isolated');
  const first = await save(source), retried = await save(reordered(source), { now: clock + 60_000 });
  assert.equal(first.receivedAt, retried.receivedAt); assert.equal(first.persistedAt, retried.persistedAt);
  assert.equal(await count(), 8, 'exact capture retries are idempotent');
  const stored = (await db.query('SELECT evidence_json FROM sports_reader_seen_captures_v1 WHERE capture_id=$1', [source.captureId])).rows[0].evidence_json;
  assert.equal(stored, canonicalReaderSeenCapture(source.evidence));
  assert.equal(stored.includes('3+75 0.91'), true, 'conflicting alternatives are retained rather than selected away');
  const future = fixture(); future.evidence.observedAt = '2036-10-24T22:00:01.000Z'; delete future.captureId; delete future.evidenceHash;
  assert.equal((await save(future)).evidenceStatus, 'EVIDENCE_UNVERIFIED', 'client clock skew is raw evidence, never a valid live price');
  const noTables = fixture(); noTables.evidence.tables = []; delete noTables.captureId; delete noTables.evidenceHash;
  const noTableSaved = await save(noTables);
  assert.equal(noTableSaved.tableCount, 0); assert.equal(noTableSaved.rowCount, 0); assert.equal(noTableSaved.completeCapture, false);
  const detail = await listReaderSeenCaptures({ captureId: source.captureId }, { sql });
  assert.deepEqual(detail.capture.evidence, source.evidence); assert.equal(detail.currentBoardUpdated, false);
  assert.equal(Object.hasOwn(detail, 'deviceId'), false);
  const beforeInventory = statements.length, inventory = await listReaderSeenCaptures({}, { sql });
  assert.equal(inventory.leagues.length, 8); assert.equal(inventory.countUnit, 'RAW_CAPTURE_OBSERVATIONS');
  assert.equal(inventory.leagues.find(row => row.league === 'NBA').captureCount, 3);
  assert.ok(inventory.recent.every(row => row.status === 'EVIDENCE_UNVERIFIED' && !Object.hasOwn(row, 'evidence')));
  assert.ok(statements.slice(beforeInventory).every(query => !/\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i.test(query)), 'inventory stays read-only');
  const cpbl = await listReaderSeenCaptures({ league: 'CPBL', limit: 1 }, { sql });
  assert.equal(cpbl.leagues.length, 1); assert.equal(cpbl.recent.length, 1); assert.equal(cpbl.recent[0].league, 'CPBL');

  const batchId = 'b'.repeat(64);
  const part = (index, total = 2, changed = false) => { const input = fixture('EPL');
    Object.assign(input.evidence, { captureBatchId: batchId, partIndex: index, partCount: total });
    input.evidence.tables = input.evidence.tables.map(table => ({ ...table, rows: [table.rows[index % 3]] }));
    if (changed) input.evidence.tables[0].rows[0].cells.push(cell(['大3+80 0.93', '小3+80 0.97']));
    return wrap(input.evidence); };
  await save(part(0));
  let batch = (await listReaderSeenCaptures({ league: 'EPL' }, { sql })).leagues[0];
  assert.equal(batch.receivedPartGroups, 1); assert.equal(batch.pendingPartGroups, 1); assert.equal(batch.completePartGroups, 0);
  await save(part(1));
  batch = (await listReaderSeenCaptures({ league: 'EPL' }, { sql })).leagues[0];
  assert.equal(batch.pendingPartGroups, 0); assert.equal(batch.completePartGroups, 1);
  await save(part(1));
  assert.equal((await listReaderSeenCaptures({ league: 'EPL' }, { sql })).leagues[0].completePartGroups, 1, 'duplicate exact chunks do not inflate group count');
  await save(part(1, 2, true));
  batch = (await listReaderSeenCaptures({ league: 'EPL' }, { sql })).leagues[0];
  assert.equal(batch.completePartGroups, 0); assert.equal(batch.conflictingPartGroups, 1, 'two different payloads for one part cannot report complete');
  const differentLeaguePart = part(0); differentLeaguePart.evidence.league = 'UCL'; await save(differentLeaguePart);
  assert.equal((await listReaderSeenCaptures({ league: 'UCL' }, { sql })).leagues[0].pendingPartGroups, 1, 'batch scope cannot cross leagues');
  const mixedScope = part(1); mixedScope.evidence.league = 'UCL'; mixedScope.evidence.observedAt = '2026-10-24T22:01:01.000Z';
  await save(mixedScope);
  assert.equal((await listReaderSeenCaptures({ league: 'UCL' }, { sql })).leagues[0].conflictingPartGroups, 1, 'different source scopes cannot be presented as one complete chunk group');

  const invalids = [
    input => { input.evidence.league = 'UNKNOWN'; },
    input => { input.evidence.account = 'private'; },
    input => { input.evidence.tables[0].rows[0].rawDOM = 'private'; },
    input => { input.evidence.tables[0].rows[0].cells[0].pair[0] = '帳號: 1234'; },
    input => { input.evidence.tables[0].headers[0] = 'session=private'; },
    input => { input.evidence.tables[0].sectionTitle = '<div>NBA</div>'; },
    input => { input.evidence.pageUrl += '?token=private'; },
    input => { input.evidence.pageUrl = 'https://user:private@www1.tai888.in/newapp/'; },
    input => { input.evidence.pageUrl = 'https://www1.tai888.in/newapp/%61%63%63%6f%75%6e%74/%74%6f%6b%65%6e%3dabc123'; },
    input => { input.evidence.pageUrl = 'https://www1.tai888.in/newapp/%2561%2563%2563%256f%2575%256e%2574'; },
    input => { input.evidence.tables[0].rows[0].cells[0].pair[0] = '帳\u200b號 Kai'; },
    input => { input.evidence.tables[0].rows[0].cells[0].pair[0] = 'ａｃｃｏｕｎｔ Kai'; },
    input => { input.evidence.tables[0].rows[0].cells[0].pair[0] = 'username abc123'; },
    input => { input.evidence.sourceHost = 'tai888.in.evil.test'; },
    input => { input.evidence.partIndex = 2; input.evidence.partCount = 2; input.evidence.captureBatchId = batchId; },
    input => { input.evidence.captureReasons = ['ARBITRARY_REASON']; },
    input => { input.evidence.observedAt = '2026-02-30T00:00:00.000Z'; },
  ];
  const beforeRejected = await count();
  for (const mutate of invalids) { const input = fixture(); mutate(input); assert.throws(() => build(input), cause => cause.code.startsWith('READER_SEEN_CAPTURE_')); }
  const badHash = fixture(); badHash.evidenceHash = '0'.repeat(64); assert.throws(() => build(badHash), /HASH_MISMATCH/);
  const badId = fixture(); badId.captureId = '0'.repeat(64); assert.throws(() => build(badId), /ID_MISMATCH/);
  const oversized = fixture(); oversized.evidence.tables[0].rows = Array.from({ length: 16 }, () => ({ cells: [cell(['大 3+50 0.95 '.repeat(5000)])] }));
  assert.throws(() => build(oversized), cause => cause.status === 413, 'oversized source stays unacknowledged for explicit local quarantine/retry');
  const wide = fixture(); wide.evidence.tables[0].rows[0].cells[0].pair = Array.from({ length: 40 }, () => '大3+50 0.95');
  delete wide.captureId; delete wide.evidenceHash; assert.equal(build(wide).evidence.tables[0].rows[0].cells[0].pair.length, 40, 'large pairs are not silently capped at parser limits');
  assert.equal(await count(), beforeRejected, 'rejected private/oversized/invalid requests never create partial archives');
  await assert.rejects(() => db.query('UPDATE sports_reader_seen_captures_v1 SET row_count=0 WHERE capture_id=$1', [source.captureId]), /IMMUTABLE/);
  await assert.rejects(() => db.query('DELETE FROM sports_reader_seen_captures_v1 WHERE capture_id=$1', [source.captureId]), /IMMUTABLE/);
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public'")).rows.map(row => row.tablename);
  assert.deepEqual(tables, ['sports_reader_seen_captures_v1'], 'raw evidence creates no current-board, analysis or model storage');

  for (const params of [{ league: 'UNKNOWN' }, { limit: '101' }, { extra: 'x' }, { captureId: 'bad' }, { captureId: source.captureId, league: 'NBA' }])
    assert.throws(() => parseReaderSeenCaptureQuery(new URLSearchParams(params)), cause => cause.status === 400);
  assert.throws(() => parseReaderSeenCaptureQuery(new URLSearchParams('league=NBA&league=MLB')), cause => cause.status === 400);
  await assert.rejects(() => listReaderSeenCaptures({ captureId: '0'.repeat(64) }, { sql }), cause => cause.status === 404);
  await assert.rejects(() => saveReaderSeenCapture(source, { ...settings, sql: undefined, env: {} }), cause => cause.status === 503);
  const corruptTransport = async (parts, ...values) => {
    const result = await sql(parts, ...values);
    if (parts.join('?').includes('WHERE capture_id=')) return result.map(row => ({ ...row, evidence_hash: '0'.repeat(64) }));
    return result;
  };
  await assert.rejects(() => listReaderSeenCaptures({ captureId: source.captureId }, { sql: corruptTransport }), /READBACK_FAILED/, 'corrupt readback cannot return a successful saved receipt');

  // Run real route logic, identity, body parsing and actual PostgreSQL transport.
  const token = await auth.createReaderToken({ deviceId }), session = await security.createSessionToken();
  let unavailable = false, limited = false, calls = 0;
  const deps = { NextResponse, ...auth, ...security, initializeReaderSeenCaptureStore: async () => {
    calls+=1;if(unavailable)throw Error('private database transport details');await initializeReaderSeenCaptureStore({sql});
  }, saveReaderSeenCapture: async (input, options) => {
    calls += 1; if (unavailable) throw Error('private database transport details'); return saveReaderSeenCapture(input, { ...options, sql });
  }, listReaderSeenCaptures: async query => { calls += 1; if (unavailable) throw Error('private database transport details'); return listReaderSeenCaptures(query, { sql }); },
  parseReaderSeenCaptureQuery, checkRateLimit: (...args) => limited ? { allowed: false } : security.checkRateLimit(...args), console: { warn() {} } };
  const routeSource = readFileSync(new URL('../app/api/reader/seen-captures/route.js', import.meta.url), 'utf8')
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '').replace(/^export\s+/gm, '');
  const route = new Function(...Object.keys(deps), `${routeSource}\nreturn {POST,GET,OPTIONS};`)(...Object.values(deps));
  let address = 0;
  const request = (method, body, headers = {}, query = '') => new Request(`https://fixture.invalid/api/reader/seen-captures${query}`, {
    method, headers: { Origin: `chrome-extension://${'a'.repeat(32)}`, Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json', 'x-device-id': deviceId, 'x-reader-version': version,
      cookie: `mlb_session=${session}`, 'x-forwarded-for': `192.0.2.${++address}`, ...headers },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
  const post = (body = source, headers = {}) => route.POST(request('POST', body, headers));
  assert.equal((await route.OPTIONS(request('OPTIONS'))).status, 204);
  assert.equal((await route.OPTIONS(request('OPTIONS', undefined, { Origin: 'https://evil.invalid' }))).status, 403);
  const beforeAuth = calls;
  for (const [headers, status] of [[{ Authorization: '' }, 401], [{ 'x-device-id': 'other-device' }, 401], [{ Origin: 'https://evil.invalid' }, 403]])
    assert.equal((await post(source, headers)).status, status);
  assert.equal(calls, beforeAuth, 'no storage before authenticated device/origin checks');
  assert.equal((await post(source, { 'x-reader-version': '2.1.40' })).status, 426);
  assert.equal((await post('{malformed')).status, 400);
  assert.equal((await post('x'.repeat(650_001))).status, 413);
  const routeSaved = await post(); assert.equal(routeSaved.status, 200, await routeSaved.clone().text());
  const routeReceipt = await routeSaved.json(); assert.equal(routeReceipt.captureId, source.captureId); assert.equal(routeReceipt.durable, true);
  assert.equal(routeSaved.headers.get('Cache-Control'), 'no-store');
  assert.equal(routeSaved.headers.get('Access-Control-Allow-Origin'), `chrome-extension://${'a'.repeat(32)}`);
  const beforeReadAuth=calls;
  assert.equal((await route.GET(request('GET', undefined, { cookie: '' }))).status, 401, 'Reader bearer token never authorizes archive reads');
  assert.equal(calls,beforeReadAuth,'unauthenticated reads never initialize storage');
  assert.equal((await route.GET(request('GET'))).status, 200);
  assert.equal((await route.GET(request('GET', undefined, {}, '?league=UNKNOWN'))).status, 400);
  limited = true; assert.equal((await post()).status, 429); assert.equal((await route.GET(request('GET'))).status, 429); limited = false;
  unavailable = true;
  for (const result of [await post(), await route.GET(request('GET'))]) {
    assert.equal(result.status, 503); const body = await result.json(); assert.equal(body.ok, false); assert.equal(body.durable, false);
    assert.equal(body.currentBoardUpdated, false); assert.equal(body.evidenceStatus, 'NOT_SAVED');
    assert.equal(Object.hasOwn(body, 'captureId'), false); assert.equal(Object.hasOwn(body, 'leagues'), false);
    assert.equal(JSON.stringify(body).includes('private database'), false);
  }
  console.log('PASS raw seen-capture PostgreSQL+route tests: exact unparsed/conflicting/locked evidence, stable Chrome-key canonicalization, eight-league isolation, immutable idempotent readback, truthful chunk groups, privacy/size quarantine, paired-write/site-read auth, no live/model writes; Production NOT VERIFIED');
} finally {
  for (const key of envNames) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  await db.close();
}
