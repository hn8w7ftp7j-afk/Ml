import { soccerTeamLabel } from '../lib/soccer/team-labels.js';
import assert from 'node:assert/strict';
import { candidateFixture } from './helpers/soccer-candidate-fixture.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerHighScoreCandidates, summarizeSoccerHighScoreBets } from '../lib/soccer/league-bet-status.js';
import { soccerRecordKey, soccerRecordStats } from '../lib/soccer/manual-record.js';
import { soccerMarketName } from '../lib/soccer/ranking.js';

const now=Date.now(),date='2026-10-20',league='epl';
const game={id:'soccer:epl:123',sourceId:'123',league,date,status:'scheduled',startTime:new Date(now+86400000).toISOString(),home:{sourceId:'359'},away:{sourceId:'364'}};
const quote=period=>({key:`${period}-total-over`,period,kind:'TOTAL',side:'over',line:'3+50',lineSide:null,water:.95,unit:'GOALS',fresh:true,prestart:true,provenance:{gameId:game.id,observedAt:new Date(now).toISOString()}});
const result=candidateFixture({gameId:game.id,league,date,publishedCurrent:true,persisted:true,analysisStatus:'COMPLETED',observedAt:new Date(now).toISOString(),evidence:{game},formalScoringEnabled:true,qualification:{eligible:true},directions:['FT','HT'].map(period=>({period,direction:'TOTAL_OVER',eligible:true,qaFlag:'PASS',score:8,W:2,R:1,quotes:[quote(period)]}))},now);
const states={[game.id]:{status:'done',data:result}};
const report=soccerHighScoreCandidates([game],states,{league,date,now});
assert.equal(report.analysisReady,true);assert.equal(report.candidates.length,2);
const records=report.candidates.map((entry,i)=>({...entry.quote,league,date,gameId:game.id,id:`record-${i}`,status:'OPEN',stake:10000}));
const summary=(rows=records,extra={})=>summarizeSoccerHighScoreBets(report.candidates,{records:rows,league,date,ledgerReady:true,analysisReady:true,...extra});
assert.equal(summary().state,'all_bet');assert.equal(summary().league,'EPL');assert.equal(summary().date,date);
assert.equal(summary([records[0]]).unbet,1,'a full-time record cannot cover the half-time candidate');
assert.equal(summary(records.map((r,i)=>i?{...r,status:'CANCELLED'}:r)).state,'unbet');
assert.equal(summary(records.map(r=>({...r,status:'OPEN'}))).state,'all_bet');
for(const mutate of [r=>({...r,league:'ucl'}),r=>({...r,date:'2026-10-21'}),r=>({...r,side:'under'}),r=>({...r,line:'2+50'})])assert.equal(summary(records.map(mutate)).unbet,2);
assert.equal(summary(records,{ledgerReady:false}).state,'pending');
assert.equal(summary(records,{analysisReady:false}).state,'analysis_pending');
assert.equal(soccerHighScoreCandidates([game],{}, {league,date,now}).analysisReady,false,'unloaded analysis must not publish an empty confirmed summary');
assert.equal(soccerHighScoreCandidates([game],{[game.id]:{status:'loading',data:result}}, {league,date,now}).analysisReady,false);
assert.equal(soccerHighScoreCandidates([game],{[game.id]:{status:'error',data:result}}, {league,date,now}).analysisReady,false);
assert.equal(soccerHighScoreCandidates([game],states, {league,date,now,analysisReady:false}).analysisReady,false);
const research=soccerHighScoreCandidates([game],{[game.id]:{status:'done',data:{...result,formalScoringEnabled:false}}},{league,date,now});
assert.equal(research.candidates.length,0,'injected research scores cannot become candidates');
assert.equal(summarizeSoccerHighScoreBets(research.candidates,{league,date,ledgerReady:true,analysisReady:true}).state,'none');
assert.equal(soccerHighScoreCandidates([game],states,{league,date:'2026-10-21',now}).candidates.length,0,'upcoming games on other dates cannot populate this board reminder');
assert.equal(soccerHighScoreCandidates([game],states,{league:'ucl',date,now}).candidates.length,0);
assert.equal(soccerHighScoreCandidates([game],states,{league,date,now:now+180000}).analysisReady,false,'expired current research cannot keep the previous all-bet summary');
const tomorrow='2026-10-21',nextGame={...game,id:'soccer:epl:124',sourceId:'124',date:tomorrow,startTime:new Date(now+26*3600000).toISOString()};
const nextResult=candidateFixture({gameId:nextGame.id,league,date:tomorrow,publishedCurrent:true,persisted:true,analysisStatus:'COMPLETED',observedAt:new Date(now).toISOString(),evidence:{game:nextGame},formalScoringEnabled:true,qualification:{eligible:true},directions:['FT','HT'].map(period=>({period,direction:'TOTAL_OVER',eligible:true,qaFlag:'PASS',score:8,W:2,R:1,quotes:[{...quote(period),key:`next-${period}`,provenance:{gameId:nextGame.id,observedAt:new Date(now).toISOString()}}]}))},now);
const crossGames=[game,nextGame],crossStates={...states,[nextGame.id]:{status:'done',data:nextResult}};
const crossReport=soccerHighScoreCandidates(crossGames,crossStates,{league,date,through:tomorrow,now});
assert.equal(crossReport.candidates.length,4,'a cross-midnight board includes qualified candidates on both Taiwan dates');
assert.equal(crossReport.analysisReady,true);
assert.equal(soccerHighScoreCandidates(crossGames,states,{league,date,through:tomorrow,now}).analysisReady,false,'missing tomorrow analysis cannot claim a complete range');
assert.equal(soccerHighScoreCandidates(crossGames,crossStates,{league,date,now}).candidates.length,2,'single-day callers retain their exact scope');
const nextRecords=crossReport.candidates.filter(entry=>entry.game.date===tomorrow).map((entry,i)=>({...entry.quote,league,date:tomorrow,gameId:nextGame.id,id:`next-record-${i}`,status:'OPEN',stake:10000}));
const crossSummary=(rows,extra={})=>summarizeSoccerHighScoreBets(crossReport.candidates,{records:rows,league,date,through:tomorrow,ledgerReady:true,analysisReady:true,...extra});
assert.equal(crossSummary(records).unbet,2,'today records cannot conceal tomorrow unrecorded candidates');
assert.equal(crossSummary([...records,...nextRecords]).state,'all_bet');
assert.equal(crossSummary([...records,...nextRecords.map(record=>({...record,date}))]).unbet,2,'range summaries still require each record actual date');
assert.equal(crossSummary([...records,...nextRecords.map(record=>({...record,league:'ucl'}))]).unbet,2,'range summaries never mix leagues');
assert.equal(crossSummary([...records,{...nextRecords[0],status:'CANCELLED'},nextRecords[1]]).unbet,1);
console.log('PASS soccer card summary with mocked synthetic schedule authority: ranking candidates, research exclusion, exact date/league/FT/HT/side/line isolation, unloaded/failed/expired analysis, pending ledger, cancel and restore');

