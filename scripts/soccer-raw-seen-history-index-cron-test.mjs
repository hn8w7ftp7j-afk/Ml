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
async function insertSource(part,{persistedAt=part.persistedAt,receivedAt=part.receivedAt}={}){
  const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:part.evidence,captureId:part.captureId,evidenceHash:part.evidenceHash},{deviceId:'cron-fixture',headerVersion:part.readerVersion});
  await db.query(`INSERT INTO sports_reader_seen_captures_v1
    (capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,
      table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at)
    VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)`,
    [part.captureId,part.league,part.observedAt,part.pageActivityAt||null,b.evidenceHash,b.evidenceJson,b.sourceScopeHash,part.readerVersion,
      b.tableCount,b.rowCount,b.cellCount,b.lockedRowCount,part.captureBatchId??null,part.partIndex??null,part.partCount??null,receivedAt,persistedAt]);
}

const { getRawSeenHistoryProgress }=await import('../lib/soccer/raw-seen-history-maintenance.js');
const { writeFileSync }=await import('node:fs');
const { tmpdir }=await import('node:os');
const { join }=await import('node:path');
function synthetic(league,sequence,{unsupported=false,day='2026-10-20'}={}){
  const item={...structuredClone(evidence),league,observedAt:day+'T03:00:'+String(sequence).padStart(2,'0')+'.000Z',
    tables:[{...structuredClone(evidence.tables[171]),rows:[structuredClone(evidence.tables[171].rows[758])]}]};
  if(league==='EPL'){
    item.tables[0].sectionTitle='聯盟: 英格蘭超級聯賽(18)';
    item.tables[0].rows[0].cells[1].pair[0]='愛華頓[主]';item.tables[0].rows[0].cells[1].pair[1]='阿仙奴';
  }
  if(unsupported)item.tables[0].headers=[];
  const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:item},{deviceId:'cron-fixture',headerVersion:item.readerVersion});
  return {...b,league,observedAt:item.observedAt,pageActivityAt:item.pageActivityAt||null,readerVersion:item.readerVersion,
    captureBatchId:null,partIndex:null,partCount:null,receivedAt:'2026-11-05T04:00:00.000Z',persistedAt:'2026-11-05T04:00:00.000Z'};
}
function assertReceipt(value,max=24){
  assert.equal(value.schema,'soccer-raw-history-maintenance-v1');assert.equal(value.budgetKind,'SOFT_DEADLINE');
  assert.equal(value.hardDeadlineEnforced,false);assert.equal(value.maxBatches,max);assert.ok(value.processedBatches<=max);
  assert.equal(value.completeWithinWindow,false);assert.equal(value.indexCoverage,'NOT_VERIFIED');assertFlags(value);
  assert.equal(value.processedBatches,value.results.length);
  for(const row of value.results){assertFlags(row);assert.ok(['INDEXED','SOURCE_UNINDEXED','RETRYABLE'].includes(row.status));}
  assert.equal(value.processedBatches,value.indexedBatches+value.stableAttemptBatches+value.retryableBatches);
  assert.equal(new Set(value.results.map(r=>r.captureId)).size,value.results.length,'each source is attempted once per run');
}
function assertProgress(value){
  assert.equal(value.schema,'soccer-raw-history-maintenance-v1');assertFlags(value);
  assert.equal(value.dateBasis,'SOURCE_OBSERVATION_TAIPEI_DATE');assert.equal(value.countUnit,'CANONICAL_SOURCE_BATCHES');
  if(value.status==='NOT_INITIALIZED'){assert.equal(value.counts,null);assert.ok(value.leagues.every(l=>l.counts===null));return;}
  const check=c=>{assert.equal(c.sourceBatches,c.indexedBatches+c.unindexedBatches);assert.equal(c.unindexedBatches,c.stableAttemptBatches+c.retryPendingBatches);assert.ok(c.sourceFragments>=c.sourceBatches);};
  check(value.counts);
  for(const l of value.leagues){
    check(l.counts);for(const d of l.days)check(d.counts);
    for(const k of Object.keys(l.counts))assert.equal(l.counts[k],l.days.reduce((n,d)=>n+d.counts[k],0));
    assert.equal(l.reasons.reduce((n,r)=>n+r.batches,0),l.counts.stableAttemptBatches);
  }
  for(const k of Object.keys(value.counts))assert.equal(value.counts[k],value.leagues.reduce((n,l)=>n+l.counts[k],0));
}
async function drain(now,options={}){
  const before=await snapshot(),v=await drainRawSeenHistoryIndex({now,...options});assertReceipt(v,Math.min(options.maxBatches??24,64));
  assert.equal(await snapshot(),before,'raw captures and clocks remain immutable');return v;
}
async function progress(now){
  const cut=statements.length,value=await getRawSeenHistoryProgress({now});assertProgress(value);
  assert.ok(statements.slice(cut).every(s=>!/(\bCREATE\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b|\bALTER\b|\bDROP\b)/i.test(s.query)),'GET progress is SELECT-only, including first read');
  return value;
}
const request=authorization=>new Request('https://fixture.invalid/api/cron/soccer-raw-history-index',{headers:authorization?{authorization}:undefined});
try{
  delete process.env.DATABASE_V2_URL;Object.assign(process.env,{DATABASE_URL:'postgres://isolated.invalid/raw-history-cron',CRON_SECRET:'cron-isolated-secret'});
  let cut=statements.length;
  for(const auth of [undefined,'Bearer wrong','Basic cron-isolated-secret'])assert.equal((await GET(request(auth))).status,401);
  assert.equal(statements.length,cut);
  failInitialize=true;let response=await GET(request('Bearer cron-isolated-secret'));assert.equal(response.status,503);failInitialize=false;
  await initializeReaderSeenCaptureStore();
  const dbClock=Date.parse((await db.query('SELECT clock_timestamp()::text AS at')).rows[0].at);
  const future=new Date(Math.max(dbClock,Date.now(),Date.parse('2026-11-08T00:00:00Z'))+2*86400000);future.setUTCHours(0,0,0,0);
  const now=future.getTime();
  assert.equal((await progress(now)).status,'NOT_INITIALIZED','missing derived schema is unknown, never zero or auto-created');
  await insertSource(parts[0]);
  let v=await drain(now,{maxBatches:2});
  assert.equal(v.processedBatches,1);assert.equal(v.stableAttemptBatches,1);assert.equal(v.results[0].reason,'RAW_SEEN_RECOVERY_INCOMPLETE');
  let pg=await progress(now);
  assert.equal(pg.counts.sourceFragments,1);assert.equal(pg.counts.sourceBatches,1);assert.equal(pg.counts.stableAttemptBatches,1);assert.equal(pg.counts.retryPendingBatches,0);
  const oldAttempts=canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query('SELECT * FROM soccer_raw_seen_history_attempts_v1 ORDER BY capture_id')).rows)));
  for(const part of parts.slice(1))await insertSource(part);
  pg=await progress(now);assert.equal(pg.counts.sourceFragments,parts.length);assert.equal(pg.counts.sourceBatches,1);
  assert.equal(pg.counts.stableAttemptBatches,0);assert.equal(pg.counts.retryPendingBatches,1,'a new fragment invalidates the old attempt watermark');
  v=await drain(now+60000,{maxBatches:2});assert.equal(v.indexedBatches,1);assert.equal(v.results[0].indexedGames,16);
  assert.equal(canonicalReaderSeenCapture(JSON.parse(JSON.stringify((await db.query('SELECT * FROM soccer_raw_seen_history_attempts_v1 ORDER BY capture_id')).rows))),oldAttempts);
  pg=await progress(now+60000);assert.equal(pg.counts.indexedBatches,1);assert.equal(pg.counts.indexedGames,16);assert.equal(pg.counts.sourceBatches,1);
  const history=await queryRawHistoryIndex({league:'UCL',from:'2026-11-05',through:'2026-11-05'},{now:now+60000});
  assert.equal(history.entries.length,9);assert.ok(history.entries.every(r=>r.marketCount===9));
  // A claimed batch hash alone cannot make a newly arrived fragment indexed.
  const extraEvidence={...structuredClone(parts[0].evidence),partIndex:parts.length,partCount:parts.length+1};
  const extraBuilt=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:extraEvidence},{deviceId:'cron-fixture',headerVersion:parts[0].readerVersion});
  const extra={...parts[0],...extraBuilt,partIndex:parts.length,partCount:parts.length+1};
  await insertSource(extra);
  pg=await progress(now+60000);assert.equal(pg.counts.indexedBatches,0);assert.equal(pg.counts.retryPendingBatches,1);
  v=await drain(now+120000,{maxBatches:2});assert.equal(v.stableAttemptBatches,1);
  assert.equal(await count('soccer_raw_seen_history_batches_v1'),1,'the previous immutable derived batch remains intact');
  pg=await progress(now+120000);assert.equal(pg.counts.stableAttemptBatches,1);assert.equal(pg.counts.retryPendingBatches,0);
  // Multiple source-date buckets get representatives before duplicate backlog.
  const bulk=[];
  for(const [league,offset]of [['EPL',0],['UCL',10]])for(let i=0;i<6;i++){
    const p=synthetic(league,offset+i,{day:'2026-10-'+String(20+i).padStart(2,'0'),unsupported:i%2===0});
    bulk.push(p);await insertSource(p);
  }
  const fullBefore=await snapshot();v=await drain(now+180000,{maxBatches:8});
  assert.equal(v.processedBatches,8);assert.equal(v.status,'BATCH_LIMIT_REACHED');assert.equal(v.hasMore,null,'a resource limit alone cannot prove remaining source count');
  assert.equal(v.results.filter(r=>r.league==='EPL').length,4);assert.equal(v.results.filter(r=>r.league==='UCL').length,4);
  for(const league of ['EPL','UCL'])assert.deepEqual(v.results.slice(0,4).filter(r=>r.league===league).map(r=>r.sourceDate).sort(),['2026-10-20','2026-10-25']);
  assert.equal(await snapshot(),fullBefore);
  const compactFixture={progress:await progress(now+180000),receipt:v};
  writeFileSync(join(tmpdir(),'history-maintenance-contract-fixtures.json'),JSON.stringify(compactFixture));
  v=await drain(now+240000,{maxBatches:64});
  assert.equal(v.status,'WINDOW_EXHAUSTED');assert.equal(v.hasMore,false);
  pg=await progress(now+240000);assert.equal(pg.counts.retryPendingBatches,0);assert.ok(pg.counts.stableAttemptBatches>0);assert.equal(pg.status,'SOURCE_UNINDEXED');
  // Two calls in one hour still rotate league and mode starts, not hourly lanes.
  const t1=synthetic('EPL',40,{day:'2026-10-19'}),t2=synthetic('UCL',41,{day:'2026-10-19'});
  await insertSource(t1);await insertSource(t2);
  const attempts=await count('soccer_raw_seen_history_attempts_v1');failingCapture=t1.captureId;
  v=await drain(now+300000,{maxBatches:2});assert.equal(v.retryableBatches,1);assert.equal(v.indexedBatches,1);
  assert.equal(v.status,'RETRYABLE');assert.equal(v.ok,false);assert.equal(await count('soccer_raw_seen_history_attempts_v1'),attempts,'503 cannot quarantine');
  failingCapture=null;
  pg=await progress(now+300000);assert.equal(pg.counts.retryPendingBatches,1);
  v=await drain(now+360000,{maxBatches:2});assert.equal(v.indexedBatches,1);assert.equal(v.retryableBatches,0);
  // A soft deadline after a source read must stop further work and retain retry.
  const budgetSource=synthetic('EPL',45,{day:'2026-10-18'});await insertSource(budgetSource);
  let clock=originalNow();Date.now=()=>clock;
  afterQuery=query=>{if(/WITH seed AS/.test(query))clock+=1001;};
  const beforeBudgetAttempts=await count('soccer_raw_seen_history_attempts_v1');
  v=await drain(now+420000,{maxBatches:24,timeBudgetMs:1000});assert.equal(v.status,'BUDGET_DEFERRED');assert.equal(v.hardDeadlineEnforced,false);
  assert.equal(v.retryableBatches,1);assert.equal(await count('soccer_raw_seen_history_attempts_v1'),beforeBudgetAttempts);assert.equal(v.hasMore,null);
  afterQuery=null;Date.now=originalNow;
  pg=await progress(now+420000);assert.equal(pg.counts.retryPendingBatches,1);
  await drain(now+480000,{maxBatches:2});
  // Expiry after each dispatched transaction may leave an idempotent commit,
  // but must never dispatch subsequent work or invent a source failure.
  for(const [sequence,phase,unsupported]of [[46,'MANIFEST_READ',false],[47,'INDEX_WRITE',false],[48,'INDEX_READBACK',false],[49,'ATTEMPT_WRITE',true]]){
    const source=synthetic('EPL',sequence,{day:'2026-10-17',unsupported});await insertSource(source);
    clock=originalNow();Date.now=()=>clock;let slow=-1;const executionStart=executions.length;
    afterQuery=query=>{const matches=phase==='MANIFEST_READ'?/SELECT capture_id FROM sports_reader_seen_captures_v1/.test(query)
      :phase==='INDEX_WRITE'?/INSERT INTO soccer_raw_seen_history_batches_v1/.test(query)
        :phase==='INDEX_READBACK'?/SELECT b.metadata,b.derived_hash/.test(query):/INSERT INTO soccer_raw_seen_history_attempts_v1/.test(query);
      if(matches&&slow<0){slow=executions.length-1;clock+=1001;}};
    const before=await count('soccer_raw_seen_history_attempts_v1');v=await drain(now+540000,{maxBatches:24,timeBudgetMs:1000});
    assert.ok(slow>=executionStart,phase+' boundary exercised');assert.equal(v.status,'BUDGET_DEFERRED');assert.equal(v.retryableBatches,1);
    assert.equal(executions.length,slow+1,phase+' does not dispatch new SQL after expiry');
    assert.equal(await count('soccer_raw_seen_history_attempts_v1'),before+(phase==='ATTEMPT_WRITE'?1:0));
    assert.ok(executions.slice(executionStart).every(e=>e.options.fetchOptions?.signal instanceof AbortSignal));
    assert.equal(executions.at(-1).options.fetchOptions.signal.aborted,true);
    afterQuery=null;Date.now=originalNow;await drain(now+600000,{maxBatches:2});
  }
  // A claimed batch shared across two league namespaces cannot suppress the
  // other league, even when both sources are malformed and kept unindexed.
  for(const [league,sequence]of [['EPL',50],['UCL',51]]){
    const original=synthetic(league,sequence,{day:'2026-10-16'}),e={...original.evidence,captureBatchId:'a'.repeat(64),partIndex:0,partCount:1};
    const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:e},{deviceId:'cron-fixture',headerVersion:original.readerVersion});
    await insertSource({...original,...b,captureBatchId:e.captureBatchId,partIndex:0,partCount:1});
  }
  v=await drain(now+660000,{maxBatches:2});assert.equal(v.processedBatches,2);assert.equal(v.stableAttemptBatches,2);assert.deepEqual(v.results.map(r=>r.league).sort(),['EPL','UCL']);
  const footballBefore=(await progress(now+660000)).counts.sourceBatches;
  await insertSource(synthetic('NBA',52,{day:'2026-10-15'}));
  pg=await progress(now+660000);assert.equal(pg.counts.sourceBatches,footballBefore,'other sport raw evidence cannot enter football progress');
  v=await drain(now+540000,{maxBatches:999,timeBudgetMs:999999});assert.equal(v.maxBatches,64);assert.equal(v.timeBudgetMs,40000);
  for(const options of [{maxBatches:0},{maxBatches:1.5},{timeBudgetMs:0},{timeBudgetMs:NaN}])await assert.rejects(()=>drainRawSeenHistoryIndex(options),e=>e.status===400);
  for(const table of ['sports_reader_seen_captures_v1','soccer_raw_seen_history_batches_v1','soccer_raw_seen_history_games_v1','soccer_raw_seen_history_attempts_v1']){
    await assert.rejects(()=>db.query('DELETE FROM '+table),/IMMUTABLE/);
  }
  assert.ok(statements.filter(s=>/WITH eligible AS/.test(s.query)).every(s=>!/evidence_json|payload_json/.test(s.query)),'candidate selection does not scan original payload JSON');
  assert.ok(executions.filter(e=>e.transaction).every(e=>e.queries.slice(0,2).every(q=>/set_config/.test(q.query))||!e.options.fetchOptions),'deadline wrapper includes statement and lock budgets');
  const mutations=statements.filter(s=>/^\s*(?:INSERT|UPDATE|DELETE)\b/.test(s.query));
  assert.ok(mutations.every(s=>/INSERT INTO soccer_raw_seen_history_(?:batches|games|attempts)_v1/.test(s.query)),'only derived index and attempt records are written');
  const middleware=readFileSync(new URL('../middleware.js',import.meta.url),'utf8');
  assert.match(middleware,/PUBLIC_PATHS\.add\('\/api\/cron\/soccer-raw-history-index'\)/);
  assert.doesNotMatch(middleware,/startsWith\([^)]*\/api\/cron/);
  const config=JSON.parse(readFileSync(new URL('../vercel.json',import.meta.url),'utf8'));
  assert.equal(config.crons.filter(c=>c.path==='/api/cron/soccer-raw-history-index').length,1);
  assert.equal(config.crons.find(c=>c.path==='/api/cron/soccer-raw-history-index').schedule,'* * * * *');
  assert.equal(config.functions['app/api/cron/soccer-raw-history-index/route.js'].maxDuration,60);
  const calibration=readFileSync(new URL('../app/api/cron/soccer-calibration/route.js',import.meta.url),'utf8');
  assert.doesNotMatch(calibration,/raw-seen-history|raw-history-index|drainRawSeen/);assert.match(calibration,/maxDuration\s*=\s*180/);assert.match(calibration,/deadline=Date\.now\(\)\+160000/);
  assert.equal(JSON.stringify(parts),fixtureBefore);
  console.log('PASS real PostgreSQL raw-history maintenance: bounded24/hard64, balanced leagues/date buckets/backlog, read-only canonical progress, precise fragment retry watermarks, immutable derived data, 503 retry, soft deadline and source/time/price preservation; NOT Production');
}finally{
  afterQuery=null;Date.now=originalNow;
  for(const [key,value]of Object.entries(oldEnv))value===undefined?delete process.env[key]:process.env[key]=value;
  delete globalThis.__RAW_HISTORY_CRON_SQL;await db.close();
}
