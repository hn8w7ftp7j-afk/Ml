import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { register } from 'node:module';
import { PGlite } from '@electric-sql/pglite';

// The fixture is the exact four allow-listed sport fragments read from
// Production. All writes below are to this isolated PostgreSQL engine only.
const parts=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/soccer/ucl-seen-pregame-20261105.json.gz',import.meta.url))));
const db=new PGlite(),statements=[];
globalThis.__RAW_SEEN_HISTORY_SQL=async(queries,transaction=false)=>{
  const run=async connection=>{const rows=[];for(const {query,params} of queries){statements.push(query);rows.push((await connection.query(query,params)).rows);}return rows;};
  return transaction?db.transaction(run):run(db);
};
const adapter='data:text/javascript,'+encodeURIComponent(`
 export function neon(){const sql=(strings,...params)=>{const query=strings.reduce((s,p,i)=>s+(i?'$'+i:'')+p,'');return {query,params,then(a,b){return globalThis.__RAW_SEEN_HISTORY_SQL([{query,params}]).then(x=>x[0]).then(a,b);}}};
 sql.transaction=q=>globalThis.__RAW_SEEN_HISTORY_SQL(q,true);return sql;}
`);
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){
 if(s==='next/server')return n('next/server.js',c);
 if(s==='@neondatabase/serverless'&&(c.parentURL||'').endsWith('/lib/reader-seen-capture.js'))return {url:${JSON.stringify(adapter)},shortCircuit:true};
 return n(s,c);
}`),import.meta.url);
const {deriveRawSeenSoccerHistory,reassembleRawSeenBatch,parseRawSeenHistoryQuery}=await import('../lib/soccer/raw-seen-history.js');
const {initializeReaderSeenCaptureStore,buildReaderSeenCapture,canonicalReaderSeenCapture}=await import('../lib/reader-seen-capture.js');
const {parseSoccerCapture}=await import('../reader/soccer-parser.js');
const {createSessionToken}=await import('../lib/security.js');
const {GET}=await import('../app/api/soccer/raw-seen-history/route.js');
const clone=value=>structuredClone(value),clock=Date.parse('2026-11-08T00:00:00.000Z');
const restored=reassembleRawSeenBatch(parts),before=JSON.stringify(parts),rawCanonical=canonicalReaderSeenCapture(restored.evidence);
const result=deriveRawSeenSoccerHistory(parts,{now:clock}),nov5=result.games.filter(g=>g.boardDate==='2026-11-05');
assert.equal(restored.batchHash,'2698627e29ccbc5f630f6f5509605baaf989cffaa7959243fb2cd0e7356ae4c2');
assert.equal(restored.evidence.tables.length,173);assert.equal(restored.evidence.tables[171].rows.length,1624);
assert.equal(parseSoccerCapture(restored.evidence,new Date(restored.evidence.observedAt)).games.length,0,'raw pre-normalization evidence is not a normalized Reader payload');
assert.equal(result.games.length,16);assert.equal(nov5.length,9);assert.ok(nov5.every(g=>g.markets.length===9));
assert.ok(result.games.every(g=>!g.executable&&g.markets.every(m=>m.unit==='GOALS'&&!m.executable)));
assert.ok(result.games.every(g=>!JSON.stringify([g.homeRaw,g.awayRaw]).match(/角球|罰牌|U21/)));
assert.equal(result.diagnostics.excludedProps,28);assert.equal(result.diagnostics.excludedScopeRows,10);
assert.equal(result.diagnostics.unrecognizedGoalRows,0);
assert.equal(result.observedAt,'2026-11-04T17:44:45.474Z');assert.equal(result.pageActivityAt,null);
assert.ok(result.parts.every(p=>Date.parse(p.receivedAt)<Date.parse('2026-11-04T17:45:00Z')));
assert.equal(result.historicalAvailabilityVerified,false);assert.equal(result.currentBoardUpdated,false);assert.equal(result.coverageComplete,false);
assert.equal(result.closingCoverage,'NOT_VERIFIED');assert.equal(result.integrity.batchHashVerified,true);
assert.equal(deriveRawSeenSoccerHistory([...parts].reverse(),{now:clock+60000}).derivedHash,result.derivedHash,'a later replay cannot alter the stable derived content');
const real=nov5.find(g=>g.awayRaw==='皇家馬德里');
assert.equal(real.homeRaw,'AEK雅典[主]');
assert.deepEqual(real.markets[0].rawRows,['2平 1.060','0.820']);
assert.equal(real.markets[0].lineSide,'away');assert.equal(real.markets[0].awayWater,1.06);assert.equal(real.markets[0].homeWater,.82);
assert.deepEqual(real.markets[0].source.originalCell,['0.820','2平','1.060']);
assert.equal(real.markets[0].period,'FT');assert.equal(real.markets[0].periodEvidence.originalPeriod,'UNKNOWN');
assert.equal(real.markets[2].period,'HT');assert.equal(real.markets[2].periodEvidence.originalPeriod,'HT');
assert.equal(real.markets[5].line,'2+50');assert.equal(real.markets[5].isAlternative,true);
assert.equal(JSON.stringify(parts),before);assert.equal(canonicalReaderSeenCapture(reassembleRawSeenBatch(parts).evidence),rawCanonical);
assert.throws(()=>deriveRawSeenSoccerHistory(parts.slice(1)),e=>e.code==='RAW_SEEN_RECOVERY_INCOMPLETE');
assert.throws(()=>deriveRawSeenSoccerHistory([...parts,parts[0]]),e=>/INCOMPLETE|CONFLICT/.test(e.code));
const corrupt=clone(parts);corrupt[2].evidence.tables[0].rows[0].cells[0].pair[0]='changed';
assert.throws(()=>deriveRawSeenSoccerHistory(corrupt),e=>/HASH_MISMATCH|ID_MISMATCH/.test(e.code));
const changedBatch=clone(parts);for(const p of changedBatch){p.captureBatchId=p.evidence.captureBatchId='a'.repeat(64);const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:p.evidence},{deviceId:'readonly-fixture',headerVersion:p.readerVersion});p.captureId=b.captureId;p.evidenceHash=b.evidenceHash;}
assert.throws(()=>deriveRawSeenSoccerHistory(changedBatch),e=>e.code==='RAW_SEEN_RECOVERY_HASH_MISMATCH');
assert.throws(()=>deriveRawSeenSoccerHistory(Array(9).fill(parts[0])),e=>e.code==='RAW_SEEN_RECOVERY_BUDGET_EXCEEDED');
for(const query of ['','captureId=bad',`captureId=${parts[0].captureId}&date=2026-11-05`,`captureId=${parts[0].captureId}&captureId=${parts[0].captureId}`])
  assert.throws(()=>parseRawSeenHistoryQuery(new URLSearchParams(query)),e=>e.code==='RAW_SEEN_RECOVERY_QUERY_INVALID');

// Re-signing a synthetic raw fixture only proves that the observation was
// archived. It must not excuse an unknown profile, lock, scope or row shape.
const primary=clone(restored.evidence.tables[171].rows[758]),alternative=clone(restored.evidence.tables[171].rows[787]);
function synthetic(rows=[primary,alternative],change=()=>{}){
  const evidence={...clone(restored.evidence),tables:[{...clone(restored.evidence.tables[171]),rows:clone(rows)}]};change(evidence);
  const built=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence},{deviceId:'readonly-fixture',headerVersion:evidence.readerVersion});
  return [{...built,captureBatchId:null,partIndex:null,partCount:null,league:evidence.league,readerVersion:evidence.readerVersion,
    observedAt:evidence.observedAt,receivedAt:parts[0].receivedAt,persistedAt:parts[0].persistedAt}];
}
assert.equal(deriveRawSeenSoccerHistory(synthetic()).games.length,1);
const epl=deriveRawSeenSoccerHistory(synthetic(undefined,e=>{e.league='EPL';e.tables[0].sectionTitle='聯盟: 英格蘭超級聯賽(18)';
  e.tables[0].rows.forEach(r=>{r.cells[1].pair[0]='愛華頓[主]';r.cells[1].pair[1]='阿仙奴';});}));
assert.equal(epl.league,'EPL');assert.equal(epl.games.length,1);assert.ok(epl.games.every(g=>g.league==='EPL'));
assert.throws(()=>deriveRawSeenSoccerHistory(synthetic(undefined,e=>{e.league='EPL';})),e=>e.code==='RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT','UCL scope cannot be reused for EPL');
for(const qualifier of ['U-21','U 21','Ｕ－２１','Under-21','Women',"Women's",'Reserves','Youth','Academy','Cards','Yellow Cards','Red Cards'])
  assert.throws(()=>deriveRawSeenSoccerHistory(synthetic(undefined,e=>{e.tables[0].rows.forEach(r=>{r.cells[1].pair[0]=`AEK雅典 ${qualifier}[主]`;});})),e=>e.code==='RAW_SEEN_RECOVERY_NO_GOALS',qualifier);
for(const make of [
  ()=>synthetic([alternative]),
  ()=>synthetic(undefined,e=>{e.tables[0].headers[3]='主隊讓球';}),
  ()=>synthetic(undefined,e=>{e.tables[0].sectionTitle='歐洲冠軍聯賽 上半場';}),
  ()=>synthetic(undefined,e=>{e.tables[0].periodEvidenceTruncated=true;}),
  ()=>synthetic(undefined,e=>{e.tables[0].rows.forEach(r=>{r.marketLocked=true;});}),
  ()=>synthetic(undefined,e=>{e.tables[0].rows.forEach(r=>{r.cells[1].pair[0]='AEK雅典-角球數[主]';});}),
  ()=>synthetic(undefined,e=>{e.tables[0].rows.forEach(r=>{r.cells[1].pair[1]='皇家馬德里U21';});}),
  ()=>synthetic(undefined,e=>{e.tables[0].rows.unshift({cells:[{pair:['聯盟: 英格蘭全國聯賽盃(14)']}]});}),
  ()=>synthetic(undefined,e=>{e.tables[0].rows[0].cells[3].pair.push('0.999');}),
])assert.throws(()=>deriveRawSeenSoccerHistory(make()),e=>['RAW_SEEN_RECOVERY_NO_GOALS','RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'].includes(e.code));
assert.throws(()=>deriveRawSeenSoccerHistory(synthetic(undefined,e=>{e.tables[0].headers=[];})),e=>e.code==='RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT');

const envNames=['DATABASE_URL','DATABASE_V2_URL','APP_PASSWORD','SESSION_SECRET'];
const old=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
try {
  delete process.env.DATABASE_V2_URL;Object.assign(process.env,{DATABASE_URL:'postgres://isolated.invalid/raw-seen-fixture',APP_PASSWORD:'raw-fixture',SESSION_SECRET:'raw-fixture-session'});
  const session=await createSessionToken();
  const request=(query=`captureId=${parts[0].captureId}`,auth=true)=>new Request(`https://fixture.invalid/api/soccer/raw-seen-history?${query}`,{headers:auth?{cookie:`mlb_session=${session}`}:{}});
  assert.equal((await GET(request(undefined,false))).status,401);
  assert.equal((await GET(request('captureId=bad'))).status,400);
  let cut=statements.length;
  assert.equal((await GET(request())).status,503,'missing table is unavailable, never zero captures');
  assert.ok(statements.slice(cut).every(q=>! /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(q)));
  await initializeReaderSeenCaptureStore();
  for(const [index,p] of parts.entries()){
    const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:p.evidence,captureId:p.captureId,evidenceHash:p.evidenceHash},
      {deviceId:'readonly-fixture',headerVersion:p.readerVersion});
    const persisted=index===3?p.persistedAt.replace('Z','123Z'):p.persistedAt;
    await db.query(`INSERT INTO sports_reader_seen_captures_v1
      (capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,
      table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at)
      VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)`,
      [p.captureId,p.league,p.observedAt,p.pageActivityAt,b.evidenceHash,b.evidenceJson,b.sourceScopeHash,p.readerVersion,
        p.tableCount,p.rowCount,p.cellCount,p.lockedRowCount,p.captureBatchId,p.partIndex,p.partCount,p.receivedAt,persisted]);
    if(index===0){const partial=await GET(request());assert.equal(partial.status,422);assert.equal((await partial.json()).code,'RAW_SEEN_RECOVERY_INCOMPLETE');}
  }
  // Keep microseconds visible in the shipped API, rather than silently reduce
  // immutable DB timestamps to the browser's millisecond precision.
  const expectedPersisted=parts[3].persistedAt.replace('Z','123Z');
  const count=async()=>(await db.query('SELECT count(*)::int n FROM sports_reader_seen_captures_v1')).rows[0].n;
  assert.equal(await count(),4);cut=statements.length;
  const response=await GET(request()),body=await response.json();
  assert.equal(response.status,200,JSON.stringify(body));assert.equal(response.headers.get('cache-control'),'private, no-store');
  assert.equal(body.games.filter(g=>g.boardDate==='2026-11-05').length,9);assert.equal(body.parts.length,4);
  assert.equal(body.observedAt,result.observedAt);assert.equal(body.persistedAt,expectedPersisted);
  assert.equal(body.derivedHash,result.derivedHash);assert.equal(body.executable,false);
  assert.equal(Object.hasOwn(body,'deviceId'),false);
  const other=await(await GET(request(`captureId=${parts[2].captureId}`))).json();assert.equal(other.derivedHash,body.derivedHash);
  assert.equal((await GET(request(`captureId=${'0'.repeat(64)}`))).status,404);
  assert.ok(statements.slice(cut).every(q=>! /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(q)),'every authenticated replay is SELECT only');
  assert.equal(await count(),4,'historical read never creates a normalized observation, receipt or current head');
  await assert.rejects(()=>db.query('UPDATE sports_reader_seen_captures_v1 SET received_at=now() WHERE capture_id=$1',[parts[0].captureId]),/IMMUTABLE/);
  await assert.rejects(()=>db.query('DELETE FROM sports_reader_seen_captures_v1 WHERE capture_id=$1',[parts[0].captureId]),/IMMUTABLE/);
} finally {
  await db.close();delete globalThis.__RAW_SEEN_HISTORY_SQL;
  for(const k of envNames)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];
}
console.log('PASS raw seen historical replay: exact real 4-part pregame batch/hash, Nov5 nine GOALS games/all alternatives, home/away and source cells, immutable times/microseconds, props/youth/foreign/locks/unknown profiles fail closed; authenticated PGlite GET is read-only, no heads/analysis/trading promotion; Production NOT VERIFIED');
