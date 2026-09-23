import assert from 'node:assert/strict';
import {GET,POST} from '../app/api/nba/corpus/route.js';
import {GET as research} from '../app/api/nba/research/route.js';
import {createSessionToken} from '../lib/security.js';
import {NBA_RESEARCH_URL} from '../lib/research-location.js';
process.env.APP_PASSWORD='synthetic-corpus-test';process.env.SESSION_SECRET='synthetic-corpus-only-secret';
const cookie=`mlb_session=${await createSessionToken()}`;
let calls=0;globalThis.fetch=async()=>{calls++;throw Error('retired research must not fetch or persist');};
for(const [handler,method] of [[GET,'GET'],[POST,'POST'],[research,'GET']]){
 const req=auth=>new Request('http://localhost/api/nba/corpus',{method,headers:auth?{cookie}:{},...(method==='POST'?{body:'{}'}:{})});
 assert.equal((await handler(req(false))).status,401);
 const response=await handler(req(true));assert.equal(response.status,410);assert.equal(response.headers.get('cache-control'),'no-store');
 const body=await response.json();assert.equal(body.code,'RESEARCH_MOVED');assert.equal(body.url,NBA_RESEARCH_URL);assert.equal(body.receipt,undefined);
}
assert.equal(calls,0);
console.log('NBA research retirement: auth, relocation and no legacy writes PASS.');
