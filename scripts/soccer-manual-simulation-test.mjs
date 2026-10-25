import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {transform} from 'next/dist/build/swc/index.js';
import {simulateSoccerManualQuote,validSoccerSimulationInput} from '../lib/soccer/manual-simulation.js';
const now=Date.parse('2026-10-26T06:00:00Z'),at=new Date(now).toISOString();
const game={id:'soccer:epl:123',sourceId:'123',league:'epl',date:'2026-10-26',status:'scheduled',startTime:new Date(now+3600000).toISOString(),home:{sourceId:'359',name:'Arsenal'},away:{sourceId:'364',name:'Liverpool'}};
const distribution=period=>({league:'epl',gameId:game.id,period:period==='FT'?'REGULATION_FT':'REGULATION_HT',modelVersion:'SYNTHETIC_UNIT_NOT_APPROVED',trainingHash:'a'.repeat(64),trainedThrough:'2026-10-25T00:00:00Z',cells:[{home:2,away:0,probability:.6},{home:0,away:0,probability:.4}],retainedMass:1,tailMass:0});
const snapshot={ok:true,executable:false,analysisStatus:'COMPLETED',qaFlag:'WARN',persisted:true,revision:'b'.repeat(64),gameId:game.id,league:'epl',date:game.date,evidence:{game,source:{fetchedAt:at}},analysisCutoff:at,prediction:distribution('FT'),halfTimePrediction:distribution('HT')};
const input={league:'epl',date:game.date,eventId:'123',revision:snapshot.revision,period:'FT',kind:'TOTAL',side:'over',line:'1.5',lineSide:null,water:.9};
const run=(i=input,s=snapshot,t=now)=>simulateSoccerManualQuote({input:i,snapshot:s,now:t});
for(const period of ['FT','HT'])for(const kind of ['HANDICAP','TOTAL'])for(const side of kind==='TOTAL'?['over','under']:['home','away']){
 const r=run({...input,period,kind,side,lineSide:kind==='HANDICAP'?'home':null});assert.equal(r.ok,true,JSON.stringify(r));
 const win=side==='home'||side==='over',expected=(win?.6:.4)*.9-(win?.4:.6)+.01;
 assert.ok(Math.abs(r.netReturnBounds.lower-expected)<1e-12);assert.ok(Math.abs(r.netReturnBounds.upper-expected)<1e-12);
 for(const field of ['W','R','S'])assert.equal(r[field],null);assert.equal(r.inputSource,'USER_HYPOTHESIS');assert.equal(r.executable,false);assert.equal(r.eligible,false);assert.equal(r.formalScoringEnabled,false);
}
const exact={...snapshot,prediction:{...distribution('FT'),cells:[{home:1,away:0,probability:1}]}};
for(const [line,side,expected] of [['1+20','over',.182],['1+20','under',-.198],['1-50','over',-.495],['1+50','over',.455],['1平','over',0]])assert.ok(Math.abs(run({...input,line,side},exact).netReturnBounds.lower-expected)<1e-12,'settled-principal rebate at '+line+' '+side);
for(const patch of [{period:'UNKNOWN'},{water:0},{water:Infinity},{line:'1.25'},{kind:'MONEYLINE'},{side:'home'},{lineSide:'home'},{approved:true}])assert.equal(validSoccerSimulationInput({...input,...patch}),false);
for(const patch of [{revision:'c'.repeat(64)},{gameId:'soccer:epl:124'},{persisted:false},{qaFlag:'BLOCKED'},{analysisStatus:'FAILED'},{analysisCutoff:new Date(now+1).toISOString()},{evidence:{...snapshot.evidence,game:{...game,status:'final'}}}])assert.equal(run(input,{...snapshot,...patch}).ok,false);
assert.equal(run(input,snapshot,now+180000).ok,false);assert.equal(run(input,snapshot,now+3600000).ok,false);
assert.equal(run(input,{...snapshot,prediction:{...distribution('FT'),trainedThrough:at}}).ok,false);
// Execute shipped hooks with controlled fetch to test real submit/race guards.
const source=fs.readFileSync('app/soccer/manual-simulation-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const built=await transform(source,{filename:'manual-simulation.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const nodes=x=>Array.isArray(x)?x.flatMap(nodes):x&&typeof x==='object'?[x,...nodes(x.props?.children)]:[];
const text=x=>Array.isArray(x)?x.map(text).join(''):x&&typeof x==='object'?text(x.props?.children):String(x??'');
function harness(){let cursor=0,dirty=false,tree,props={result:snapshot,game};const hooks=[],effects=[],calls=[],timers=new Set();
 class Clock extends Date{static now(){return now;}}
 const context=vm.createContext({React,Date:Clock,AbortController,setTimeout:fn=>{timers.add(fn);return fn;},clearTimeout:fn=>timers.delete(fn),
 useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=initial;return[hooks[i],v=>{hooks[i]=typeof v==='function'?v(hooks[i]):v;dirty=true;}];},
 useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},
 useEffect:(fn,deps)=>{const i=cursor++,previous=hooks[i];if(previous&&deps.every((v,j)=>v===previous.deps[j]))return;hooks[i]={deps};effects.push(()=>{previous?.cleanup?.();hooks[i].cleanup=fn();});},
 fetch:(url,options)=>new Promise(resolve=>calls.push({url,options,reply:value=>resolve({ok:value.ok,status:value.ok?200:422,json:async()=>value})}))});
 vm.runInContext(built.code,context);
 const render=(next=props)=>{props=next;let count=0;do{cursor=0;dirty=false;tree=context.SoccerManualSimulation(props);effects.splice(0).forEach(f=>f());assert.ok(++count<10);}while(dirty);return tree;};
 const change=(name,value)=>{const label=nodes(tree).find(n=>n.type==='label'&&text(n.props.children).startsWith(name));nodes(label).find(n=>n.type==='input'||n.type==='select').props.onChange({target:{value}});render();};
 return{render,calls,timers,change,submit:()=>nodes(tree).find(n=>n.type==='form').props.onSubmit({preventDefault(){}}),markup:()=>renderToStaticMarkup(tree),unmount:()=>hooks.forEach(h=>h?.cleanup?.())};
}
const h=harness();h.render();h.change('試算球頭','1.5');h.change('試算水位','0.9');const first=h.submit();h.submit();assert.equal(h.calls.length,1,'rapid double submits cannot create overlapping requests');h.render();assert.match(h.markup(),/試算中/);
const req=h.calls[0];assert.equal(req.url,'/api/soccer/simulation');assert.equal(req.options.method,'POST');const actual=JSON.parse(req.options.body);assert.deepEqual(actual,input);req.reply(run(actual));await first;h.render();assert.match(h.markup(),/\+15\.00%/);assert.match(h.markup(),/帳號適用條款尚未確認/);assert.match(h.markup(),/尚無正式 W／R／S/);assert.equal(h.timers.size,0);
h.change('試算球頭','2.5');assert.doesNotMatch(h.markup(),/\+15\.00%/,'editing an input clears the previous calculation');
const forged=h.submit();h.calls[1].reply({...run(JSON.parse(h.calls[1].options.body)),S:9});await forged;h.render();assert.doesNotMatch(h.markup(),/\+15\.00%/);assert.match(h.markup(),/回應的原分析、輸入或範圍不符/);
const pending=h.submit();h.render({result:{...snapshot,revision:'c'.repeat(64)},game});assert.equal(h.calls[2].options.signal.aborted,true);h.calls[2].reply(run());await pending;h.render();assert.doesNotMatch(h.markup(),/\+15\.00%/,'late replies cannot attach to a different model revision');h.unmount();
console.log('PASS manual conditional simulation: eight directions, exact fractional 1% rebate and push arithmetic, fresh immutable pregame model only, no approval/Reader/bet writes, actual JSX fetch/mutation/race/abort guards');
// Execute the actual route with a controlled immutable-store read. Authentication,
// origin checks, request budgets and body validation use production helpers.
const security=await import('../lib/security.js');
const {validSoccerAnalysisQuery}=await import('../lib/soccer/analysis-service.js');
const {NextResponse}=await import('next/server.js');
const routeSource=fs.readFileSync('app/api/soccer/simulation/route.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export /g,'');
let reads=0;
const routeContext=vm.createContext({...security,NextResponse,validSoccerAnalysisQuery,validSoccerSimulationInput,
 simulateSoccerManualQuote:args=>simulateSoccerManualQuote({...args,now}),loadSoccerAnalysisRevision:async(league,id,date,revision)=>{reads++;assert.deepEqual([league,id,date,revision],['epl',game.id,game.date,snapshot.revision]);return structuredClone(snapshot);}});
vm.runInContext(routeSource,routeContext);
const originalEnv={APP_PASSWORD:process.env.APP_PASSWORD,SESSION_SECRET:process.env.SESSION_SECRET};
try{
 process.env.APP_PASSWORD='synthetic-local-test-only';process.env.SESSION_SECRET='synthetic-local-session-signature-not-a-user-credential';
 const url='https://app.fixture.invalid/api/soccer/simulation';
 const noAuth=await routeContext.POST(new Request(url,{method:'POST',body:JSON.stringify(input)}));assert.equal(noAuth.status,401);assert.equal(reads,0);
 const token=await security.createSessionToken();const headers={cookie:`mlb_session=${token}`,origin:'https://app.fixture.invalid','content-type':'application/json'};
 const wrongOrigin=await routeContext.POST(new Request(url,{method:'POST',headers:{...headers,origin:'https://other.fixture.invalid'},body:JSON.stringify(input)}));assert.equal(wrongOrigin.status,403);assert.equal(reads,0);
 const invalid=await routeContext.POST(new Request(url,{method:'POST',headers,body:JSON.stringify({...input,approved:true})}));assert.equal(invalid.status,400);assert.equal(reads,0);
 const malformed=await routeContext.POST(new Request(url,{method:'POST',headers,body:'{'}));assert.equal(malformed.status,400);assert.equal(reads,0);
 const tooLarge=await routeContext.POST(new Request(url,{method:'POST',headers,body:JSON.stringify({...input,note:'x'.repeat(3000)})}));assert.equal(tooLarge.status,413);assert.equal(reads,0);
 const valid=await routeContext.POST(new Request(url,{method:'POST',headers,body:JSON.stringify(input)}));assert.equal(valid.status,200);assert.equal(reads,1);const body=await valid.json();assert.ok(Math.abs(body.netReturnBounds.lower-.15)<1e-12);assert.equal(body.S,null);assert.equal(body.inputSource,'USER_HYPOTHESIS');assert.equal(valid.headers.get('cache-control'),'no-store');
}finally{for(const [k,v]of Object.entries(originalEnv))if(v===undefined)delete process.env[k];else process.env[k]=v;}
console.log('PASS actual simulation POST: authentication/CSRF, body shape/size, immutable scoped DB read, numeric response with no-store and no formal S');
