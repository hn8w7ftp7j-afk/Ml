import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { createSessionToken } from '../lib/security.js';
import { soccerDate } from '../lib/soccer/contracts.js';
const fixture=await soccerSqlFixture();
const keys=['APP_PASSWORD','SESSION_SECRET','DATABASE_URL','DATABASE_V2_URL'];
const before=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
process.env.APP_PASSWORD='soccer-forward-synthetic-api-test';process.env.SESSION_SECRET='soccer-forward-synthetic-session-secret';
process.env.DATABASE_URL='postgres://fixture.invalid/soccer-forward-api';delete process.env.DATABASE_V2_URL;
const originalFetch=globalThis.fetch;let externalCalls=0,ip=0;
globalThis.fetch=async()=>{externalCalls++;throw Error('API fixture must not access external services');};
try {
  const {GET,POST}=await import('../app/api/soccer/forward-validation/route.js');
  const cookie=`mlb_session=${await createSessionToken()}`;
  const request=(method,{auth=true,origin='http://localhost',body={},query='?league=epl&date='+soccerDate()}={})=>new Request(`http://localhost/api/soccer/forward-validation${query}`,{
    method,headers:{...(auth?{cookie}:{}),origin,'x-forwarded-for':`203.0.113.${++ip}`},...(method==='POST'?{body:JSON.stringify(body)}:{})});
  assert.equal((await GET(request('GET',{auth:false}))).status,401);
  assert.equal((await POST(request('POST',{auth:false}))).status,401);
  assert.equal((await POST(request('POST',{origin:'https://other.example'}))).status,403);
  for(const query of ['?league=nba','?league=epl&date=bad','?date=2026-02-30','?date=2026-10-19&date=2026-10-20','?prediction=999','?league=epl&from=2020-01-01&through=2026-10-19'])
    assert.equal((await GET(request('GET',{query}))).status,400,query);
  for(const body of [{action:'erase'},{action:'evaluate',result:{home:9}},{action:'evaluate',prediction:{home:.99}},
    {action:'evaluate',league:'ucl',date:'2026-02-30'},{action:'evaluate',limit:26},{action:'evaluate',limit:0},{action:'evaluate',league:'NBA'}])
    assert.equal((await POST(request('POST',{body}))).status,400,JSON.stringify(body));
  const read=await GET(request('GET'));
  assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'no-store');
  const first=await read.json();assert.equal(first.report.selectedGameModelPeriods,0);assert.equal(first.report.evaluatedGameModelPeriods,0);
  assert.equal(first.report.status,'AWAITING_PROSPECTIVE_RESULTS');assert.equal(first.report.promotionEligible,false);
  const run=await POST(request('POST',{body:{action:'evaluate',league:'epl',date:soccerDate(),limit:1}}));
  assert.equal(run.status,200);const payload=await run.json();assert.equal(payload.summary.evaluated,0);assert.equal(payload.report.capturedSnapshotPeriods,0);
  assert.equal(externalCalls,0,'authenticated GET never fetches results; empty POST neither injects source data nor calls provider');
  console.log('PASS soccer forward API: authenticated no-store reports, same-origin/rate-limited bounded POST, strict date/league/duplicate-key validation, no client forecast/result injection, actual fixture DB empty prospective report stays unapproved.');
} finally {
  globalThis.fetch=originalFetch;
  for(const key of keys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}
  await fixture.close();
}
