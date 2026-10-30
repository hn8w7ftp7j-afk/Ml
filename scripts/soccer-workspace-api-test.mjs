import assert from 'node:assert/strict';
import { createSessionToken } from '../lib/security.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
const fixture=await soccerSqlFixture();
process.env.DATABASE_URL='postgres://fixture.invalid/workspace-api';delete process.env.DATABASE_V2_URL;
const {GET:board}=await import('../app/api/soccer/analysis-board/route.js');
const {GET,POST}=await import('../app/api/soccer/bet-records/route.js');
process.env.APP_PASSWORD='synthetic-football-workspace';process.env.SESSION_SECRET='synthetic-football-secret';
const cookie=`mlb_session=${await createSessionToken()}`;let calls=0;
globalThis.fetch=async()=>{calls++;throw Error('No external calls permitted');};
const request=(method,path,body={},auth=true,origin='http://localhost')=>new Request(`http://localhost/api/soccer/${path}`,{method,headers:{...(auth?{cookie}:{}),origin},...(method==='POST'?{body:JSON.stringify(body)}:{})});
const originalNow=Date.now;
try{
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
for(const [at,confirmed] of [['2026-10-30T15:01:38Z',false],['2026-10-30T15:01:39Z',true]]){
  Date.now=()=>Date.parse(at);
  for(const league of ['epl','ucl']){
    const response=await GET(request('GET',`bet-records?league=${league}&date=2026-10-30`));
    assert.equal(response.status,200);
    const body=await response.json(),policy=body.settlementPolicy;
    assert.equal(body.league,league);assert.deepEqual(body.records,[]);
    assert.equal(policy.rebateBasis,'SETTLED_PRINCIPAL');assert.equal(policy.rebateRate,.01);
    assert.equal(policy.rebateFormula,'stake * (winFraction + lossFraction) * 0.01');
    assert.equal(policy.missingTerms.some(term=>term.code==='REBATE_ELIGIBLE_SETTLEMENT_STATES'),false);
    assert.equal(policy.creditRuleConfirmation.status,confirmed?'USER_CONFIRMED':'NOT_YET_CONFIRMED');
    assert.equal(policy.creditRuleConfirmation.examples.length,confirmed?3:0);
    assert.equal(policy.formalContractVerified,false);assert.equal(policy.status,'SOURCE_TERMS_UNVERIFIED');
  }
}
assert.equal((await fixture.db.query('SELECT count(*)::int n FROM sports_soccer_manual_records_v1')).rows[0].n,0);
assert.equal(calls,0,'policy reads require no provider request or new wager');
console.log('PASS ledger GET: canonical 1% settled-principal policy, confirmed rebate omitted from missing terms, exact prospective example receipt, no contract approval or ledger writes, EPL/UCL isolation');
}finally{Date.now=originalNow;await fixture.close();}
