import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerReturnErrorPlannedProtocol } from '../lib/soccer/return-error-plans.js';
import { SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL } from '../lib/soccer/return-error-model.js';
import { soccerForwardHash } from '../lib/soccer/forward-validation.js';

const fixture = await soccerSqlFixture(), { db } = fixture;
const before = { DATABASE_URL: process.env.DATABASE_URL, DATABASE_V2_URL: process.env.DATABASE_V2_URL };
process.env.DATABASE_URL = 'postgres://fixture.invalid/return-error-bootstrap'; delete process.env.DATABASE_V2_URL;
const originalTransport = globalThis.__SOCCER_TEST_SQL;
// Fixed future-calendar tests use a test-only PostgreSQL clock function. The
// shipped code still obtains every timestamp/registration from PostgreSQL;
// no receipt timestamp is passed to it. This keeps the test valid after 2026.
await db.exec(`CREATE FUNCTION soccer_bootstrap_test_clock() RETURNS timestamptz
  LANGUAGE SQL VOLATILE AS $$ SELECT current_setting('soccer.bootstrap_test_clock')::timestamptz $$`);
const setClock = async value => db.query("SELECT set_config('soccer.bootstrap_test_clock',$1,false)", [value]);
await setClock('2026-11-08T09:00:00.123456Z');
globalThis.__SOCCER_TEST_SQL = (queries, transaction) => originalTransport(queries.map(value => ({ ...value,
  query: value.query.replaceAll('clock_timestamp()', 'soccer_bootstrap_test_clock()') })), transaction);
