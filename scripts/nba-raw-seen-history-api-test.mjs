import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {register} from 'node:module';
import {PGlite} from '@electric-sql/pglite';
const parts=JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/nba/nba-seen-pregame-20261108.json.gz',import.meta.url))));
const db=new PGlite(),statements=[];
globalThis.__NBA_RAW_SEEN_SQL=async(queries,transaction=false)=>{
 const run=async c=>{const rows=[];for(const{query,params}of queries){statements.push(query);rows.push((await c.query(query,params)).rows);}return rows;};
 return transaction?db.transaction(run):run(db);
};
const adapter='data:text/javascript,'+encodeURIComponent(`export function neon(){const sql=(strings,...params)=>{const query=strings.reduce((s,p,i)=>s+(i?'$'+i:'')+p,'');return {query,params,then(a,b){return globalThis.__NBA_RAW_SEEN_SQL([{query,params}]).then(x=>x[0]).then(a,b);}}};sql.transaction=q=>globalThis.__NBA_RAW_SEEN_SQL(q,true);return sql;}`);
register('data:text/javascript,'+encodeURIComponent(`export async function resolve(s,c,n){if(s==='next/server')return n('next/server.js',c);if(s==='@neondatabase/serverless'&&(c.parentURL||'').endsWith('/lib/reader-seen-capture.js'))return {url:${JSON.stringify(adapter)},shortCircuit:true};return n(s,c);}`),import.meta.url);
const {initializeReaderSeenCaptureStore,buildReaderSeenCapture}=await import('../lib/reader-seen-capture.js');
const {createSessionToken}=await import('../lib/security.js');
const {GET}=await import('../app/api/nba/raw-seen-history/route.js');
const envNames=['DATABASE_URL','DATABASE_V2_URL','APP_PASSWORD','SESSION_SECRET'],old=Object.fromEntries(envNames.map(k=>[k,process.env[k]]));
try{
 delete process.env.DATABASE_V2_URL;Object.assign(process.env,{DATABASE_URL:'postgres://isolated.invalid/nba-raw-seen',APP_PASSWORD:'raw-fixture',SESSION_SECRET:'raw-fixture-session'});
 const token=await createSessionToken(),request=(q=`captureId=${parts[0].captureId}`,auth=true)=>new Request(`https://fixture.invalid/api/nba/raw-seen-history?${q}`,{headers:auth?{cookie:`mlb_session=${token}`}:{}});
 assert.equal((await GET(request(undefined,false))).status,401);assert.equal((await GET(request('captureId=bad'))).status,400);
 let cut=statements.length;assert.equal((await GET(request())).status,503);assert.ok(statements.slice(cut).every(q=>! /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(q)));
 await initializeReaderSeenCaptureStore();
 for(const[index,p]of parts.entries()){
  const b=buildReaderSeenCapture({schema:'READER-SEEN-CAPTURE-v1',evidence:p.evidence,captureId:p.captureId,evidenceHash:p.evidenceHash},{deviceId:'isolated-fixture',headerVersion:p.readerVersion});
  await db.query(`INSERT INTO sports_reader_seen_captures_v1(capture_id,schema_version,league,source_observed_at,page_activity_at,evidence_hash,evidence_json,source_scope_hash,reader_version,table_count,row_count,cell_count,locked_row_count,capture_batch_id,part_index,part_count,received_at,persisted_at) VALUES($1,'READER-SEEN-CAPTURE-v1',$2,$3::timestamptz,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::timestamptz,$17::timestamptz)`,[p.captureId,p.league,p.observedAt,p.pageActivityAt,b.evidenceHash,b.evidenceJson,b.sourceScopeHash,p.readerVersion,p.tableCount,p.rowCount,p.cellCount,p.lockedRowCount,p.captureBatchId,p.partIndex,p.partCount,p.receivedAt,p.persistedAt]);
  if(index===0){const r=await GET(request());assert.equal(r.status,422);assert.equal((await r.json()).code,'RAW_SEEN_RECOVERY_INCOMPLETE');}
 }
 cut=statements.length;const response=await GET(request()),body=await response.json();assert.equal(response.status,200,JSON.stringify(body));assert.equal(response.headers.get('cache-control'),'private, no-store');
 assert.equal(body.games.length,5);assert.equal(body.parts.length,3);assert.equal(body.observedAt,'2026-11-08T00:58:16.127Z');
 const other=await(await GET(request(`captureId=${parts[2].captureId}`))).json();assert.equal(other.derivedHash,body.derivedHash);
 assert.equal((await GET(request(`captureId=${'0'.repeat(64)}`))).status,404);
 assert.ok(statements.slice(cut).every(q=>! /\b(?:CREATE|ALTER|INSERT|UPDATE|DELETE)\b/.test(q)),'replay only SELECTs immutable originals');
 assert.equal((await db.query('SELECT count(*)::int n FROM sports_reader_seen_captures_v1')).rows[0].n,3);
 const source=readFileSync(new URL('../app/market-line-history/raw-seen-replay.js',import.meta.url),'utf8').split('export default function RawSeenReplay')[0].replace(/^import .*\n/gm,'');
 const {validateRawSeenReplay}=await import('data:text/javascript,'+encodeURIComponent(source));
 validateRawSeenReplay(body,parts[0]);
 const corrupt=structuredClone(body);corrupt.games[0].markets[0].unit='GOALS';assert.throws(()=>validateRawSeenReplay(corrupt,parts[0]));
 const executable=structuredClone(body);executable.executable=true;assert.throws(()=>validateRawSeenReplay(executable,parts[0]));
 assert.throws(()=>validateRawSeenReplay(body,{...parts[0],league:'MLB'}));
 console.log('NBA raw seen API and isolated DB integration PASS: auth, incomplete/404/503 distinctions, private no-store, read-only replay, UI response contract');
}finally{
 await db.close();delete globalThis.__NBA_RAW_SEEN_SQL;for(const k of envNames)if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];
}