const workspaceSource=fs.readFileSync('app/soccer/workspace.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export default function|export function/g,'function');
const workspaceCode=await transform(workspaceSource,{filename:'soccer-card-workspace.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const workspaceContext=vm.createContext({React,Date,soccerTeamLabel,soccerHighScoreCandidates,SoccerRecordProvider:()=>null,useEffect:()=>{},useState:value=>[typeof value==='function'?value():value,()=>{}]});
vm.runInContext(workspaceCode.code,workspaceContext);
const onStatus=()=>{};
const workspaceTree=workspaceContext.SoccerWorkspace({games:[game],states,run:()=>{},league,date,onHighScoreStatusChange:onStatus,children:[]});
assert.equal(workspaceTree.props.onHighScoreStatusChange,onStatus);assert.equal(workspaceTree.props.summaryDate,date);assert.equal(workspaceTree.props.candidates.length,2);
const notLoaded=workspaceContext.SoccerWorkspace({games:[game],states:{},run:()=>{},league,date,onHighScoreStatusChange:onStatus,children:[]});
assert.equal(notLoaded.props.analysisReady,false);
const crossWorkspace=workspaceContext.SoccerWorkspace({games:crossGames,states:crossStates,run:()=>{},league,date,onHighScoreStatusChange:onStatus,children:[]});
assert.equal(crossWorkspace.props.through,tomorrow);assert.equal(crossWorkspace.props.candidates.length,4);
assert.deepEqual(Array.from(crossWorkspace.props.dates),[date,tomorrow]);
console.log('PASS shipped soccer workspace passes exact-date ranking candidates, source readiness and callback into the record provider');

// Run the shipped record provider hooks so callbacks follow actual durable
// record/cancel/restore responses and cannot reuse another scope's ready flag.
const source=fs.readFileSync('app/soccer/bet-records.js','utf8').replace(/^import .*?;\n/gm,'').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'soccer-card-records.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
let cursor=0,hooks=[],effects=[],dirty=false,tree;
const requests=[],updates=[];
let props={league,date,candidates:report.candidates,analysisReady:true,onHighScoreStatusChange:value=>updates.push(value),children:[]};
const context=vm.createContext({React,Date,soccerTeamLabel,URLSearchParams,AbortSignal,soccerRecordKey,soccerRecordStats,soccerMarketName,summarizeSoccerHighScoreBets,
  createContext:()=>({Provider:'provider'}),
  useState:initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=typeof initial==='function'?initial():initial;return[hooks[i],value=>{hooks[i]=typeof value==='function'?value(hooks[i]):value;dirty=true;}];},
  useRef:initial=>{const i=cursor++;return hooks[i]??={current:initial};},
  useEffect:(effect,deps)=>{const i=cursor++,previous=hooks[i];if(previous?.deps&&deps.every((value,j)=>Object.is(value,previous.deps[j])))return;hooks[i]={deps};effects.push(()=>{previous?.cleanup?.();hooks[i].cleanup=effect();});},
  fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),
});
vm.runInContext(code,context);
const render=()=>{cursor=0;dirty=false;tree=context.SoccerRecordProvider(props);const pending=effects;effects=[];pending.forEach(effect=>effect());};
const flush=async()=>{for(let i=0;i<20;i++){await Promise.resolve();if(dirty)render();}assert.equal(dirty,false);};
const ledger=()=>tree.props.value;
const respond=async(recordRequest,value)=>{recordRequest.resolve({ok:true,json:async()=>value});await flush();};
const readBody=rows=>({ok:true,league:props.league,date:props.date,through:props.through||props.date,records:rows});
render();await flush();assert.equal(updates.at(-1).state,'pending');
await respond(requests.shift(),readBody([]));assert.equal(updates.at(-1).unbet,2);
async function write(record){const flight=ledger().mutate({action:'record',gameId:game.id},soccerRecordKey(record));await flush();await respond(requests.shift(),{ok:true,persistence:'durable_database',record});await flight;await flush();}
await write(records[0]);assert.equal(updates.at(-1).unbet,1);
await write(records[1]);assert.equal(updates.at(-1).state,'all_bet');
await write({...records[0],status:'CANCELLED'});assert.equal(updates.at(-1).state,'unbet');
await write({...records[0],status:'OPEN'});assert.equal(updates.at(-1).state,'all_bet');
const count=updates.length;render();await flush();assert.equal(updates.length,count,'unchanged summaries do not trigger parent render loops');
props={...props,analysisReady:false};render();await flush();assert.equal(updates.at(-1).state,'analysis_pending');
props={...props,analysisReady:true,date:'2026-10-21',candidates:report.candidates.map(entry=>({...entry,game:{...entry.game,date:'2026-10-21'}}))};
render();await flush();assert.equal(updates.at(-1).date,'2026-10-21');assert.equal(updates.at(-1).state,'pending');assert.equal(ledger().records.length,0);
await respond(requests.shift(),readBody([]));assert.equal(updates.at(-1).state,'unbet');
props={...props,league:'ucl',candidates:[]};render();await flush();await respond(requests.shift(),readBody([]));
assert.equal(updates.at(-1).league,'UCL');assert.equal(updates.at(-1).state,'none');
props={...props,league,date,through:tomorrow,candidates:crossReport.candidates};
render();await flush();assert.equal(updates.at(-1).state,'pending');
const crossRead=requests.shift();assert.equal(new URL(crossRead.url,'https://fixture.invalid').searchParams.get('through'),tomorrow);
await respond(crossRead,readBody(records));assert.equal(updates.at(-1).total,4);assert.equal(updates.at(-1).unbet,2);
const nextWrite=ledger().mutate({action:'record',date:tomorrow,gameId:nextGame.id},soccerRecordKey(nextRecords[0]));await flush();
const crossPost=requests.shift();assert.equal(JSON.parse(crossPost.options.body).date,tomorrow);
await respond(crossPost,{ok:true,persistence:'durable_database',record:nextRecords[0]});await nextWrite;await flush();
assert.equal(updates.at(-1).unbet,1,'recording the next-date selection refreshes the combined reminder');
const farDate='2026-12-03',farCandidates=crossReport.candidates.filter(entry=>entry.game.date===tomorrow).map(entry=>({...entry,stableKey:`far:${entry.stableKey}`,game:{...entry.game,date:farDate}}));
const farRecords=nextRecords.map(record=>({...record,date:farDate}));
props={...props,through:farDate,dates:[date,farDate],candidates:[...report.candidates,...farCandidates]};
render();await flush();assert.equal(ledger().status,'loading');
assert.equal(requests.length,2,'sparse distant game dates need only two bounded ledger reads');
const sparseReads=requests.splice(0);
assert.deepEqual(sparseReads.map(call=>{const q=new URL(call.url,'https://fixture.invalid').searchParams;return[q.get('date'),q.get('through')];}),[[date,date],[farDate,farDate]]);
await respond(sparseReads[0],{ok:true,league,date,through:date,records});assert.equal(ledger().status,'loading','partial ledger coverage cannot publish all-bet');
await respond(sparseReads[1],{ok:true,league,date:farDate,through:farDate,records:farRecords});
assert.equal(ledger().status,'ready');assert.equal(updates.at(-1).state,'all_bet');assert.equal(updates.at(-1).total,4);
hooks.forEach(hook=>hook?.cleanup?.());
console.log('PASS shipped soccer record hooks: durable record/cancel/restore callbacks, deduplicated publications, pending analysis, immediate date-scope fence and uppercase league isolation');
