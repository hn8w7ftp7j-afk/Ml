import * as soccerReadiness from '../lib/soccer/scoring-readiness.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import * as soccerBackgroundClient from '../lib/soccer/background-client.js';
import { soccerQuoteScorePresentation } from '../lib/soccer/score-presentation.js';

// Compile the shipped child components in isolated lexical scopes. Rendering
// the parent must execute the real JSX, including legacy/missing-data paths.
const realComponentCode=(await Promise.all([
  ['app/soccer/market-panel.js',['SoccerMarketDirections','SoccerHalfTimeResearch']],
  ['app/soccer/workload-panel.js',['SoccerWorkloadPanel']],
].map(async([file,exports])=>{
  const source=fs.readFileSync(file,'utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
  const compiled=await transform(source,{filename:file.replace(/\.js$/,'.jsx'),jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
  return `Object.assign(globalThis,(()=>{${compiled.code};return {${exports.join(',')}};})());`;
}))).join('\n');

const raw=fs.readFileSync('app/soccer/analysis-panel.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function/g,'function').replace(/export function/g,'function');
const {code}=await transform(raw,{filename:'soccer-analysis.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const nodes=v=>Array.isArray(v)?v.flatMap(nodes):v&&typeof v==='object'?[v,...nodes(v.props?.children)]:[];
const label=v=>Array.isArray(v)?v.map(label).join(''):v&&typeof v==='object'?label(v.props?.children):v==null||typeof v==='boolean'?'':String(v);
const game=i=>({id:`soccer:epl:${i}`,sourceId:String(i),league:'epl',date:'2026-10-20',startTime:'2099-10-20T13:00:00Z',status:'scheduled',home:{name:'Home'},away:{name:'Away'}}),games=[game(1),game(2),game(3)];
function harness(fetch,{boardFetch=null}={}){
 const state=[],refs=[],effects=[],intervals=new Map(),cleanups=[],listeners=new Map();let si=0,ri=0,tree,intervalId=0;
 const document={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const window={addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 const ctx=vm.createContext({...soccerReadiness,...soccerBackgroundClient,soccerQuoteScorePresentation,React,Date,URLSearchParams,AbortController,AbortSignal,setTimeout,clearTimeout,fetch:(url,options)=>{
   if(url.startsWith('/api/soccer/analysis?')&&!new URL(url,'https://fixture.invalid').searchParams.has('view')){if(boardFetch)return boardFetch(url,options);return new Promise((_resolve,reject)=>options.signal?.addEventListener('abort',()=>reject(Object.assign(Error('aborted'),{name:'AbortError'})),{once:true}));}
   return fetch(url,options);
  },SoccerWorkspace:({children})=>children,SoccerRecordButton:()=>null,
  document,window,setInterval:(fn,delay)=>{intervals.set(++intervalId,{fn,delay});return intervalId;},clearInterval:id=>intervals.delete(id),
  createContext:()=>({Provider:'provider'}),useContext:()=>({states:state[0],run:ctx.provider().props.value.run}),
  useState:initial=>{const i=si++;if(!(i in state))state[i]=initial;return[state[i],v=>{state[i]=typeof v==='function'?v(state[i]):v;}];},
  useRef:initial=>refs[ri++]|| (refs[ri-1]={current:initial}),useEffect:fn=>effects.push(fn)});
 vm.runInContext(realComponentCode,ctx);
 vm.runInContext(code,ctx);
 ctx.provider=()=>{si=0;ri=0;tree=ctx.SoccerAnalysisProvider({games,children:[]});return tree;};
 const provider=()=>ctx.provider();const renderPanel=g=>{si=3;return ctx.SoccerAnalysisPanel({game:g});};
 return{ctx,state,provider,renderPanel,document,readerChanged:detail=>listeners.get('soccer:reader-content-changed')?.({detail}),runEffects:()=>{for(const effect of effects.splice(0))cleanups.push(effect());},tick:()=>{for(const timer of intervals.values())timer.fn();},metadataTick:()=>{for(const timer of intervals.values())if(timer.delay===1000)timer.fn();},visible:()=>listeners.get('visibilitychange')?.(),cleanup:()=>{for(const cleanup of cleanups)cleanup?.();}};
}
const pending=[];let requests=0,active=0,maxActive=0;
const h=harness(async(_url,options)=>{requests++;active++;maxActive=Math.max(maxActive,active);const input=JSON.parse(options.body);return await new Promise(resolve=>pending.push(()=>{active--;resolve(Response.json({ok:true,gameId:`soccer:epl:${input.eventId}`,league:'epl',date:input.date,formalScoringEnabled:false,executable:false,directions:Array.from({length:8},()=>({executable:false,eligible:false})),persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',qaFlag:'WARN',evidence:{teams:{}},status:'RESEARCH_ONLY'}));}));});
let tree=h.provider();assert.equal(requests,0,'Opening a board cannot automatically run analysis');
const value=tree.props.value,a=value.run(games[0]),b=value.run(games[1]),c=value.run(games[2]);
assert.equal(value.run(games[0]),a,'Repeated clicks cannot duplicate a queued/inflight request');assert.equal(requests,2);assert.equal(h.state[0][games[2].id].status,'queued');
pending.shift()();await a;await new Promise(r=>setImmediate(r));assert.equal(requests,3);pending.shift()();pending.shift()();await Promise.all([b,c]);assert.equal(maxActive,2);assert.equal(Object.values(h.state[0]).filter(s=>s.status==='done').length,3);
const bad=harness(async()=>Response.json({ok:true,gameId:'soccer:ucl:1',league:'ucl',date:games[0].date,executable:false,formalScoringEnabled:false,directions:Array.from({length:8},()=>({executable:false,eligible:false}))}));
await bad.provider().props.value.run(games[0]);assert.equal(bad.state[0][games[0].id].status,'error');assert.match(bad.state[0][games[0].id].error,/身分/);
const failed=harness(async()=>Response.json({ok:false,error:'temporary source error'},{status:503}));await failed.provider().props.value.run(games[0]);assert.equal(failed.state[0][games[0].id].status,'error');assert.equal(nodes(failed.renderPanel(games[0])).find(x=>x.type==='button').props.disabled,false,'failure releases the retry button');
console.log('PASS shipped soccer JSX: manual-only entry, bounded two-request queue, duplicate-click suppression, independent game receipts, wrong-league rejection and retry unlock');

// Render the shipped result JSX with real provider evidence and both legacy/new snapshots.
const {normalizeSoccerPrematch}=await import('../lib/soccer/prematch.js'),{normalizeSoccerSchedule}=await import('../lib/soccer/data.js'),{buildSoccerAnalysis}=await import('../lib/soccer/analysis.js');
const payload=JSON.parse(fs.readFileSync('scripts/fixtures/soccer/minutes-past.json')),comp=payload.header.competitions[0],at='2026-10-18T14:50:00Z',source={provider:'ESPN',fetchedAt:at,url:'https://fixture.invalid',contentHash:'fixture'};
const realGame=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:comp.date,status:comp.status}]},'epl',source).games[0],evidence=normalizeSoccerPrematch(payload,realGame,source,Date.parse(at)),result=buildSoccerAnalysis({evidence,now:Date.parse(at)});
h.state[0][realGame.id]={status:'done',data:{...result,persisted:true}};const rendered=h.renderPanel(realGame),text=renderToStaticMarkup(rendered);
assert.match(text,/正規時鐘上場分鐘/);assert.match(text,/補時登場/);assert.match(text,/逐年滾動研究檢查/);assert.match(text,/原盤結算核對表/);assert.match(text,/尚無已配對原盤/);assert.doesNotMatch(text,/undefined|NaN/);
console.log('PASS actual result JSX: postgame normalized minutes, stoppage-only player, rolling evidence, missing quotes and legacy optional fields render without invented values');

const {soccerProviderPolicy}=await import('../lib/soccer/provider-policy.js');
const {TAIWAN_CREDIT_REBATE_RATE}=await import('../lib/taiwan-settlement-v9.js');
const footballPolicy=soccerProviderPolicy({asOf:'2026-10-19T00:00:00Z'});
assert.equal(footballPolicy.rebateRate,.01);assert.equal(TAIWAN_CREDIT_REBATE_RATE,.015,'football display must not change existing non-football credit rebate');
const liveSnapshot={...result,persisted:true,publishedCurrent:true,analysisStatus:'COMPLETED',selectionResult:'RESEARCH_SHADOW',providerPolicy:footballPolicy,
  halfTimePrediction:{homeRate:.65,awayRate:.4,outcomes:{home:.4,draw:.45,away:.15}},halfTimeResearch:{reasons:['HALF_TIME_MODEL_UNVERIFIED']},
  evidence:{...result.evidence,workload:{teams:{home:{ok:true,completedMatchesLast7Days:2,completedMatchesLast14Days:4,kickoffGapHoursFromLastCompleted:74.5,lastKnownCompleted:{startTime:'2026-10-16T19:00:00Z',opponent:{name:'Fixture Opponent'}},scheduledAhead:[]},away:{ok:false}}}},
  directions:result.directions.map((d,i)=>({...d,quotes:i===2?[{key:'ft-over',period:'FT',line:'2-50',water:'0.9',rawRows:['大2-50 0.9','小0.8'],thresholdProbabilities:{axis:'TOTAL_GOALS',boundary:2,above:.42,equal:.27,below:.31,retainedMass:1,tailMass:0}}]:[]})),
  unassignedQuotes:[{key:'unknown-period',period:null,line:'1+25',water:'0.88',rawRows:['主隊1+25 0.88']}],
};
h.state[0][realGame.id]={status:'done',data:liveSnapshot};
const liveMarkup=renderToStaticMarkup(h.renderPanel(realGame));
assert.match(liveMarkup,/足球退水：1%（0.01）/);assert.doesNotMatch(liveMarkup,/足球退水：1\.5|足球退水：2%/);
assert.match(liveMarkup,/按投注金額計算；適用條件與結算條款待核對/);
const rateOnlySnapshot={...liveSnapshot,providerPolicy:soccerProviderPolicy({asOf:'2026-10-18T22:15:30.999Z'})};
h.state[0][realGame.id]={status:'done',data:rateOnlySnapshot};
const rateOnlyMarkup=renderToStaticMarkup(h.renderPanel(realGame));
assert.match(rateOnlyMarkup,/計算基數與結算條款待核對/);assert.doesNotMatch(rateOnlyMarkup,/按投注金額計算/);
h.state[0][realGame.id]={status:'done',data:liveSnapshot};
assert.match(liveMarkup,/八方向與實際原盤/);assert.match(liveMarkup,/球頭 <strong>2-50/);assert.match(liveMarkup,/42.0%/);
assert.ok(liveMarkup.indexOf('soccerMarketDirections')<liveMarkup.indexOf('soccerProbabilityResearch'),`S score cards precede research probabilities: ${liveMarkup.indexOf('soccerMarketDirections')} / ${liveMarkup.indexOf('soccerProbabilityResearch')}`);
assert.match(liveMarkup,/<details class="soccerDetails soccerProbabilityResearch"><summary>比分與勝平負研究（不是 S 分數）/,'research probabilities are separate collapsed details, not the main score');
assert.match(liveMarkup,/期間待確認，暫不計算/);assert.match(liveMarkup,/上半場比分研究/);assert.match(liveMarkup,/40.0%/);
assert.match(liveMarkup,/跨賽事賽程與近期負荷/);assert.match(liveMarkup,/近7日已知完賽 2 場/);assert.match(liveMarkup,/74.5 小時/);assert.match(liveMarkup,/跨賽事資料暫時不足/);
const legacySnapshot={...result,evidence:{...result.evidence}};
for(const key of ['providerPolicy','halfTimePrediction','halfTimeResearch','unassignedQuotes'])delete legacySnapshot[key];
delete legacySnapshot.evidence.workload;
legacySnapshot.directions=legacySnapshot.directions.map(({quotes,...direction})=>direction);
h.state[0][realGame.id]={status:'done',data:legacySnapshot};
const legacyMarkup=renderToStaticMarkup(h.renderPanel(realGame));
assert.match(legacyMarkup,/缺少此方向可確認期間的原盤/);assert.doesNotMatch(legacyMarkup,/足球退水：|跨賽事賽程與近期負荷|undefined|NaN/);
console.log('PASS integrated shipped components: real market/half-time/workload JSX, legacy optional fields, explicit football 1% rate and isolated 1.5% existing credit rate');

// An old POST success is historical evidence, not a perpetual current badge.
const uiStart=Date.now();let uiNow=uiStart;
const receipt={analysisRunId:'ui-run',revision:'ui-revision',publishedCurrent:true,reason:'ACTIVE',checkedAt:new Date(uiStart).toISOString(),validUntil:new Date(uiStart+60000).toISOString(),formalScoringEnabled:false,executable:false};
const currentState={status:'done',data:{...liveSnapshot,observedAt:new Date(uiStart).toISOString(),analysisRunId:receipt.analysisRunId,revision:receipt.revision,currentResearch:receipt},currentResearch:receipt,currentResearchRequestedAt:uiStart,currentResearchReceivedAt:uiStart};
h.ctx.Date=class extends Date{static now(){return uiNow;}};
h.state[0][realGame.id]=currentState;
assert.equal(h.ctx.soccerAnalysisPresentation(currentState,uiStart).current,true);
assert.match(renderToStaticMarkup(h.renderPanel(realGame)),/分析：<strong>完成/);
uiNow=uiStart+60000;
assert.equal(h.ctx.soccerAnalysisPresentation(currentState,uiNow).current,false,'expiry invalidates the display without a new analysis');
const expiredMarkup=renderToStaticMarkup(h.renderPanel(realGame));assert.match(expiredMarkup,/待重新核對/);assert.match(expiredMarkup,/僅供歷史查閱/);assert.match(expiredMarkup,/上半場比分研究/,'expiry preserves the result for historical reading');
assert.equal(h.ctx.soccerAnalysisPresentation({...currentState,currentResearch:{...receipt,revision:'newer-revision'}},uiStart).current,false);
assert.equal(h.ctx.soccerAnalysisPresentation({...currentState,currentResearch:{...receipt,analysisRunId:'newer-run'}},uiStart).current,false);
assert.equal(h.ctx.soccerAnalysisPresentation({...currentState,currentResearch:null},uiStart).current,false,'a failed read cannot fall back to the old POST flag');
const cardResult=()=>nodes(h.renderPanel(realGame)).find(node=>node.type===h.ctx.SoccerMarketDirections).props.result;
uiNow=uiStart;h.state[0][realGame.id]={...currentState,currentResearch:null};
assert.equal(cardResult().publishedCurrent,false,'score cards inherit the latest failed receipt, not the stale embedded ACTIVE receipt');
h.state[0][realGame.id]={...currentState,currentResearch:{...receipt,publishedCurrent:false,reason:'QUOTE_CHANGED'}};
assert.equal(cardResult().publishedCurrent,false,'Reader invalidation revokes a current-looking S card');
assert.equal(currentState.data.publishedCurrent,true,'presentation overlays cannot mutate the immutable saved result');
h.state[0][realGame.id]=currentState;
assert.equal(h.ctx.soccerAnalysisPresentation({status:'done',data:liveSnapshot},uiStart).current,false,'legacy snapshots without current evidence remain readable but unverified');
assert.equal(h.ctx.soccerAnalysisPresentation(currentState,uiStart+45001).current,false,'a stalled status feed cannot keep a current badge alive indefinitely');
const nearExpiry={...currentState,currentResearch:{...receipt,validUntil:new Date(uiStart+5000).toISOString()},currentResearchReceivedAt:uiStart+6000};
assert.equal(h.ctx.soccerAnalysisPresentation(nearExpiry,uiStart+6000).current,false,'a six-second delayed response cannot revive a five-second server lifetime');
const offsetClock={...currentState,data:{...currentState.data,observedAt:new Date(uiStart-3600000).toISOString()},currentResearch:{...receipt,checkedAt:new Date(uiStart-3600000).toISOString(),validUntil:new Date(uiStart-3600000+5000).toISOString()}};
assert.equal(h.ctx.soccerAnalysisPresentation(offsetClock,uiStart+1000).current,true,'absolute client/server clock offset does not invalidate fresh evidence');

const clockOnly=harness(async()=>{throw Error('clock boundary must not launch a full analysis');});clockOnly.ctx.Date=class extends Date{static now(){return uiNow;}};
uiNow=uiStart;clockOnly.provider();clockOnly.runEffects();clockOnly.state[0][realGame.id]={...currentState,currentResearch:{...receipt,validUntil:new Date(uiStart+5000).toISOString()}};clockOnly.provider();
uiNow+=4999;clockOnly.tick();assert.equal(clockOnly.state[2],0,'unchanged currentness does not redraw all match tables');
uiNow++;clockOnly.tick();assert.equal(clockOnly.state[2],1,'crossing the actual deadline triggers one redraw');clockOnly.provider();uiNow++;clockOnly.tick();assert.equal(clockOnly.state[2],1,'an already expired badge does not redraw each second');clockOnly.cleanup();

// Execute the shipped polling effect with a controlled clock. It only reads
// lightweight status, stays bounded at two requests, and never reruns analysis.
uiNow=uiStart;let pollRequests=0,pollActive=0,pollMax=0;const statusResolvers=[];
const polling=harness(async(url,options)=>{assert.equal(options.method,undefined,'polling is read-only');assert.match(url,/view=current/);pollRequests++;pollActive++;pollMax=Math.max(pollMax,pollActive);
  const params=new URL(url,'https://fixture.invalid').searchParams,id=params.get('eventId');
  return new Promise(resolve=>statusResolvers.push(()=>{pollActive--;resolve(Response.json({ok:true,gameId:`soccer:epl:${id}`,league:'epl',date:params.get('date'),currentResearch:{...receipt,analysisRunId:`ui-run-${id}`,revision:`ui-revision-${id}`,publishedCurrent:false,reason:'QUOTE_CHANGED'}}));}));
});
polling.ctx.Date=class extends Date{static now(){return uiNow;}};
polling.provider();polling.runEffects();
for(const g of games){const status={...receipt,analysisRunId:`ui-run-${g.sourceId}`,revision:`ui-revision-${g.sourceId}`};polling.state[0][g.id]={status:'done',data:{analysisStatus:'COMPLETED',analysisRunId:status.analysisRunId,revision:status.revision,publishedCurrent:true},currentResearch:status,currentResearchRequestedAt:uiStart,currentResearchReceivedAt:uiStart};}
polling.provider();uiNow+=29999;polling.tick();assert.equal(pollRequests,0);
uiNow++;polling.tick();assert.equal(pollRequests,2);assert.equal(pollMax,2);
// A newer analysis response arrives while an older status read is in flight.
const newerState={...polling.state[0][games[0].id],data:{...polling.state[0][games[0].id].data,analysisRunId:'replacement-run',revision:'replacement-revision'},currentResearch:{...receipt,analysisRunId:'replacement-run',revision:'replacement-revision'}};
polling.state[0][games[0].id]=newerState;polling.provider();
statusResolvers.shift()();await new Promise(resolve=>setImmediate(resolve));assert.equal(pollRequests,3);
statusResolvers.shift()();statusResolvers.shift()();await new Promise(resolve=>setImmediate(resolve));
assert.equal(polling.state[0][games[0].id].currentResearch.analysisRunId,'replacement-run','a late old status response cannot overwrite the newer analysis receipt');
assert.equal(polling.ctx.soccerAnalysisPresentation(polling.state[0][games[1].id],uiNow).current,false,'quote invalidation reaches the old result state');
assert.equal(polling.state[0][games[1].id].data.revision,'ui-revision-2','status refresh does not overwrite the saved analysis');
polling.document.visibilityState='hidden';uiNow+=30000;polling.tick();assert.equal(pollRequests,3,'hidden pages do not poll');polling.cleanup();
uiNow=uiStart;let scopedReads=0;const scopedResolvers=[];
const scoped=harness(async(url,options)=>{assert.equal(options.method,undefined);assert.match(url,/view=current/);scopedReads++;return new Promise(resolve=>scopedResolvers.push(status=>resolve(Response.json({ok:true,league:'epl',date:games[0].date,gameId:games[0].id,currentResearch:status}))));});
scoped.ctx.Date=class extends Date{static now(){return uiNow;}};scoped.provider();scoped.runEffects();
const scopedReceipt={...receipt,analysisRunId:'scoped-run',revision:'scoped-revision'};
const scopedData={analysisStatus:'COMPLETED',analysisRunId:scopedReceipt.analysisRunId,revision:scopedReceipt.revision,publishedCurrent:true};
scoped.state[0][games[0].id]={status:'done',data:scopedData,currentResearch:scopedReceipt,currentResearchRequestedAt:uiStart,currentResearchReceivedAt:uiStart};scoped.provider();
uiNow+=30000;scoped.tick();assert.equal(scopedReads,1);
for(const detail of [{league:'ucl',date:games[0].date,contentHash:'b'.repeat(64)},{league:'epl',date:'2026-10-21',contentHash:'b'.repeat(64)},{league:'epl',date:games[0].date,contentHash:'invalid'}])scoped.readerChanged(detail);
assert.equal(scoped.state[0][games[0].id].currentResearch.revision,scopedReceipt.revision,'other leagues, dates and invalid events do not revoke this scope');
scoped.readerChanged({league:'epl',date:games[0].date,contentHash:'b'.repeat(64)});
assert.equal(scoped.state[0][games[0].id].currentResearch,null,'Reader change immediately removes the old current badge');
scopedResolvers.shift()(scopedReceipt);await new Promise(resolve=>setImmediate(resolve));
assert.equal(scoped.state[0][games[0].id].currentResearch,null,'the in-flight old receipt cannot undo Reader invalidation');assert.equal(scopedReads,2,'one replacement status read follows an invalidated in-flight read');
scopedResolvers.shift()({...scopedReceipt,publishedCurrent:false,reason:'QUOTE_CHANGED'});await new Promise(resolve=>setImmediate(resolve));
assert.equal(scoped.state[0][games[0].id].data,scopedData,'Reader invalidation preserves the original result object');scoped.cleanup();

// Hold the actual POST response across a Reader content change. Both a first
// analysis (no prior data) and a refresh must save the result only as historical.
for(const refresh of [false,true]){
  uiNow=uiStart;let releasePost,postReads=0,lightReads=0;
  const postReceipt={...receipt,analysisRunId:`delayed-post-${refresh}`,revision:`delayed-revision-${refresh}`};
  const postBody={...liveSnapshot,evidence:{...liveSnapshot.evidence,game:{...liveSnapshot.evidence.game,id:games[0].id,sourceId:games[0].sourceId,league:games[0].league,date:games[0].date}},gameId:games[0].id,league:games[0].league,date:games[0].date,analysisRunId:postReceipt.analysisRunId,revision:postReceipt.revision,currentResearch:postReceipt,publishedCurrent:true};
  const delayedPost=harness(async(url,options)=>{
    if(options.method==='POST'){postReads++;return new Promise(resolve=>{releasePost=()=>resolve(Response.json(postBody));});}
    lightReads++;assert.match(url,/view=current/);return Response.json({ok:true,gameId:games[0].id,league:games[0].league,date:games[0].date,currentResearch:{...postReceipt,publishedCurrent:false,reason:'QUOTE_CHANGED'}});
  });
  delayedPost.ctx.Date=class extends Date{static now(){return uiNow;}};let provider=delayedPost.provider();delayedPost.runEffects();
  if(refresh){delayedPost.state[0][games[0].id]={...currentState,data:{...liveSnapshot,analysisRunId:'old-data-run',revision:'old-data-revision'}};provider=delayedPost.provider();}
  const pendingPost=provider.props.value.run(games[0]);delayedPost.provider();
  assert.equal(delayedPost.state[0][games[0].id].status,'loading');assert.equal(Boolean(delayedPost.state[0][games[0].id].data),refresh);
  delayedPost.readerChanged({league:'epl',date:games[0].date,contentHash:'c'.repeat(64)});
  uiNow++;releasePost();await pendingPost;await new Promise(resolve=>setImmediate(resolve));
  const historicalPost=delayedPost.state[0][games[0].id];
  assert.equal(historicalPost.currentResearch,null,`a held ${refresh?'refresh':'first-ever'} POST cannot revive the old active receipt`);
  assert.equal(historicalPost.data.revision,postReceipt.revision,'the full completed result is retained for history');
  assert.equal(delayedPost.ctx.soccerAnalysisPresentation(historicalPost,uiNow).current,false);
  assert.match(renderToStaticMarkup(delayedPost.renderPanel(games[0])),/僅供歷史查閱/);
  delayedPost.provider();uiNow+=1000;delayedPost.tick();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(lightReads,1,'a fenced POST schedules a lightweight read on the next metadata tick');assert.equal(postReads,1,'rechecking never reruns analysis');
  assert.equal(delayedPost.state[0][games[0].id].currentResearch.publishedCurrent,false);delayedPost.cleanup();
}
console.log('PASS current research JSX and effects: expiry, quote/run mismatch, unknown legacy status, retained history, bounded read-only polling and hidden-page pause');

// The main workspace restores saved results on refresh. A board receipt is not
// the lightweight fenced status receipt used by cards or workspace rankings.
const {buildSoccerRanking}=await import('../lib/soccer/ranking.js');
uiNow=uiStart;let releaseBoard,currentReads=0,activeSource=true;
const restoreReceipt={...receipt,analysisRunId:'restored-run',revision:'restored-revision'};
const rankedQuote={key:'restored-quote',period:'FT',kind:'TOTAL',unit:'GOALS',side:'over',line:'2-50',water:.9,fresh:true,prestart:true,provenance:{gameId:games[0].id,observedAt:new Date(uiStart).toISOString()}};
const boardResult={...liveSnapshot,evidence:{...liveSnapshot.evidence,game:{...liveSnapshot.evidence.game,id:games[0].id,sourceId:games[0].sourceId,league:games[0].league,date:games[0].date}},gameId:games[0].id,league:'epl',date:games[0].date,observedAt:new Date(uiStart).toISOString(),analysisRunId:restoreReceipt.analysisRunId,revision:restoreReceipt.revision,publishedCurrent:true,directions:liveSnapshot.directions.map((d,i)=>({...d,quotes:i===2?[rankedQuote]:[]}))};
const boardBody={ok:true,league:'epl',date:games[0].date,gameId:games[0].id,versions:[boardResult],runs:[],currentVersion:null,currentRun:null};
const emptyHead=url=>{const q=new URL(url,'https://fixture.invalid').searchParams;return{ok:true,gameId:`soccer:${q.get('league')}:${q.get('eventId')}`,league:q.get('league'),date:q.get('date'),versions:[],runs:[],currentVersion:null,currentRun:null};};
const restoring=harness(async(url,options)=>{assert.equal(options.method,undefined);assert.match(url,/view=current/);currentReads++;return Response.json({ok:true,gameId:games[0].id,league:'epl',date:games[0].date,currentResearch:{...restoreReceipt,publishedCurrent:activeSource,reason:activeSource?'ACTIVE':'QUOTE_CHANGED'}});},{boardFetch:url=>new URL(url,'https://fixture.invalid').searchParams.get('eventId')===games[0].sourceId?new Promise(resolve=>{releaseBoard=value=>resolve(Response.json(value));}):Promise.resolve(Response.json(emptyHead(url)))});
restoring.ctx.Date=class extends Date{static now(){return uiNow;}};restoring.provider();restoring.runEffects();
releaseBoard(boardBody);await new Promise(resolve=>setImmediate(resolve));
assert.equal(restoring.state[0][games[0].id].data.revision,boardResult.revision,'refresh restores the persisted result');
assert.equal(restoring.state[0][games[0].id].currentResearch,null,'board publishedCurrent does not create a new current receipt');
const workspaceNode=tree=>nodes(tree).find(node=>node.type===restoring.ctx.SoccerWorkspace);
let workspace=workspaceNode(restoring.provider());assert.equal(workspace.props.states[games[0].id].data.publishedCurrent,false);
assert.equal(buildSoccerRanking(games,workspace.props.states,{now:uiNow}).entries.length,0,'workspace ranking cannot bypass missing current evidence');
restoring.metadataTick();await new Promise(resolve=>setImmediate(resolve));assert.equal(currentReads,1,'restored history schedules a lightweight current read');
workspace=workspaceNode(restoring.provider());assert.equal(workspace.props.states[games[0].id].data.publishedCurrent,true);
assert.equal(buildSoccerRanking(games,workspace.props.states,{now:uiNow}).entries.length,0,'a fenced restored research quote does not enter candidate rankings');
assert.equal(workspace.props.states[games[0].id].data.directions[2].quotes[0].key,rankedQuote.key,'ranking filtering preserves restored research quotes');
assert.match(renderToStaticMarkup(restoring.renderPanel(games[0])),/2-50/,'the restored original research market remains readable in analysis results');
activeSource=false;restoring.readerChanged({league:'epl',date:games[0].date,contentHash:'d'.repeat(64)});
workspace=workspaceNode(restoring.provider());assert.equal(workspace.props.states[games[0].id].data.publishedCurrent,false);
assert.equal(boardResult.publishedCurrent,true,'workspace safety and recovery do not mutate the original saved response');
assert.equal(restoring.state[0][games[0].id].data.revision,boardResult.revision,'invalidation keeps the restored historical revision');
await new Promise(resolve=>setImmediate(resolve));restoring.cleanup();

for(const existingStatus of ['loading','queued','error','done']){
  let releaseLate;
  const lateBoard=harness(async()=>{throw Error('no analysis or status expected');},{boardFetch:url=>new URL(url,'https://fixture.invalid').searchParams.get('eventId')===games[0].sourceId?new Promise(resolve=>{releaseLate=value=>resolve(Response.json(value));}):Promise.resolve(Response.json(emptyHead(url)))});
  lateBoard.provider();lateBoard.runEffects();
  const newer={status:existingStatus,data:{...boardResult,revision:'newer-version',observedAt:new Date(uiStart+1000).toISOString()},currentResearch:null};
  lateBoard.state[0][games[0].id]=newer;
  releaseLate(boardBody);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(lateBoard.state[0][games[0].id],newer,`a late board response cannot overwrite ${existingStatus} analysis or its invalidation state`);lateBoard.cleanup();
}
console.log('PASS main workspace merge: saved board restoration, fenced status recheck, ranking/card currentness agreement and late-board vs local-analysis isolation');
