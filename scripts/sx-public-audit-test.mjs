import assert from 'node:assert/strict';
import { inspectSxSource, normalizeSxSnapshot } from '../lib/sx-public-audit.js';
const market = {marketHash:'0x'+'a'.repeat(64), sportXeventId:'L1', sportId:3,leagueId:171,type:236,line:4.5,status:'ACTIVE',gameTime:Date.parse('2026-09-07T10:00:00+08:00')/1000,teamOneName:'A',teamTwoName:'B',outcomeOneName:'Over 4.5',outcomeTwoName:'Under 4.5'};
const snapshot = {status:'success',data:{marketHash:market.marketHash,version:'000123',outcomeOne:[{percentageOdds:'50000000000000000000',size:'1000000'}],outcomeTwo:[]}};
const rows=normalizeSxSnapshot(snapshot,market,'2026-09-07T01:00:00Z');
assert.equal(rows[0].price,2);
assert.equal(rows[0].period,'FIRST_5_INNINGS');
assert.equal(rows[0].state,'MISSING_TIMESTAMP');
assert.equal(rows[0].observedAt,null);
assert.equal(rows[1].state,'NO_LIQUIDITY');
assert.equal(rows[1].price,null);
assert.throws(()=>normalizeSxSnapshot({...snapshot,data:{...snapshot.data,marketHash:'wrong'}},market,''));
for(const value of ['',null,'0','100000000000000000000','1e20','-1']) {
 const bad=structuredClone(snapshot);bad.data.outcomeOne[0].percentageOdds=value;
 assert.equal(normalizeSxSnapshot(bad,market,'')[0].price,null);
}
const paths=[];
const fetcher=async (url,options)=>{
 assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.headers,undefined);
 const u=new URL(url);paths.push(u);
 if(u.pathname==='/markets/active') return {ok:true,json:async()=>({status:'success',data:{markets:[market,{...market,leagueId:1191,marketHash:'0x'+'b'.repeat(64)}]}})};
 assert.equal(u.pathname,'/orderbook-v3/snapshot');assert.equal(u.searchParams.get('showTakerPerspective'),'true');
 return {ok:true,json:async()=>snapshot};
};
let result=await inspectSxSource({league:'MLB',date:'2026-09-07',eventId:'L1',fetcher});
assert.equal(result.quotes.length,2);assert.equal(result.events.length,1);assert.equal(result.verified,false);assert.equal(result.configured,true);assert.equal(paths.length,2);
assert.equal((await inspectSxSource({league:'CPBL',date:'2026-09-07',fetcher:()=>{throw Error('must not fetch')}})).status,'LEAGUE_NOT_MAPPED');
await assert.rejects(inspectSxSource({league:'MLB',date:'2026-02-30'}));
await assert.rejects(inspectSxSource({league:'__proto__',date:'2026-09-07'}));
for(const code of [401,403,429,500]) {
 result=await inspectSxSource({league:'MLB',date:'2026-09-07',fetcher:async()=>({ok:false,status:code})});
 assert.equal(result.verified,false);assert.notEqual(result.status,'NO_EVENTS');
}
result=await inspectSxSource({league:'NPB',date:'2026-09-07',fetcher:async()=>({ok:true,json:async()=>({status:'success',data:{markets:[]}})})});
assert.equal(result.status,'NO_EVENTS');
let calls=0;
result=await inspectSxSource({league:'MLB',date:'2026-09-07',fetcher:async()=>{calls++;return {ok:true,json:async()=>({status:'success',data:{markets:[market],nextKey:'same'}})}}});
assert.equal(result.partial,true);assert.equal(calls,1);assert.equal(result.events.length,1);
console.log('SX public audit: units, missing timestamps, empty liquidity, schema, league/date isolation, pagination, no credentials PASS');
