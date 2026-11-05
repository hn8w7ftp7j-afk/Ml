import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture,changed,protocol,iso,captured,sha } from './helpers/soccer-forward-fixture.mjs';
const fixture=await soccerSqlFixture(),{db}=fixture;
const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/retrospective-game-forecasts';delete process.env.DATABASE_V2_URL;
try {
  const {ensureSoccerJournal,soccerForwardHash:unused}=await import('../lib/soccer/journal.js');
  const {soccerForwardHash}=await import('../lib/soccer/forward-validation.js');
  const {SOCCER_FORWARD_SCHEMA}=await import('../lib/soccer/forward-validation-service.js');
  const {loadSoccerRetrospectiveGameForecasts:load}=await import('../lib/soccer/retrospective-game-forecasts.js');
  await ensureSoccerJournal();for(const sql of SOCCER_FORWARD_SCHEMA)await db.query(sql);
  await db.query(`INSERT INTO sports_soccer_forward_protocol_v1(protocol_version,policy_hash,policy,activated_at) VALUES($1,$2,$3,$4)`,
    [protocol.version,soccerForwardHash(protocol.policy),JSON.stringify(protocol.policy),protocol.activatedAt]);
  const a=fixtureCapture(),b=changed(a,row=>{row.captureId=sha('second-original');row.captureSequence='2';row.snapshot.note='second independent saved original';});
  const other=fixtureCapture({id:'101'}), foreign=fixtureCapture({league:'ucl'});
  const add=async(c,when)=>{
    await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES($1,$2,$3,$4,$5)`,
      [c.league,c.gameId,c.revision,c.snapshot.observedAt,JSON.stringify(c.snapshot)]);
    await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[c.captureId,protocol.version,c.league,c.gameId,c.date,c.period,c.variant,c.modelHash,c.revision,when]);
  };
  await add(a,iso(captured).replace('Z','123Z'));await add(b,iso(captured).replace('Z','900Z'));
  await add(other,iso(captured));await add(foreign,iso(captured));
  let calls=0;const original=globalThis.__SOCCER_TEST_SQL;
  globalThis.__SOCCER_TEST_SQL=async(queries,tx)=>{calls+=queries.length;assert.equal(tx,false);
    assert.ok(queries.every(x=>/^\s*WITH\s/i.test(x.query)));return original(queries,tx);};
  const all=await load('epl',a.date,a.gameId);globalThis.__SOCCER_TEST_SQL=original;
  assert.equal(calls,1,'one SELECT statement supplies both originals and receipt metadata');
  assert.equal(all.status,'COMPLETE');assert.equal(all.captures.length,2);
  assert.deepEqual(all.captures.map(x=>x.captureId),[a.captureId,b.captureId]);
  assert.deepEqual(all.captures.map(x=>x.capturedAt),[iso(captured).replace('Z','123Z'),iso(captured).replace('Z','900Z')]);
  assert.equal(typeof all.captures[0].captureSequence,'string');assert.deepEqual(all.captures[0].snapshot,a.snapshot);
  assert.deepEqual(all.captures[1].snapshot,b.snapshot);
  assert.equal((await load('epl',a.date,other.gameId)).captures.length,1);
  assert.equal((await load('ucl',a.date,foreign.gameId)).captures.length,1);
  assert.equal((await load('epl','2026-10-20',a.gameId)).captures.length,0);
  for(const [league,date,gameId] of [['EPL',a.date,a.gameId],['ucl',a.date,a.gameId],['epl','2026-02-30',a.gameId],['epl',a.date,`${a.gameId}:extra`]])
    await assert.rejects(()=>load(league,date,gameId),/SCOPE_INVALID/);
  const rowPartial=await load('epl',a.date,a.gameId,{maxRows:1});
  assert.equal(rowPartial.status,'PARTIAL');assert.deepEqual(rowPartial.captures,[]);assert.ok(rowPartial.reasonCodes.includes('FORECAST_ROW_BUDGET'));
  assert.equal(rowPartial.countsDescribe,'BOUNDED_PREFIX_ONLY');
  assert.equal((await load('epl',a.date,a.gameId,{maxBytes:all.observedBytes})).status,'COMPLETE');
  const bytesPartial=await load('epl',a.date,a.gameId,{maxBytes:all.observedBytes-1});
  assert.equal(bytesPartial.status,'PARTIAL');assert.deepEqual(bytesPartial.captures,[]);assert.ok(bytesPartial.reasonCodes.includes('FORECAST_PAYLOAD_BYTE_BUDGET'));
  // Simulate an integrity failure that the production foreign key prevents:
  // drop only the fixture FK, then insert a saved receipt with no original.
  const constraints=(await db.query(`SELECT conname FROM pg_constraint WHERE conrelid='sports_soccer_forward_captures_v1'::regclass AND contype='f'`)).rows;
  const names=constraints.map(x=>x.conname);const target=names.find(x=>x.includes('league_game_id'));
  assert.ok(target,JSON.stringify(names));await db.query(`ALTER TABLE sports_soccer_forward_captures_v1 DROP CONSTRAINT "${target}"`);
  const missing=fixtureCapture({id:'102'});
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[missing.captureId,protocol.version,missing.league,missing.gameId,missing.date,missing.period,missing.variant,missing.modelHash,missing.revision,iso(captured)]);
  const unavailable=await load('epl',missing.date,missing.gameId);
  assert.equal(unavailable.status,'PARTIAL');assert.deepEqual(unavailable.captures,[]);assert.deepEqual(unavailable.reasonCodes,['FORECAST_ORIGINAL_ANALYSIS_MISSING']);
  // Broken payload must fail closed even when both DB foreign key and row exist.
  const corrupt=fixtureCapture({id:'103'}),bad=structuredClone(corrupt.snapshot);bad.note='wrong immutable content';
  await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES($1,$2,$3,$4,$5)`,
    [corrupt.league,corrupt.gameId,corrupt.revision,bad.observedAt,JSON.stringify(bad)]);
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[corrupt.captureId,protocol.version,corrupt.league,corrupt.gameId,corrupt.date,corrupt.period,corrupt.variant,corrupt.modelHash,corrupt.revision,iso(captured)]);
  const corrupted=await load('epl',corrupt.date,corrupt.gameId);
  assert.equal(corrupted.status,'PARTIAL');assert.deepEqual(corrupted.captures,[]);assert.deepEqual(corrupted.reasonCodes,['FORECAST_ORIGINAL_ANALYSIS_CORRUPTED']);
  // A row-overflow read must not fetch or serialize even a single original.
  // The deliberately throwing view proves whether payload was evaluated.
  await db.query(`CREATE FUNCTION fixture_forbid_payload(jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'FIXTURE_PAYLOAD_READ'; END $$`);
  await db.query(`ALTER TABLE sports_soccer_analysis_v1 RENAME TO fixture_real_soccer_analysis_v1`);
  await db.query(`CREATE VIEW sports_soccer_analysis_v1 AS SELECT league,game_id,analysis_hash,observed_at,fixture_forbid_payload(payload) AS payload FROM fixture_real_soccer_analysis_v1`);
  const noPayload=await load('epl',a.date,a.gameId,{maxRows:1});
  assert.equal(noPayload.status,'PARTIAL');assert.ok(noPayload.reasonCodes.includes('FORECAST_ROW_BUDGET'));
  assert.equal(noPayload.byteCountScope,'METADATA_ONLY_ROW_OVERFLOW');
  await assert.rejects(()=>load('epl',a.date,a.gameId,{maxRows:2}),/FIXTURE_PAYLOAD_READ/);
  console.log('PASS single-game forecast read: one MVCC statement, exact scope, full immutable snapshots, microseconds, row/byte boundaries, missing/corrupt originals fail closed');
} finally {for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fixture.close();}
