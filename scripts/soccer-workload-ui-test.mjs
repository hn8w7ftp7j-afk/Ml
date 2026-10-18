import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { normalizeSoccerPlayerWorkload } from '../lib/soccer/player-workload.js';

// Execute the shipped JSX rather than reproducing its presentation logic.
const file='app/soccer/workload-panel.js';
const source=fs.readFileSync(file,'utf8').replace(/export function/g,'function');
const {code}=await transform(source,{filename:file.replace(/\.js$/,'.jsx'),jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const context=vm.createContext({React,Date});
vm.runInContext(code,context);
const render=workload=>renderToStaticMarkup(React.createElement(context.SoccerWorkloadPanel,{workload}));
const player=(id,name,extra={})=>({id,name,regulationClockMinutesLast7Days:90,regulationClockMinutesLast14Days:270,appearancesLast7Days:1,appearancesLast14Days:3,startsLast7Days:1,startsLast14Days:3,rosterMatchesObservedLast7Days:1,rosterMatchesObservedLast14Days:3,...extra});
const referenceAt='2026-10-19T00:00:00Z';
const verifiedSource={provider:'ESPN',url:'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=123',fetchedAt:'2026-10-18T23:55:00Z',contentHash:'fixture'};
const partial={ok:true,status:'OBSERVED_PARTIAL',referenceAt,players:[
  player('1','Observed Starter'),
  player('2','Observed Unused Bench',{regulationClockMinutesLast7Days:0,regulationClockMinutesLast14Days:0,appearancesLast7Days:0,appearancesLast14Days:0,startsLast7Days:0,startsLast14Days:0}),
  player('3','Only Earlier Roster',{regulationClockMinutesLast7Days:0,appearancesLast7Days:0,startsLast7Days:0,rosterMatchesObservedLast7Days:0,regulationClockMinutesLast14Days:65}),
  player('4','Unverified Values',{regulationClockMinutesLast7Days:null,regulationClockMinutesLast14Days:null,appearancesLast7Days:null,appearancesLast14Days:null,startsLast7Days:null,startsLast14Days:null}),
  player('5','Added Time Appearance',{regulationClockMinutesLast7Days:0,regulationClockMinutesLast14Days:0,appearancesLast7Days:1,appearancesLast14Days:1,startsLast7Days:0,startsLast14Days:0}),
],matches:[{eventId:'123',startTime:'2026-10-16T19:00:00Z',competition:{name:'Premier League'},players:[{id:'1'},{id:'2'}],source:verifiedSource}],omissions:[
  {eventId:'124',reason:'SOCCER_SOURCE_TIMEOUT',source:{provider:'ESPN',fetchedAt:'2026-10-18T23:56:00Z',url:'https://example.invalid/timeout'}},
  {eventId:'125',reason:'SOCCER_PLAYER_MATCH_LIMIT'},
  {eventId:'126',reason:'SOCCER_PLAYER_EXTRA_TIME_UNVERIFIED'},
],coverage:{complete:false,verifiedMatches:1,verifiedMatchesLast7Days:1,verifiedMatchesLast14Days:1,candidateMatches:4},modelEffectApplied:false,executable:false};
const team={ok:true,completedMatchesLast7Days:2,completedMatchesLast14Days:4,lastKnownCompleted:{startTime:'2026-10-16T19:00:00Z',opponent:{name:'Fixture Opponent'}},kickoffGapHoursFromLastCompleted:74.5,scheduledBeforeTarget:[{eventId:'future-before'}],scheduledAhead:[{eventId:'future',startTime:'2026-10-22T19:00:00Z',competition:{name:'Champions League'},opponent:{name:'Planned Opponent'}}],playerWorkload:partial};
assert.equal(render(null),'','A legacy snapshot without workload has no invented observations');
const markup=render({teams:{home:team,away:{ok:false,playerWorkload:{ok:false,status:'UNAVAILABLE',players:[],matches:[],omissions:[],coverage:{complete:false}}}}});
assert.match(markup,/近7日已知完賽 2 場；近14日 4 場/);
assert.match(markup,/Fixture Opponent/);
assert.match(markup,/74\.5 小時，並非實際休息時長/);
assert.match(markup,/本場前另有 1 場已公布賽程/);
assert.match(markup,/Champions League/);
assert.match(markup,/Planned Opponent/);
assert.match(markup,/近14日已核對 1／4 場/);
assert.match(markup,/僅計已核對場次，覆蓋尚未確認完整/);
assert.match(markup,/<td>Observed Starter<\/td><td>90<\/td><td>270<\/td><td>1／1<\/td><td>3／3<\/td>/);
assert.match(markup,/<td>Observed Unused Bench<\/td><td>0<\/td><td>0<\/td><td>0／0<\/td><td>0／0<\/td>/,'A known unused bench observation may be zero within the observed subset');
assert.match(markup,/<td>Only Earlier Roster<\/td><td>未知<\/td><td>65<\/td><td>未知<\/td>/,'No seven-day roster observation must not become a known seven-day zero');
assert.match(markup,/<td>Unverified Values<\/td><td>未知<\/td><td>未知<\/td><td>未知／未知<\/td><td>未知／未知<\/td>/,'Missing minutes or counts must not become zero');
assert.match(markup,/<td>Added Time Appearance<\/td><td>0<\/td><td>0<\/td><td>1／0<\/td><td>1／0<\/td>/,'Zero regulation-clock minutes can coexist with an added-time appearance');
assert.match(markup,/正規時鐘，不含補時或加時賽/);
assert.match(markup,/本場預估上場分鐘尚未提供/);
assert.match(markup,/尚未直接加減進球機率/);
assert.match(markup,/球員近期上場分鐘未知/);
assert.match(markup,/跨賽事資料暫時不足；不推定為充分休息/);
assert.match(markup,/逐場來源與未納入項目/);
assert.match(markup,/Premier League｜已核對名單 2 人/);
assert.match(markup,/href="https:\/\/site\.api\.espn\.com\/apis\/site\/v2\/sports\/soccer\/eng\.1\/summary\?event=123"/);
assert.match(markup,/另有 3 場未納入分鐘統計，不能視為球員休息/);
assert.match(markup,/場次 124：本次讀取逾時/);
assert.match(markup,/場次 125：超出本次逐場核對範圍/);
assert.match(markup,/場次 126：此場包含加時賽/);
assert.doesNotMatch(markup,/undefined|NaN|SOCCER_SOURCE_TIMEOUT|已完整覆蓋/);

const legacy=render({teams:{home:{...team,playerWorkload:undefined},away:{ok:false}}});
assert.match(legacy,/近7日已知完賽 2 場/);
assert.match(legacy,/球員近期上場分鐘未知/);
assert.doesNotMatch(legacy,/Observed Starter|<table/);
const failed=render({teams:{home:{...team,playerWorkload:{...partial,ok:false,status:'UNAVAILABLE'}},away:null}});
assert.doesNotMatch(failed,/Observed Starter/,'An unavailable player observation must not render stale numeric rows as verified');
const untrusted=render({teams:{home:{...team,playerWorkload:{...partial,matches:[{eventId:'777',startTime:'bad',source:{url:'javascript:alert(1)'}}]}}}});
assert.doesNotMatch(untrusted,/href="javascript:|Invalid Date|NaN|undefined/);

// Also render actual normalized repository-captured player observations.
const captured=JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/minutes-past.json',import.meta.url)));
const at=Date.parse('2025-01-02T12:00:00Z');
const record={eventId:'704467',startTime:'2025-01-01T17:30Z',competition:{id:'700',slug:'eng.1',name:'English Premier League'},homeAway:'away',opponent:{sourceId:'337'},status:'COMPLETED',extraTimeReported:false};
const teamObserved={ok:true,sourceId:'359',asOf:new Date(at-1000).toISOString(),referenceAt:new Date(at).toISOString(),recentCompleted:[record]};
const observed=normalizeSoccerPlayerWorkload(teamObserved,[{ok:true,data:captured,record,source:{provider:'ESPN',url:'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=704467',fetchedAt:new Date(at-500).toISOString(),contentHash:createHash('sha256').update(JSON.stringify(captured)).digest('hex')}}],{asOf:at});
assert.equal(observed.ok,true);
const capturedMarkup=render({teams:{home:{...team,playerWorkload:observed},away:{ok:false}}});
assert.match(capturedMarkup,/<td>Mikel Merino<\/td><td>77\.6<\/td><td>77\.6<\/td><td>1／1<\/td><td>1／1<\/td>/);
assert.match(capturedMarkup,/<td>Oleksandr Zinchenko<\/td><td>0<\/td><td>0<\/td><td>1／0<\/td><td>1／0<\/td>/);
assert.match(capturedMarkup,/<td>Neto<\/td><td>0<\/td><td>0<\/td><td>0／0<\/td><td>0／0<\/td>/);
console.log('PASS shipped workload JSX: fixture observations retained, verified-subset player minutes and appearances, seven-day unknown vs known zero, added-time zero-minute appearance, partial coverage, per-match provenance, omissions and legacy unavailable states');
