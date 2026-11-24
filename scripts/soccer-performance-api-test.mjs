import assert from 'node:assert/strict';
import { GET, POST } from '../app/api/soccer/performance/route.js';
import { createSessionToken } from '../lib/security.js';
process.env.APP_PASSWORD='synthetic-soccer-performance-test';
process.env.SESSION_SECRET='synthetic-soccer-performance-test-secret';
const cookie=`mlb_session=${await createSessionToken()}`;
delete process.env.DATABASE_URL;delete process.env.DATABASE_V2_URL;delete process.env.POSTGRES_URL;
let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No external/DB calls permitted for rejection tests');};
const req=(method,query='',body={},authenticated=true,origin='http://localhost')=>new Request(`http://localhost/api/soccer/performance${query}`,{
  method,headers:{...(authenticated?{cookie}:{}),origin},...(method==='POST'?{body:JSON.stringify(body)}:{}),
});
assert.equal((await GET(req('GET','?league=epl',{},false))).status,401);
assert.equal((await POST(req('POST','',{action:'settle',league:'epl'},false))).status,401);
assert.equal((await POST(req('POST','',{action:'settle',league:'epl'},true,'https://other.example'))).status,403);
for(const query of ['','?league=NBA','?league=EPL','?league=epl&date=2026-02-30','?league=epl&limit=501',
  '?league=epl&cursor=bad','?league=epl&limit=1&limit=2','?league=epl&league=ucl','?league=epl&through=2026-11-24']) {
  const rejected=await GET(req('GET',query));assert.equal(rejected.status,400);assert.equal((await rejected.json()).ok,false);
}
for(const body of [{action:'erase',league:'epl'},{action:'settle',league:'NBA'},{action:'settle'},{action:'settle',league:'epl',date:'2026-11-24'}])
  assert.equal((await POST(req('POST','',body))).status,400);
assert.equal(calls,0);
for(const league of ['epl','ucl']) {
  const unavailable=await GET(req('GET',`?league=${league}`));assert.equal(unavailable.status,503);
  assert.equal(unavailable.headers.get('Cache-Control'),'no-store');
  assert.equal((await unavailable.json()).code,'SOCCER_PERFORMANCE_UNAVAILABLE');
}
console.log('Soccer performance API PASS: auth, origin, strict independent league scope, invalid/duplicate cursor/date/options rejected before DB, no-store explicit unavailable response');
