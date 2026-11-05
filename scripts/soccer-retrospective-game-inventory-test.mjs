import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';

const fixture=await soccerSqlFixture(),{db}=fixture;
const before={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/retro-games'; delete process.env.DATABASE_V2_URL;
try {
  const {ensureSoccerJournal}=await import('../lib/soccer/journal.js');
  const {SOCCER_FORWARD_SCHEMA}=await import('../lib/soccer/forward-validation-service.js');
  const {SOCCER_FORWARD_VERSION,SOCCER_FORWARD_POLICY,soccerForwardHash}=await import('../lib/soccer/forward-validation.js');
  const {listSoccerRetrospectiveGames:list}=await import('../lib/soccer/retrospective-game-inventory.js');
  await ensureSoccerJournal();for(const sql of SOCCER_FORWARD_SCHEMA)await db.query(sql);
  await db.query(`INSERT INTO sports_soccer_forward_protocol_v1(protocol_version,policy_hash,policy) VALUES ($1,$2,$3)`,
    [SOCCER_FORWARD_VERSION,soccerForwardHash(SOCCER_FORWARD_POLICY),JSON.stringify(SOCCER_FORWARD_POLICY)]);
  // Original payload is never returned; IDs are listed as raw receipt scopes,
  // not as verified forecasts or official schedule identities.
  const add=async({league='epl',day='2026-11-04',id='100',period='REGULATION_FT',extra='',time='2026-11-01T00:00:00Z'})=>{
    const game=`soccer:${league}:${id}`,hash=`revision-${league}-${day}-${id}-${extra}`;
    await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES($1,$2,$3,'2026-11-01T00:00:00Z',$4)`,
      [league,game,hash,JSON.stringify({privateToken:'payload-must-not-be-returned'})]);
    await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
      VALUES($1,$2,$3,$4,$5,$6,'BASELINE','hash',$7,$8)`,[`capture-${league}-${day}-${id}-${extra}`,SOCCER_FORWARD_VERSION,league,game,day,period,hash,time]);
  };
  await add({league:'ucl',id:'101'});await add({league:'ucl',id:'101',period:'REGULATION_HT',extra:'ht'});
  await add({league:'ucl',id:'102'});await add({league:'epl',id:'103'});
  await add({league:'ucl',day:'2026-11-03',id:'104'});
  let calls=0;const original=globalThis.__SOCCER_TEST_SQL;
  globalThis.__SOCCER_TEST_SQL=async(queries,tx)=>{calls+=queries.length;assert.equal(tx,false);
    assert.ok(queries.every(row=>!/(?:\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bCREATE\b|\bALTER\b|\bDROP\b)/i.test(row.query)),
      'listing issues no mutating SQL');return original(queries,tx);};
  const report=await list('ucl','2026-11-04');globalThis.__SOCCER_TEST_SQL=original;
  assert.equal(calls,1,'inventory is one SQL statement and never writes');
  assert.equal(report.status,'INVENTORY_AVAILABLE');assert.deepEqual(report.games,[{gameId:'soccer:ucl:101',captureCount:2},{gameId:'soccer:ucl:102',captureCount:1}]);
  assert.equal(report.overallDateCoverage,'PARTIAL');assert.equal(report.crossRequestConsistency,'NOT_VERIFIED');
  assert.equal(report.forecastValidity,'NOT_VERIFIED');assert.equal(report.formalEligible,false);
  assert.ok(!JSON.stringify(report).includes('payload-must-not-be-returned'));
  assert.match(report.observedAt,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);
  assert.deepEqual((await list('epl','2026-11-04')).games,[{gameId:'soccer:epl:103',captureCount:1}]);
  assert.deepEqual((await list('ucl','2026-11-03')).games,[{gameId:'soccer:ucl:104',captureCount:1}]);
  for(const [league,date] of [['UCL','2026-11-04'],['nba','2026-11-04'],['ucl','2026-02-30'],['ucl',null]])
    await assert.rejects(()=>list(league,date),/SCOPE_INVALID/);
  // Single-query group limit rejects the 101st ID and states only that this
  // is a partial observed prefix; it does not claim a complete day.
  for(let n=1;n<=101;n++)await add({league:'epl',day:'2026-11-02',id:String(n)});
  const truncated=await list('epl','2026-11-02');assert.equal(truncated.status,'PARTIAL');assert.equal(truncated.games.length,100);
  assert.ok(truncated.reasonCodes.includes('GAME_INVENTORY_ROW_BUDGET'));
  // Any invalid identifier and any future DB timestamp must be disclosed,
  // never emitted as a validated game or silently counted.
  await add({league:'ucl',id:'not-numeric',extra:'invalid'});
  await add({league:'ucl',id:'105',extra:'future',time:'2999-01-01T00:00:00Z'});
  await add({league:'ucl',id:'106',extra:'negative-infinite',time:'-infinity'});
  await add({league:'ucl',id:'107',extra:'positive-infinite',time:'infinity'});
  const malformed=await list('ucl','2026-11-04');assert.equal(malformed.status,'PARTIAL');
  assert.ok(malformed.reasonCodes.includes('INVALID_FORECAST_GAME_IDENTITY'));
  assert.ok(malformed.reasonCodes.includes('FUTURE_FORECAST_RECEIPT'));
  assert.ok(malformed.reasonCodes.includes('INVALID_FORECAST_RECEIPT_TIME'));
  assert.deepEqual(malformed.games,[{gameId:'soccer:ucl:101',captureCount:2},{gameId:'soccer:ucl:102',captureCount:1}]);
  assert.ok(!JSON.stringify(malformed).includes('not-numeric'));
  console.log('PASS read-only soccer game inventory: one SQL snapshot, exact scope, 100-game bound, invalid identities, future receipts, privacy and no full-day claim');
} finally {for(const [key,value] of Object.entries(before)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fixture.close();}
