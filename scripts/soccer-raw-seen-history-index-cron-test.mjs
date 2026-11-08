import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { register } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

// Real retained source evidence and real PostgreSQL semantics. All source,
// failure, and index writes in this test stay inside this isolated engine.
const parts=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/soccer/ucl-seen-pregame-20261105.json.gz',import.meta.url))));
const db=new PGlite(),statements=[],executions=[];let failingCapture=null,failInitialize=false,afterQuery=null;
globalThis.__RAW_HISTORY_CRON_SQL=async(queries,transaction=false,options={})=>{
  executions.push({queries,transaction,options,at:Date.now()});
  const run=async connection=>{
    const result=[];
    for(const {query,params} of queries){
      statements.push({query,params});
      if(failInitialize&&/CREATE TABLE IF NOT EXISTS soccer_raw_seen_history_batches_v1/.test(query))throw Object.assign(Error('isolated schema failure'),{code:'08006'});
      if(failingCapture&&/WITH seed AS/.test(query)&&params.includes(failingCapture))throw Object.assign(Error('isolated transient read failure'),{code:'08006'});
      result.push((await connection.query(query,params)).rows);
      afterQuery?.(query,params);
    }
    return result;
  };
  return transaction?db.transaction(run):run(db);
};
const adapter='data:text/javascript,'+encodeURIComponent(`
  export function neon(){
    const execute=(query,params=[],options={})=>({query,params,options,then(a,b){return globalThis.__RAW_HISTORY_CRON_SQL([{query,params}],false,options).then(x=>x[0]).then(a,b);}});
    const sql=(strings,...params)=>execute(strings.reduce((s,p,i)=>s+(i?'$'+i:'')+p,''),params);
    sql.query=execute;sql.transaction=(queries,options={})=>globalThis.__RAW_HISTORY_CRON_SQL(queries,true,options);return sql;
  }
`);
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){
  if(s==='next/server')return n('next/server.js',c);
  if(s==='@neondatabase/serverless'&&/\\/lib\\/(?:soccer\\/raw-seen-history-(?:index|maintenance)|reader-seen-capture)\\.js$/.test(c.parentURL||''))
    return {url:${JSON.stringify(adapter)},shortCircuit:true};
  return n(s,c);
}`),import.meta.url);
const {initializeReaderSeenCaptureStore,buildReaderSeenCapture,canonicalReaderSeenCapture}=await import('../lib/reader-seen-capture.js');
const {reassembleRawSeenBatch,RAW_SEEN_DERIVATION_VERSION}=await import('../lib/soccer/raw-seen-history.js');
const {drainRawSeenHistoryIndex}=await import('../lib/soccer/raw-seen-history-maintenance.js');
const {queryRawHistoryIndex}=await import('../lib/soccer/raw-seen-history-index.js');
const {GET}=await import('../app/api/cron/soccer-raw-history-index/route.js');
const evidence=reassembleRawSeenBatch(parts).evidence,fixtureBefore=JSON.stringify(parts);
const oldEnv=Object.fromEntries(['DATABASE_URL','DATABASE_V2_URL','CRON_SECRET'].map(k=>[k,process.env[k]]));
const originalNow=Date.now;
const snapshot=async()=>canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query('SELECT * FROM sports_reader_seen_captures_v1 ORDER BY capture_id')).rows)));
const count=async table=>(await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
const assertFlags=value=>{
  assert.equal(value.archiveOnly,true);
  for(const key of ['currentBoardUpdated','historicalAvailabilityVerified','executable','coverageComplete','formalEligible','calibrationEligible'])assert.equal(value[key],false,key);
  assert.equal(value.closingCoverage,'NOT_VERIFIED');
};
const assertPartial=value=>{
  assert.equal(value.status,'PARTIAL');assert.equal(value.budgetKind,'SOFT_DEADLINE');assert.equal(value.hardDeadlineEnforced,false);assert.equal(value.maxBatches,2);assert.equal(value.completeWithinWindow,false);assert.equal(value.indexCoverage,'NOT_VERIFIED');
  assert.ok(value.results.length<=2);assert.deepEqual(value.results.map(r=>r.league),['EPL','UCL']);assertFlags(value);value.results.forEach(assertFlags);
  assert.equal(value.results.filter(r=>r.captureId).length<=2,true,'one raw batch per league, never an arbitrary query limit');
};
async function insertSource(part,{persistedAt=part.persistedAt,receivedAt=part.receivedAt}={}){
  const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:part.evidence,captureId:part.captureId,evidenceHash:part.evidenceHash},{deviceId:'cron-fixture',headerVersion:part.readerVersion});
  await db.query(`INSERT INTO sports_reader_seen_captures_v1
    (capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,
      table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at)
    VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)`,
    [part.captureId,part.league,part.observedAt,part.pageActivityAt||null,b.evidenceHash,b.evidenceJson,b.sourceScopeHash,part.readerVersion,
      b.tableCount,b.rowCount,b.cellCount,b.lockedRowCount,part.captureBatchId??null,part.partIndex??null,part.partCount??null,receivedAt,persistedAt]);
}
function synthetic(league,sequence,{unsupported=false}={}){
  const item={...structuredClone(evidence),league,observedAt:`2026-11-05T03:00:${String(sequence).padStart(2,'0')}.000Z`,
    tables:[{...structuredClone(evidence.tables[171]),rows:[structuredClone(evidence.tables[171].rows[758])]}]};
  if(league==='EPL'){
    item.tables[0].sectionTitle='聯盟: 英格蘭超級聯賽(18)';
    item.tables[0].rows[0].cells[1].pair[0]='愛華頓[主]';item.tables[0].rows[0].cells[1].pair[1]='阿仙奴';
  }
  if(unsupported)item.tables[0].headers=[];
  const built=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:item},{deviceId:'cron-fixture',headerVersion:item.readerVersion});
  return {...built,league,observedAt:item.observedAt,pageActivityAt:item.pageActivityAt||null,readerVersion:item.readerVersion,
    captureBatchId:null,partIndex:null,partCount:null,receivedAt:'2026-11-05T04:00:00.000Z',persistedAt:'2026-11-05T04:00:00.000Z'};
}
async function drain(now,options={}){
  const before=await snapshot(),value=await drainRawSeenHistoryIndex({now,...options});
  assertPartial(value);assert.equal(await snapshot(),before,'maintenance must never modify raw capture evidence or clocks');return value;
}
const request=(authorization,query='')=>new Request('https://fixture.invalid/api/cron/soccer-raw-history-index'+query,{headers:authorization?{authorization}:undefined});
try{
  delete process.env.DATABASE_V2_URL;Object.assign(process.env,{DATABASE_URL:'postgres://isolated.invalid/raw-history-cron',CRON_SECRET:'cron-isolated-secret'});
  let cut=statements.length;
  for(const auth of [undefined,'Bearer wrong','Basic cron-isolated-secret'])assert.equal((await GET(request(auth))).status,401);
  assert.equal(statements.length,cut,'cron auth must reject before touching storage');
  delete process.env.CRON_SECRET;assert.equal((await GET(request('Bearer cron-isolated-secret'))).status,401);process.env.CRON_SECRET='cron-isolated-secret';
  // Initialization failures are retryable HTTP failures and cannot create a
  // permanent skip receipt. Re-running the same job must retry initialization.
  failInitialize=true;
  let response=await GET(request('Bearer cron-isolated-secret')),body=await response.json();
  assert.equal(response.status,503);assert.equal(body.ok,false);assert.equal(body.status,'RETRYABLE');assertFlags({...body,calibrationEligible:false});
  failInitialize=false;
  await initializeReaderSeenCaptureStore();
  const dbClock=Date.parse((await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at);
  const future=new Date(Math.max(dbClock,Date.now(),Date.parse('2026-11-08T00:00:00Z'))+2*86400000);future.setUTCHours(0,0,0,0);
  const even=future.getTime(),odd=even+3600000,backlog=even+2*3600000;
  // A failed one-fragment replay must not suppress later fragments from its
  // same immutable four-part source batch.
  await insertSource(parts[0]);
  let result=await drain(even);
  assert.equal(result.ok,true);assert.deepEqual(result.results.map(r=>r.mode),['LATEST','BACKLOG']);
  assert.equal(result.results[0].status,'NO_PENDING_SOURCE');assert.equal(result.results[1].status,'SOURCE_UNINDEXED');
  assert.equal(result.results[1].reason,'RAW_SEEN_RECOVERY_INCOMPLETE');assert.equal(await count('soccer_raw_seen_history_attempts_v1'),1);
  let attempt=(await db.query('SELECT * FROM soccer_raw_seen_history_attempts_v1')).rows[0];
  assert.deepEqual(attempt.source_capture_ids,[parts[0].captureId]);assert.equal(attempt.status,'SOURCE_UNINDEXED');assert.equal(attempt.reason,'RAW_SEEN_RECOVERY_INCOMPLETE');
  assert.equal(attempt.derivation_version,RAW_SEEN_DERIVATION_VERSION);assert.equal(attempt.batch_hash.trim(),parts[0].captureBatchId);
  assert.equal(attempt.source_watermark_hash.trim(),createHash('sha256').update(canonicalReaderSeenCapture([parts[0].captureId])).digest('hex'));
  const attemptsBefore=canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query('SELECT * FROM soccer_raw_seen_history_attempts_v1 ORDER BY capture_id')).rows)));
  for(const part of parts.slice(1))await insertSource(part);
  result=await drain(odd);assert.deepEqual(result.results.map(r=>r.mode),['LATEST','BACKLOG']);
  assert.equal(result.results[1].status,'INDEXED');assert.equal(result.results[1].indexedGames,16);assert.equal(await count('soccer_raw_seen_history_batches_v1'),1);
  assert.equal(canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query('SELECT * FROM soccer_raw_seen_history_attempts_v1 ORDER BY capture_id')).rows))),attemptsBefore,'successful retry never rewrites original failure evidence');
  const history=await queryRawHistoryIndex({league:'UCL',from:'2026-11-05',through:'2026-11-05'},{now:odd});assert.equal(history.entries.length,9);assert.ok(history.entries.every(row=>row.marketCount===9));
  await assert.rejects(()=>db.query("UPDATE soccer_raw_seen_history_attempts_v1 SET reason='changed'"),/RAW_HISTORY_INDEX_IMMUTABLE/);
  await assert.rejects(()=>db.query('DELETE FROM soccer_raw_seen_history_attempts_v1'),/RAW_HISTORY_INDEX_IMMUTABLE/);
  // Four unsupported source batches establish both ordering directions. Every
  // call remains bounded to exactly one candidate per league.
  const sources={};
  for(const [league,base] of [['EPL',10],['UCL',20]]){
    sources[league]=[synthetic(league,base,{unsupported:true}),synthetic(league,base+1,{unsupported:true})];
    await insertSource(sources[league][0],{persistedAt:'2026-11-05T04:10:00.000001Z'});
    await insertSource(sources[league][1],{persistedAt:'2026-11-05T04:20:00.000001Z'});
  }
  cut=statements.length;result=await drain(even);
  assert.equal(result.results[0].captureId,sources.EPL[1].captureId);assert.equal(result.results[1].captureId,sources.UCL[0].captureId);
  assert.ok(result.results.every(r=>r.status==='SOURCE_UNINDEXED'&&r.reason==='RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'));
  assert.equal(statements.slice(cut).filter(s=>/WITH seed AS/.test(s.query)).length,2,'hard maximum of two raw batch replays');
  result=await drain(backlog);assert.deepEqual(result.results.map(r=>r.mode),['BACKLOG','LATEST']);
  assert.equal(result.results[0].captureId,sources.EPL[0].captureId);assert.equal(result.results[1].captureId,sources.UCL[1].captureId);
  assert.equal(await count('soccer_raw_seen_history_attempts_v1'),5);
  const unsupportedAttempts=(await db.query("SELECT * FROM soccer_raw_seen_history_attempts_v1 WHERE reason='RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'")).rows;
  for(const a of unsupportedAttempts){
    assert.deepEqual(a.source_capture_ids,[a.capture_id.trim()]);
    assert.equal(a.source_watermark_hash.trim(),createHash('sha256').update(canonicalReaderSeenCapture(a.source_capture_ids)).digest('hex'));
    assert.equal(a.batch_hash.trim(),a.capture_id.trim());
  }
  result=await drain(even);assert.ok(result.results.every(r=>r.status==='NO_PENDING_SOURCE'));
  assert.equal(result.completeWithinWindow,false,'even an exhausted queue cannot certify all source observations, games or closing lines');
  // A transient source read failure remains eligible. The real API must return
  // a retryable HTTP status without persisting an unsupported-source attempt.
  const retry=synthetic('EPL',30);await insertSource(retry,{persistedAt:'2026-11-05T05:00:00.000001Z'});
  const attemptsCount=await count('soccer_raw_seen_history_attempts_v1');failingCapture=retry.captureId;
  result=await drain(even);assert.equal(result.ok,false);assert.equal(result.results[0].status,'RETRYABLE');
  assert.equal(await count('soccer_raw_seen_history_attempts_v1'),attemptsCount);
  Date.now=()=>even;
  response=await GET(request('Bearer cron-isolated-secret','?league=UCL&limit=999&maxBatches=999&timeBudgetMs=999999'));
  body=await response.json();assert.equal(response.status,503,JSON.stringify(body));assertPartial(body);assert.equal(body.ok,false);assert.equal(body.timeBudgetMs,20000);
  assert.equal(body.results[0].captureId,retry.captureId,'query cannot change league selection');
  assert.equal(await count('soccer_raw_seen_history_attempts_v1'),attemptsCount);
  failingCapture=null;
  response=await GET(request('Bearer cron-isolated-secret','?league=UCL&limit=999&maxBatches=999&timeBudgetMs=999999'));
  body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assertPartial(body);assert.equal(body.ok,true);assert.equal(body.timeBudgetMs,20000);
  assert.equal(body.results[0].status,'INDEXED',JSON.stringify(body));assert.equal(body.results[0].indexedGames,1);assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(await count('soccer_raw_seen_history_attempts_v1'),attemptsCount);
  Date.now=originalNow;
  // A zero input cannot remove the minimum runtime budget; an oversized input
  // cannot lift the fixed upper bound.
  assert.equal((await drain(even,{timeBudgetMs:1})).timeBudgetMs,1000);
  assert.equal((await drain(even,{timeBudgetMs:999999})).timeBudgetMs,20000);
  // All maintenance SQL, including schema/source/replay/write/readback phases,
  // must execute under transaction-local statement/lock timeouts and an actual
  // transport AbortSignal. Source fixture setup is deliberately outside this.
  const boundedStart=executions.length;
  result=await drain(even);
  function assertBounded(calls,maxRemaining=20000){
    assert.ok(calls.length>0);
    for(const call of calls){
      assert.equal(call.transaction,true,'maintenance may not execute an unbounded standalone query');
      assert.ok(call.options.fetchOptions?.signal instanceof AbortSignal,'each maintenance fetch gets the remaining-deadline signal');
      assert.ok(call.queries.some(q=>/set_config\('statement_timeout'/.test(q.query)),'statement timeout required for every SQL transaction');
      assert.ok(call.queries.some(q=>/set_config\('lock_timeout'/.test(q.query)),'lock timeout required for every SQL transaction');
      for(const q of call.queries.filter(q=>/set_config\('(?:statement|lock)_timeout'/.test(q.query))){
        const timeoutValues=q.params.filter(v=>typeof v==='number'||typeof v==='string'&&/^\d+$/.test(v));
        assert.ok(timeoutValues.length>0&&timeoutValues.every(v=>Number(v)>0&&Number(v)<=maxRemaining),'timeouts are positive and cannot exceed the maximum run budget');
      }
    }
  }
  assertBounded(executions.slice(boundedStart));
  for(const [hour,expectedFirst,expectedModes]of [[0,'EPL',['LATEST','BACKLOG']],[1,'UCL',['LATEST','BACKLOG']],[2,'EPL',['BACKLOG','LATEST']],[3,'UCL',['BACKLOG','LATEST']]]){
    const start=executions.length,rotation=await drain(even+hour*3600000);
    assert.deepEqual(rotation.results.map(r=>r.mode),expectedModes);
    const first=executions.slice(start).flatMap(c=>c.queries).find(q=>/SELECT r.capture_id,r.capture_batch_id/.test(q.query));
    assert.equal(first.params[0],expectedFirst,`hour ${hour}: both source directions must eventually receive first service for each league`);
  }
  // The schema path is inside the same deadline as query work. An expired
  // initialization propagates to the route's retryable response; it cannot
  // start a candidate scan afterward.
  let controlledClock=even,slowExecution=-1;Date.now=()=>controlledClock;
  let phaseStart=executions.length;
  afterQuery=query=>{if(/CREATE TABLE IF NOT EXISTS soccer_raw_seen_history_batches_v1/.test(query)&&slowExecution<phaseStart){slowExecution=executions.length-1;controlledClock+=1100;}};
  const rawBeforeSchema=await snapshot();
  await assert.rejects(()=>drainRawSeenHistoryIndex({now:even,timeBudgetMs:1000}),error=>error.code==='RAW_HISTORY_INDEX_BUDGET_EXHAUSTED');
  assert.ok(slowExecution>=phaseStart);assert.equal(executions.length,slowExecution+1,'slow schema response cannot dispatch any candidate or source SQL afterward');
  assert.equal(await snapshot(),rawBeforeSchema);assertBounded(executions.slice(phaseStart),1000);
  controlledClock=even;slowExecution=-1;phaseStart=executions.length;
  afterQuery=query=>{if(/SELECT r.capture_id,r.capture_batch_id/.test(query)&&slowExecution<phaseStart){slowExecution=executions.length-1;controlledClock+=1100;}};
  result=await drain(even,{timeBudgetMs:1000});assert.ok(result.results.every(r=>r.status==='BUDGET_DEFERRED'));
  assert.equal(executions.length,slowExecution+1,'slow candidate response cannot dispatch a source watermark or replay afterward');assertBounded(executions.slice(phaseStart),1000);
  afterQuery=null;Date.now=originalNow;
  // Simulate a slow database response without sleeping. Once that response
  // exhausts the soft deadline, no subsequent transaction may be dispatched.
  const fairEpl=synthetic('EPL',31),fairUcl=synthetic('UCL',32);
  await insertSource(fairEpl,{persistedAt:'2026-11-05T05:10:00.000001Z'});await insertSource(fairUcl,{persistedAt:'2026-11-05T05:10:00.000001Z'});
  controlledClock=even;slowExecution=-1;
  Date.now=()=>controlledClock;
  afterQuery=(query,params)=>{if(/SELECT capture_id FROM sports_reader_seen_captures_v1 WHERE league=/.test(query)&&params[0]==='EPL'){slowExecution=executions.length-1;controlledClock+=1100;}};
  const beforeDeadlineAttempts=await count('soccer_raw_seen_history_attempts_v1'),beforeDeadlineGames=await count('soccer_raw_seen_history_games_v1');
  phaseStart=executions.length;result=await drain(even,{timeBudgetMs:1000});
  assert.ok(slowExecution>=phaseStart,'the slow EPL source-watermark query actually ran');
  assert.equal(executions.length,slowExecution+1,'exhausted deadline cannot dispatch a later raw read, index write or attempt write');
  assert.equal(result.results[1].status,'BUDGET_DEFERRED');assert.notEqual(result.results[0].status,'INDEXED');
  assert.equal(await count('soccer_raw_seen_history_attempts_v1'),beforeDeadlineAttempts);assert.equal(await count('soccer_raw_seen_history_games_v1'),beforeDeadlineGames);
  assertBounded(executions.slice(phaseStart),1000);
  // The next hour starts with UCL. A slow EPL cannot starve the other league
  // forever, and the externally visible result order remains [EPL,UCL].
  controlledClock=odd;slowExecution=-1;phaseStart=executions.length;result=await drain(odd,{timeBudgetMs:1000});
  const firstCandidate=executions.slice(phaseStart).flatMap(c=>c.queries).find(q=>/SELECT r.capture_id,r.capture_batch_id/.test(q.query));
  assert.equal(firstCandidate.params[0],'UCL','hourly alternation applies to execution order as well as source direction');
  assert.equal(result.results[1].status,'INDEXED');assert.equal(result.results[1].captureId,fairUcl.captureId);
  assert.equal(executions.length,slowExecution+1);assert.equal(await count('soccer_raw_seen_history_attempts_v1'),beforeDeadlineAttempts);
  assertBounded(executions.slice(phaseStart),1000);
  afterQuery=null;controlledClock=even;result=await drain(even,{timeBudgetMs:1000});assert.equal(result.results[0].status,'INDEXED');assert.equal(result.results[0].captureId,fairEpl.captureId);
  // Exercise slow raw replay and index writes/readback too. Queries already
  // dispatched in one atomic transaction may commit, but expiry must prevent
  // any NEW transaction after that response. Transient deadline expiry must
  // never produce a permanent unsupported-source attempt.
  for(const [sequence,phase,unsupported] of [[33,'RAW_READ',false],[34,'INDEX_WRITE',false],[35,'INDEX_READBACK',false],[36,'ATTEMPT_WRITE',true]]){
    const candidate=synthetic('EPL',sequence,{unsupported});await insertSource(candidate,{persistedAt:`2026-11-05T05:${sequence}:00.000001Z`});
    controlledClock=even;slowExecution=-1;phaseStart=executions.length;
    afterQuery=query=>{
      const matches=phase==='RAW_READ'?/WITH seed AS/.test(query):phase==='INDEX_WRITE'?/INSERT INTO soccer_raw_seen_history_batches_v1/.test(query):phase==='INDEX_READBACK'?/SELECT b.metadata,b.derived_hash/.test(query):/INSERT INTO soccer_raw_seen_history_attempts_v1/.test(query);
      if(matches&&slowExecution<phaseStart){slowExecution=executions.length-1;controlledClock+=1100;}
    };
    const beforeAttempts=await count('soccer_raw_seen_history_attempts_v1');result=await drain(even,{timeBudgetMs:1000});
    assert.ok(slowExecution>=phaseStart,`${phase} response exercised`);assert.equal(executions.length,slowExecution+1,`${phase} expiry prevents subsequent SQL dispatch`);
    assertBounded(executions.slice(phaseStart),1000);
    assert.equal(await count('soccer_raw_seen_history_attempts_v1'),beforeAttempts+(phase==='ATTEMPT_WRITE'?1:0),`${phase}: only an already-dispatched unsupported receipt may have committed`);
    afterQuery=null;controlledClock=even;
    // Finish any source whose first attempt stopped before its index commit.
    await drain(even,{timeBudgetMs:1000});
  }
  Date.now=originalNow;
  assert.equal(JSON.stringify(parts),fixtureBefore);
  await assert.rejects(()=>db.query('UPDATE sports_reader_seen_captures_v1 SET received_at=now()'),/READER_SEEN_CAPTURE_IMMUTABLE/);
  await assert.rejects(()=>db.query('DELETE FROM sports_reader_seen_captures_v1'),/READER_SEEN_CAPTURE_IMMUTABLE/);
  const mutations=statements.filter(s=>/^\s*(?:INSERT|UPDATE|DELETE)\b/.test(s.query));
  assert.ok(mutations.every(s=>/INSERT INTO soccer_raw_seen_history_(?:batches|games|attempts)_v1/.test(s.query)),'maintenance SQL writes only its derived index and attempt receipts');
  const middleware=readFileSync(new URL('../middleware.js',import.meta.url),'utf8');
  assert.match(middleware,/PUBLIC_PATHS\.add\('\/api\/cron\/soccer-raw-history-index'\)/);
  assert.doesNotMatch(middleware,/startsWith\([^)]*\/api\/cron/,'cron exemption remains an exact path rather than a broad public prefix');
  const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.deepEqual(config.crons.filter(c=>c.path==='/api/cron/soccer-raw-history-index'),[{path:'/api/cron/soccer-raw-history-index',schedule:'45 * * * *'}]);
  assert.equal(config.functions['app/api/cron/soccer-raw-history-index/route.js'].maxDuration,60);
  assert.equal(config.functions['app/api/cron/soccer-calibration/route.js'].maxDuration,180);
  const calibration=readFileSync(new URL('../app/api/cron/soccer-calibration/route.js',import.meta.url),'utf8');
  assert.doesNotMatch(calibration,/raw-seen-history|raw-history-index|drainRawSeen/);assert.match(calibration,/maxDuration\s*=\s*180/);assert.match(calibration,/deadline=Date\.now\(\)\+160000/);
}finally{
  Date.now=originalNow;afterQuery=null;await db.close();delete globalThis.__RAW_HISTORY_CRON_SQL;
  for(const [key,value]of Object.entries(oldEnv))if(value===undefined)delete process.env[key];else process.env[key]=value;
}
console.log('PASS raw-history cron: secret auth and retryable HTTP failures; max two batches/one per league; hourly latest/backlog rotation; immutable hashed unsupported receipts; incomplete batch re-eligible on new fragments; transient reads retry without attempt writes; original source clocks/evidence unchanged; separate cron route/config/budget; all-phase SQL/transport deadlines, no post-expiry dispatch, alternating league service under slow DB; Production NOT VERIFIED');
