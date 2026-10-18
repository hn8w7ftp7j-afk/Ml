import assert from 'node:assert/strict';
import { GET as board } from '../app/api/soccer/analysis-board/route.js';
import { GET,POST } from '../app/api/soccer/bet-records/route.js';
import { createSessionToken } from '../lib/security.js';
process.env.APP_PASSWORD='synthetic-football-workspace';process.env.SESSION_SECRET='synthetic-football-secret';
const cookie=`mlb_session=${await createSessionToken()}`;let calls=0;
globalThis.fetch=async()=>{calls++;throw Error('No external calls permitted');};
const request=(method,path,body={},auth=true,origin='http://localhost')=>new Request(`http://localhost/api/soccer/${path}`,{method,headers:{...(auth?{cookie}:{}),origin},...(method==='POST'?{body:JSON.stringify(body)}:{})});
for(const handler of [board,GET])assert.equal((await handler(request('GET','analysis-board?league=epl&date=2026-10-20',{},false))).status,401);
assert.equal((await POST(request('POST','bet-records',{},false))).status,401);
assert.equal((await POST(request('POST','bet-records',{},true,'https://foreign.invalid'))).status,403);
for(const query of ['league=nba&date=2026-10-20','league=epl&date=2026-02-30','league=epl&date=2026-10-20&through=2026-11-20']){
  assert.equal((await board(request('GET',`analysis-board?${query}`))).status,400);
  assert.equal((await GET(request('GET',`bet-records?${query}`))).status,400);
}
for(const body of [{action:'settle'},{action:'erase'},{action:'record',alreadyPlaced:false},{action:'cancel',league:'epl',date:'2026-10-20',id:'invalid'},{action:'record',alreadyPlaced:true,league:'ucl',date:'2026-10-20',gameId:'soccer:epl:123',revision:'a'.repeat(64)}])assert.equal((await POST(request('POST','bet-records',body))).status,400);
assert.equal(calls,0);
console.log('PASS football workspace API: login, same-origin, scopes, real dates, bounded ranges, explicit self-report and unsupported settlement rejected before storage');