const { bootstrapSoccerReturnErrorProtocol: bootstrap } = await import('../lib/soccer/return-error-bootstrap.js');
const store = await import('../lib/soccer/return-error-validation-store.js');
const count = async league => (await db.query('SELECT count(*)::int AS n FROM sports_soccer_return_error_protocols_v1 WHERE league=$1', [league])).rows[0].n;
try {
  const epl = soccerReturnErrorPlannedProtocol('epl'), ucl = soccerReturnErrorPlannedProtocol('ucl');
  assert.equal(epl.plan.trainingBefore, '2026-11-25T00:00:00.000Z');
  assert.equal(epl.plan.calibrationBefore, '2026-12-08T00:00:00.000Z');
  assert.equal(epl.plan.testBefore, '2026-12-23T00:00:00.000Z');
  assert.equal(ucl.plan.trainingBefore, '2026-11-30T00:00:00.000Z');
  assert.equal(ucl.plan.calibrationBefore, '2027-01-23T00:00:00.000Z');
  assert.equal(ucl.plan.testBefore, '2027-01-30T00:00:00.000Z');
  assert.equal(epl.protocolTemplateHash, soccerForwardHash(SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL));
  const changed = soccerReturnErrorPlannedProtocol('epl'); changed.plan.trainingBefore = '2000-01-01T00:00:00Z';
  assert.deepEqual(soccerReturnErrorPlannedProtocol('epl'), epl, 'caller mutation cannot change the server calendar');
  assert.throws(() => soccerReturnErrorPlannedProtocol('nba'), /LEAGUE_INVALID/);
  let touched = false;
  for (const scope of [{league:'nba'}, {league:'EPL'}, {league:'epl',timeBudgetMs:0}, {league:'epl',timeBudgetMs:5001}])
    await assert.rejects(() => bootstrap(scope, { listProtocols: async () => { touched = true; } }), /SCOPE_INVALID/);
  assert.equal(touched, false, 'invalid scopes cannot initialize the database');

  const initial = await Promise.all(Array.from({length:3}, () => bootstrap({league:'epl',timeBudgetMs:5000})));
  const first = initial[0];
  assert.equal(first.status, 'REGISTERED_RESEARCH_ONLY', JSON.stringify(first));
  assert.equal(first.configured, true); assert.equal(first.persisted, true);
  assert.equal(first.registeredAt, '2026-11-08T09:00:00.123Z');
  assert.ok(initial.every(value => value.configured && value.protocolId === first.protocolId && value.registeredAt === first.registeredAt),
    'concurrent first registration has one actual immutable PostgreSQL receipt');
  assert.equal(await count('epl'), 1); assert.equal(await count('ucl'), 0);
  assert.ok(Date.parse(first.registeredAt) < Date.parse(epl.plan.trainingBefore));
  await setClock('2026-11-09T09:00:00.999999Z');
  const repeated = await Promise.all(Array.from({length:3}, () => bootstrap({league:'epl',timeBudgetMs:5000})));
  assert.ok(repeated.every(value => value.status === 'ALREADY_REGISTERED_RESEARCH_ONLY'));
  assert.ok(repeated.every(value => value.protocolId === first.protocolId && value.registeredAt === first.registeredAt));
  assert.equal(await count('epl'), 1);

  // Advance the actual test PostgreSQL clock across both training boundaries.
  // EPL's genuine earlier receipt survives; missing UCL cannot be backfilled.
  await setClock('2026-11-30T00:00:00.000000Z');
  const afterTraining = await bootstrap({league:'epl',timeBudgetMs:5000});
  assert.equal(afterTraining.status, 'ALREADY_REGISTERED_RESEARCH_ONLY');
  assert.equal(afterTraining.protocolId, first.protocolId); assert.equal(afterTraining.registeredAt, first.registeredAt);
  let registeredLate = false;
  const late = await bootstrap({league:'ucl',timeBudgetMs:5000}, {register: async () => { registeredLate = true; }});
  assert.equal(late.status, 'REGISTRATION_CLOSED'); assert.equal(late.configured, false);
  assert.equal(registeredLate, false); assert.equal(await count('ucl'), 0);

  // Independent fixture scenario: a previously registered different UCL plan
  // cannot be replaced, ignored, or followed by an automatic second plan.
  await setClock('2026-11-10T00:00:00.000000Z');
  const other = await store.registerSoccerReturnErrorProtocol({...ucl.plan, trainingBefore:'2026-12-01T00:00:00.000Z'});
  const conflict = await bootstrap({league:'ucl',timeBudgetMs:5000});
  assert.equal(conflict.status, 'PROTOCOL_CONFLICT'); assert.equal(conflict.configured, false); assert.equal(conflict.persisted, false);
  assert.equal(await count('ucl'), 1);
  assert.equal((await store.loadSoccerReturnErrorProtocol(other.protocolId)).registeredAt, other.registeredAt);
  assert.equal((await bootstrap({league:'epl',timeBudgetMs:5000})).protocolId, first.protocolId, 'UCL conflict cannot contaminate EPL');

  const unknown = await bootstrap({league:'epl',timeBudgetMs:5000}, {
    listProtocols: async () => ({protocols:[],completeWithinRequestedScope:false}),
  });
  assert.equal(unknown.status,'NOT_VERIFIED'); assert.equal(unknown.configured,false);
  const unavailable = await bootstrap({league:'epl',timeBudgetMs:5000}, {
    databaseNow: async () => { throw Error('postgres://private:secret@database.invalid'); },
  });
  assert.equal(unavailable.status,'NOT_VERIFIED'); assert.equal(unavailable.reason,'RETURN_ERROR_BOOTSTRAP_STORAGE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(unavailable), /private|secret|database\.invalid|postgres/);
  const timeout = await bootstrap({league:'epl',timeBudgetMs:1}, {listProtocols: () => new Promise(() => {})});
  assert.equal(timeout.status,'NOT_VERIFIED'); assert.equal(timeout.reason,'RETURN_ERROR_BOOTSTRAP_TIMEOUT');
  let afterExpiredWrite = false, wallTime = 0;
  const expiredWrite = await bootstrap({league:'epl',timeBudgetMs:10}, {
    wallNow: () => wallTime,
    listProtocols: async () => { if (wallTime) afterExpiredWrite = true; return {protocols:[],completeWithinRequestedScope:true}; },
    register: async () => { wallTime = 11; return {}; },
  });
  assert.equal(expiredWrite.reason, 'RETURN_ERROR_BOOTSTRAP_TIMEOUT');
  assert.equal(afterExpiredWrite, false, 'a timed-out registration cannot dispatch new readback queries');
  for (const result of [...initial,...repeated,afterTraining,late,conflict,unknown,unavailable,timeout,expiredWrite]) {
    assert.equal(result.accepted,false); assert.equal(result.formalEligible,false); assert.equal(result.promotionEligible,false);
    assert.equal(result.executable,false); assert.equal(result.W,null); assert.equal(result.R,null); assert.equal(result.S,null);
  }
  await assert.rejects(() => db.query('UPDATE sports_soccer_return_error_protocols_v1 SET registered_at=registered_at-interval \'1 day\''), /immutable/i);
  console.log('PASS fixed future return-error bootstrap: PostgreSQL-owned prospective receipts, immutable calendar/template identity, idempotent concurrent readback, post-training continuation, late missing-row refusal, conflict/league isolation, partial-source/timeout/secret-safe failures and no formal promotion');
} finally {
  globalThis.__SOCCER_TEST_SQL = originalTransport;
  for (const key of Object.keys(before)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
  await fixture.close();
}
