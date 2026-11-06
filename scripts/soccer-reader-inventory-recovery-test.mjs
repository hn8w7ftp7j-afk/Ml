import assert from 'node:assert/strict';
import { register } from 'node:module';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
register('./next-route-test-loader.mjs', import.meta.url);
const fixture = await soccerSqlFixture();
process.env.DATABASE_URL = 'postgres://fixture.invalid/recovery';
process.env.APP_PASSWORD = 'fixture-only';
process.env.SESSION_SECRET = 'fixture-secret-only';
try {
  const { ensureSoccerJournal } = await import('../lib/soccer/journal.js');
  const { SOCCER_READER_INVENTORY_SCAN_SCHEMA: schema } = await import('../lib/soccer/reader-inventory-scan.js');
  const { readerInventoryPublicId, listReaderInventoryScans, resumeReaderInventoryScan } = await import('../lib/soccer/reader-inventory-recovery.js');
  const { createSessionToken } = await import('../lib/security.js');
  const { POST } = await import('../app/api/soccer/reader-inventory-scan/route.js');
  await ensureSoccerJournal();
  for (const sql of schema) await fixture.db.query(sql);
  await fixture.db.query(`INSERT INTO sports_soccer_reader_observations_v2
    (observation_id,league,board_date,content_hash,source_observed_at,received_at,persisted_at,payload)
    VALUES ('fixture-receipt','UCL','2026-10-21','fixture-invalid-hash','2026-10-20T00:00:00Z',
    '2026-10-20T00:00:01Z','2026-10-20T00:00:02Z',$1::jsonb)`,
    [JSON.stringify({ observedAt:'2026-10-20T00:00:00Z', deviceId:'fixture-private-device', privatePayload:'private-market' })]);
  let cookie = `mlb_session=${await createSessionToken()}`;
  async function post(body, { authenticated = true, origin = 'http://localhost' } = {}) {
    const headers = { 'content-type':'application/json', origin, 'x-forwarded-for':'fixture-recovery' };
    if (authenticated) headers.cookie = cookie;
    const response = await POST(new Request('http://localhost/api/soccer/reader-inventory-scan', { method:'POST', headers, body:JSON.stringify(body) }));
    return [response.status, await response.json()];
  }
  const scope = { league:'ucl', date:'2026-10-21' }, cursor = 'a1'.repeat(24);
  const [startStatus, started] = await post({ action:'start', ...scope, cursor });
  assert.equal(startStatus, 200); assert.equal(started.report.status, 'RUNNING'); assert.equal(started.report.totalCount, 1);
  // Simulate loss of browser state: only scope is retained for recovery.
  const [listStatus, list] = await post({ action:'list', ...scope });
  assert.equal(listStatus, 200); assert.equal(list.complete, true); assert.equal(list.reports.length, 1);
  const scanId = list.reports[0].scanId;
  assert.match(scanId, /^[a-f0-9]{64}$/); assert.notEqual(scanId, cursor);
  for (const secret of [cursor, 'fixture-private-device', 'private-market']) assert(!JSON.stringify(list).includes(secret));
  const [resumeStatus, resumed] = await post({ action:'resume', ...scope, scanId });
  assert.equal(resumeStatus, 200); assert.equal(resumed.report.scanId, scanId);
  assert.equal(resumed.report.status, 'PARTIAL'); // Invalid raw fixture is detected; never fabricated into usable evidence.
  for (const secret of [cursor, 'fixture-private-device', 'private-market']) assert(!JSON.stringify(resumed).includes(secret));
  const jobs = (await fixture.db.query('SELECT cursor,status FROM sports_soccer_reader_inventory_scans_v1')).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].cursor, cursor); assert.equal(jobs[0].status, 'PARTIAL');
  assert.equal((await post({ action:'resume', league:'epl', date:scope.date, scanId }))[0], 404);
  assert.equal((await post({ action:'resume', league:'ucl', date:'2026-10-22', scanId }))[0], 404);
  assert.equal((await post({ action:'list', ...scope }, { authenticated:false }))[0], 401);
  assert.equal((await post({ action:'resume', ...scope, scanId }, { origin:'https://other.invalid' }))[0], 403);
  const tooMany = Array.from({ length:1001 }, (_, i) => ({ cursor:i.toString(16).padStart(48,'0'), league:'ucl', board_date:scope.date,
    version:'SOCCER-READER-INVENTORY-SCAN-v1', started_at:'2026-11-06T12:00:00.123456Z', status:'COMPLETE',
    expected_count:0, verified_count:0, observed_count:0, reason_codes:[] }));
  const queryOverflow = async sql => sql.includes('to_regclass') ? [{ present:true }] : tooMany;
  const truncated = await listReaderInventoryScans(scope, { query:queryOverflow });
  assert.equal(truncated.complete, false); assert.equal(truncated.entries.length, 1000);
  await assert.rejects(resumeReaderInventoryScan({ ...scope, scanId:'f'.repeat(64) }, { query:queryOverflow }));
  delete process.env.SESSION_SECRET;
  assert.throws(() => readerInventoryPublicId(cursor)); // No default secret, output or recovery bypass.
  assert.equal((await post({ action:'list', ...scope }))[0], 503);
  process.env.SESSION_SECRET = '   ';
  assert.throws(() => readerInventoryPublicId(cursor));
  assert.equal((await post({ action:'list', ...scope }))[0], 503);
  process.env.SESSION_SECRET = 'rotated-fixture-secret';
  assert.notEqual(readerInventoryPublicId(cursor), scanId);
  cookie = `mlb_session=${await createSessionToken()}`;
  assert.equal((await post({ action:'resume', ...scope, scanId }))[0], 404);
  const [rotatedListStatus, rotatedList] = await post({ action:'list', ...scope });
  assert.equal(rotatedListStatus, 200); assert.equal(rotatedList.reports.length, 1);
  const rotatedId = rotatedList.reports[0].scanId;
  assert.notEqual(rotatedId, scanId);
  const [rotatedResumeStatus, rotatedResume] = await post({ action:'resume', ...scope, scanId:rotatedId });
  assert.equal(rotatedResumeStatus, 200); assert.equal(rotatedResume.report.status, 'PARTIAL');
  assert.equal((await fixture.db.query('SELECT count(*)::integer AS n FROM sports_soccer_reader_inventory_scans_v1')).rows[0].n, 1);
  for (const secret of [cursor, 'fixture-secret-only', 'rotated-fixture-secret', 'fixture-private-device', 'private-market'])
    assert(!JSON.stringify([rotatedList, rotatedResume]).includes(secret));
  console.log('soccer reader inventory recovery PostgreSQL fixture tests passed');
} finally { await fixture.close(); }
