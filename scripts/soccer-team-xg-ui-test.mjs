import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { createHash } from 'node:crypto';
import { normalizeSoccerTeamXg,SOCCER_TEAM_XG_SOURCE_URL } from '../lib/soccer/team-xg.js';

const source=fs.readFileSync('app/soccer/team-xg-panel.js','utf8').replace(/export function/g,'function');
const {code}=await transform(source,{filename:'soccer-team-xg-panel.jsx',jsc:{parser:{syntax:'ecmascript',jsx:true},transform:{react:{runtime:'classic'}}}});
const readTime=Date.parse('2026-11-02T00:00:00Z');
class ReadClock extends Date{static now(){return readTime;}}
const context=vm.createContext({React,Date:ReadClock});vm.runInContext(code,context);
const game={id:'soccer:epl:401878769',sourceId:'401878769',league:'epl',date:'2026-10-31',startTime:'2026-10-31T12:30:00Z',home:{sourceId:'363',name:'切爾西'},away:{sourceId:'360',name:'曼聯'}};
const competition={id:'2kwbbcootiqqgmrzs6o5inle5',code:'EPL',name:'Premier League',tournamentCalendarId:'6pdwluctev9iebv00r4qqukno'};
const updated='2026-10-28T21:00:00Z',requested='2026-10-28T22:00:00Z',fetched='2026-10-28T22:00:01Z',available=fetched;
const url='https://theanalyst.com/competition/premier-league/table?view=expected';
function fixture(){return{
 ok:true,version:'SOCCER-OPTA-TEAM-XG-v1',status:'PROVIDER_REPORTED',league:'epl',gameId:game.id,date:game.date,startTime:game.startTime,
 season:'2026/2027',competition:{...competition},teams:{home:{sourceId:'363',optaId:'chelsea-opta',name:'Chelsea',played:8,xg:10.3,xga:11.4,xgPerMatch:10.3/8,xgaPerMatch:11.4/8},away:{sourceId:'360',optaId:'manutd-opta',name:'Manchester United',played:8,xg:23.4,xga:13.7,xgPerMatch:23.4/8,xgaPerMatch:13.7/8}},
 source:{provider:'OPTA_ANALYST',url,contentHash:'a'.repeat(64),requestedAt:requested,fetchedAt:fetched,availableAt:available,sourcePublishedAt:null,sourceUpdatedAt:updated,scope:{league:'epl',gameId:game.id,field:'season-team-xg'},independentlyConfirmed:false,historicalAvailabilityVerified:false},
 sourceEvidence:{version:'SOCCER-OPTA-TEAM-XG-v1',sourceScopeVerified:true,contentHashVerified:true,fetchTimeVerified:true,observedAvailabilityVerified:true,competitionVerified:true,seasonVerified:true,teamIdentityVerified:true,sourcePublishedAt:null,sourceUpdatedAt:updated,publicationStatus:'MISSING',publishedAvailabilityVerified:false,historicalAvailabilityVerified:false,independentlyConfirmed:false},
 coverage:{type:'SEASON_CUMULATIVE_TEAM_TOTALS',teamCount:20,currentTableOnly:true,completeSeason:false,matchLevel:false,halfTime:false,nonPenaltyXg:false,shotQuality:false,personnel:false,independentlyVerified:false,rounding:'PROVIDER_DISPLAY_1_DECIMAL'},
 modelEffectApplied:false,pointInTimeAvailabilityVerified:false,formalEligible:false,executable:false,
 sourceDocumentArchive:{version:'SOCCER-TEAM-XG-SOURCE-ARCHIVE-v1',status:'ARCHIVED',persisted:true,receiptId:'b'.repeat(64),representation:'DECODED_HTML_TEXT_DOCUMENT',serialization:'UTF8_DECODED_HTTP_RESPONSE_TEXT',hashAlgorithm:'SHA256',provider:'OPTA_ANALYST',league:'epl',gameId:game.id,date:game.date,season:'2026/2027',competition:{...competition},teamIds:{home:'363',away:'360'},sourceUrl:url,contentHash:'a'.repeat(64),documentBytes:12345,fetchedAt:fetched,availableAt:available,sourcePublishedAt:null,sourceUpdatedAt:updated,kickoffAt:game.startTime,recordedAt:'2026-10-28T22:00:03Z',documentRecordedAt:'2026-10-28T22:00:03Z',timingStatus:'PREGAME_DATABASE_RECEIPT',prematchReceipt:true,decodedDocumentHashRecomputed:true,rawSourceHashRecomputed:false,historicalAvailabilityVerified:false,independentlyConfirmed:false,formalEligible:false},
};}
const render=(value,target=game)=>renderToStaticMarkup(React.createElement(context.SoccerTeamXgPanel,{value,game:target}));
const valid=render(fixture());assert.match(valid,/球隊 xG／xGA/);assert.match(valid,/2026\/2027 英超/);assert.match(valid,/來源表的球隊累計/);assert.match(valid,/本表已賽場次/);assert.match(valid,/主隊｜切爾西/);assert.match(valid,/客隊｜曼聯/);
assert.match(valid,/<td>8<\/td><td>10\.30<\/td><td>11\.40<\/td><td>1\.29<\/td><td>1\.43<\/td>/);
assert.match(valid,/<td>8<\/td><td>23\.40<\/td><td>13\.70<\/td><td>2\.92<\/td><td>1\.71<\/td>/);
assert.match(valid,/十二碼是否納入此統計，來源口徑尚未完整核對/);assert.match(valid,/不是 npxG/);
assert.match(valid,/不是本場全場、上半場或逐次射門品質資料/);assert.match(valid,/尚未用於模型擬合或調整本場機率/);assert.match(valid,/正式評分尚未驗收/);
assert.match(valid,new RegExp(`href="${url.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}"`));assert.match(valid,/來源更新：2026\/10\/29/);assert.match(valid,/已核對保存（開賽前）/);

for(const mutate of [
 v=>{v.gameId='soccer:epl:1';},v=>{v.league='ucl';},v=>{v.date='2026-11-01';},v=>{v.startTime='2026-10-31T13:30:00Z';},v=>{v.season='2025/2026';},
 v=>{v.competition.id='other';},v=>{v.competition.tournamentCalendarId='old';},v=>{v.teams.home.sourceId='999';},v=>{v.teams.away.sourceId=v.teams.home.sourceId;},
 v=>{v.source.url='https://evil.example/competition/premier-league/table?view=expected';},v=>{v.source.url='javascript:alert(1)';},v=>{v.source.contentHash='invalid';},
 v=>{v.source.scope.gameId='soccer:epl:2';},v=>{v.source.scope.field='match-xg';},
 v=>{delete v.source.fetchedAt;},v=>{delete v.source.availableAt;},v=>{delete v.source.requestedAt;},v=>{v.source.availableAt=requested;},v=>{v.source.sourceUpdatedAt='2026-10-29T00:00:00Z';},
 v=>{v.source.requestedAt=new Date(readTime+1000).toISOString();v.source.fetchedAt=new Date(readTime+2000).toISOString();v.source.availableAt=new Date(readTime+3000).toISOString();},
 v=>{v.source.sourceUpdatedAt='2026-10-28T22:00:01.500Z';v.sourceEvidence.sourceUpdatedAt=v.source.sourceUpdatedAt;},
 v=>{v.sourceEvidence.fetchTimeVerified=false;},v=>{delete v.sourceEvidence;},v=>{v.coverage.type='MATCH_TOTALS';},v=>{v.coverage.halfTime=true;},
 v=>{v.coverage.teamCount=36;},v=>{v.coverage.currentTableOnly=false;},
 v=>{v.teams.home.xg=null;},v=>{v.teams.home.played=-1;},v=>{v.teams.home.xgPerMatch=99;},v=>{v.modelEffectApplied=true;},v=>{v.formalEligible=true;},v=>{v.executable=true;},
]){
 const value=fixture();mutate(value);const html=render(value);assert.doesNotMatch(html,/<table|10\.30|23\.40|href=/,'wrong game/league/time/source/coverage/usage evidence cannot supply numeric rows or source links');assert.match(html,/尚未完整核對/);
}
for(const invalidGame of [{...game,league:'ucl'},{...game,id:'soccer:epl:2'},{...game,date:20261031},{...game,home:{...game.home,sourceId:'999'}},null])assert.doesNotMatch(render(fixture(),invalidGame),/<table|10\.30/);

const missingUpdated=fixture();missingUpdated.source.sourceUpdatedAt=null;missingUpdated.sourceEvidence.sourceUpdatedAt=null;missingUpdated.sourceDocumentArchive.sourceUpdatedAt=null;
const ownUpdateUnknown=render(missingUpdated);assert.match(ownUpdateUnknown,/<td>10\.30/);assert.match(ownUpdateUnknown,/來源更新：來源未提供/,'fetch time never fills the provider own-update time');
const zero=fixture();zero.teams.home={...zero.teams.home,played:0,xg:0,xga:0,xgPerMatch:null,xgaPerMatch:null};
assert.match(render(zero),/<td>0<\/td><td>0\.00<\/td><td>0\.00<\/td><td>未知<\/td><td>未知<\/td>/,'genuine reported zeros remain distinct from missing per-game denominators');
const playedZero=fixture();playedZero.teams.home={...playedZero.teams.home,xg:0,xgPerMatch:0};assert.match(render(playedZero),/<td>8<\/td><td>0\.00<\/td><td>11\.40<\/td><td>0\.00/);

for(const mutate of [
 r=>{r.gameId='soccer:epl:2';},r=>{r.league='ucl';},r=>{r.date='2026-11-01';},r=>{r.season='2025/2026';},r=>{r.teamIds.home='999';},r=>{r.competition.id='other';},r=>{r.sourceUrl='https://evil.example/';},
 r=>{r.contentHash='c'.repeat(64);},r=>{r.fetchedAt=requested;},r=>{r.sourceUpdatedAt=null;},r=>{delete r.recordedAt;},r=>{r.recordedAt=requested;},r=>{r.documentRecordedAt='2026-11-01T00:00:00Z';},
 r=>{r.prematchReceipt=false;},r=>{r.timingStatus='AFTER_KICKOFF_DATABASE_RECEIPT';},r=>{r.decodedDocumentHashRecomputed=false;},r=>{r.formalEligible=true;},
 r=>{r.documentBytes=2097153;},r=>{r.recordedAt=new Date(readTime+1000).toISOString();r.prematchReceipt=false;r.timingStatus='AFTER_KICKOFF_DATABASE_RECEIPT';},
]){
 const value=fixture();mutate(value.sourceDocumentArchive);const html=render(value);assert.match(html,/<td>10\.30/,'a bad archive receipt does not change separately verified provider observations');assert.match(html,/憑據與本次來源或賽事不符/);assert.doesNotMatch(html,/已核對保存/,'unbound or inconsistent DB receipts never claim verified archival');
}
const after=fixture();after.sourceDocumentArchive.recordedAt='2026-10-31T12:31:00Z';after.sourceDocumentArchive.documentRecordedAt='2026-10-31T12:31:00Z';after.sourceDocumentArchive.prematchReceipt=false;after.sourceDocumentArchive.timingStatus='AFTER_KICKOFF_DATABASE_RECEIPT';
assert.match(render(after),/已核對保存（開賽後）/,'later database receipts cannot be displayed as pregame availability');
const noArchive=fixture();delete noArchive.sourceDocumentArchive;assert.match(render(noArchive),/資料庫封存：尚未取得憑據/);assert.doesNotMatch(render(noArchive),/已核對保存/);
const failedArchive=fixture();failedArchive.sourceDocumentArchive={version:'SOCCER-TEAM-XG-SOURCE-ARCHIVE-v1',status:'UNAVAILABLE',persisted:false};assert.match(render(failedArchive),/資料庫封存：本次尚未確認保存/);

const uclUrl='https://theanalyst.com/competition/uefa-champions-league/table';
const uclCompetition={id:'4oogyu6o156iphvdvphwpck10',code:'UCL',name:'Champions League',tournamentCalendarId:'99jev9kv55deht65t6myggxlg'};
const uclGame={...game,id:'soccer:ucl:123',sourceId:'123',league:'ucl',home:{sourceId:'86',name:'皇家馬德里'},away:{sourceId:'364',name:'利物浦'}};
function uclFixture(){const value=fixture();Object.assign(value,{league:'ucl',gameId:uclGame.id,competition:{...uclCompetition}});
 value.teams.home={...value.teams.home,sourceId:'86',optaId:'real-madrid-opta',name:'Real Madrid'};value.teams.away={...value.teams.away,sourceId:'364',optaId:'liverpool-opta',name:'Liverpool'};
 value.source={...value.source,url:uclUrl,scope:{league:'ucl',gameId:uclGame.id,field:'season-team-xg'}};value.coverage.teamCount=36;
 value.sourceDocumentArchive={...value.sourceDocumentArchive,league:'ucl',gameId:uclGame.id,competition:{...uclCompetition},teamIds:{home:'86',away:'364'},sourceUrl:uclUrl};return value;
}
const ucl=render(uclFixture(),uclGame);assert.match(ucl,/2026\/2027 歐冠/);assert.match(ucl,/本表已賽場次/);assert.match(ucl,/主隊｜皇家馬德里/);assert.match(ucl,/客隊｜利物浦/);assert.match(ucl,/10\.30/);
assert.match(ucl,/賽事階段與資格賽覆蓋範圍尚未完整確認/);assert.match(ucl,/不視為整個賽季所有場次/);assert.match(ucl,/已核對保存（開賽前）/);assert.match(ucl,RegExp(`href="${uclUrl}"`));assert.doesNotMatch(ucl,/英超|球隊本季累計/);
for(const mutate of [v=>{v.coverage.teamCount=20;},v=>{v.competition={...competition};},v=>{v.source.url=url;},v=>{v.source.url=`${uclUrl}?view=expected`;},v=>{v.source.scope.league='epl';},v=>{v.teams.home.sourceId='363';}]){
 const value=uclFixture();mutate(value);assert.doesNotMatch(render(value,uclGame),/<table|10\.30|href=/,'UCL cannot borrow EPL scope, team counts, URLs or identities');
}
for(const mutate of [r=>{r.sourceUrl=url;},r=>{r.competition={...competition};},r=>{r.league='epl';}]){
 const value=uclFixture();mutate(value.sourceDocumentArchive);const html=render(value,uclGame);assert.match(html,/憑據與本次來源或賽事不符/);assert.doesNotMatch(html,/已核對保存/);
}
assert.doesNotMatch(render(uclFixture(),game),/<table|10\.30|href=/);assert.doesNotMatch(render(fixture(),uclGame),/<table|10\.30|href=/,'EPL/UCL observations cannot cross their current game scope');
for(const value of [null,undefined,{ok:false,status:'UNKNOWN',code:'SOCCER_TEAM_XG_UNAVAILABLE'},{ok:false,status:'UNKNOWN',code:'SOCCER_TEAM_XG_LEAGUE_UNSUPPORTED'}]){
 const html=render(value);assert.doesNotMatch(html,/<table|<td>|0\.00|href=/);assert.match(html,/尚未取得|數值未知|尚無適用/);
}
const escapedGame={...game,home:{...game.home,name:'<script>alert("x")</script>'}};assert.match(render(fixture(),escapedGame),/&lt;script&gt;/);assert.doesNotMatch(render(fixture(),escapedGame),/<script>/);

// Retained real provider rows go through the shipped adapter before the shipped
// JSX. These supplied test transport times do not claim original fetch or PIT
// evidence; the reduced provider-state fixture provenance records that limit.
const htmlCarrier=fs.readFileSync('scripts/fixtures/soccer/opta-epl-20261028.html','utf8');
const adapterGame={...game,status:'scheduled',home:{id:'soccer:epl:team:363',sourceId:'363',name:'Chelsea'},away:{id:'soccer:epl:team:360',sourceId:'360',name:'Manchester United'}};
const normalized=normalizeSoccerTeamXg(htmlCarrier,adapterGame,{provider:'OPTA_ANALYST',url:SOCCER_TEAM_XG_SOURCE_URL,contentHash:createHash('sha256').update(htmlCarrier).digest('hex'),requestedAt:requested,fetchedAt:fetched,availableAt:fetched},Date.parse(fetched)+1000);
assert.equal(normalized.ok,true);const actualRows=render(normalized,adapterGame);assert.match(actualRows,/主隊｜Chelsea/);assert.match(actualRows,/客隊｜Manchester United/);assert.match(actualRows,/<td>10\.30<\/td><td>11\.40/);assert.match(actualRows,/<td>12\.80<\/td><td>12\.00/);
assert.match(actualRows,/來源更新：2026\/10\/28/);assert.match(actualRows,/資料庫封存：尚未取得憑據/);assert.doesNotMatch(actualRows,/已核對保存/);
const uclCarrier=fs.readFileSync('scripts/fixtures/soccer/opta-ucl-20261028.html','utf8'),uclAsOf='2026-10-28T23:00:00Z';
const actualUclGame={id:'soccer:ucl:4019',sourceId:'4019',league:'ucl',date:'2026-11-01',startTime:'2026-11-01T12:30:00.000Z',status:'scheduled',home:{sourceId:'2572',id:'soccer:ucl:team:2572',name:'Como'},away:{sourceId:'360',id:'soccer:ucl:team:360',name:'Manchester United'}};
const normalizedUcl=normalizeSoccerTeamXg(uclCarrier,actualUclGame,{provider:'OPTA_ANALYST',url:uclUrl,contentHash:createHash('sha256').update(uclCarrier).digest('hex'),requestedAt:uclAsOf,fetchedAt:uclAsOf,availableAt:uclAsOf},Date.parse(uclAsOf));
assert.equal(normalizedUcl.ok,true);const actualUclRows=render(normalizedUcl,actualUclGame);assert.match(actualUclRows,/2026\/2027 歐冠/);assert.match(actualUclRows,/主隊｜Como/);assert.match(actualUclRows,/<td>3<\/td><td>6\.40<\/td><td>3\.00/);assert.match(actualUclRows,/<td>3<\/td><td>5\.70<\/td><td>4\.40/);
assert.match(actualUclRows,/賽事階段與資格賽覆蓋範圍尚未完整確認/);assert.match(actualUclRows,/正式評分尚未驗收/);assert.match(actualUclRows,/資料庫封存：尚未取得憑據/);assert.doesNotMatch(actualUclRows,/英超|整季完整|已核對保存/);
assert.doesNotMatch(render(normalizedUcl,adapterGame),/<table|6\.40|href=/);assert.doesNotMatch(render(normalized,actualUclGame),/<table|10\.30|href=/);
console.log('PASS actual EPL/UCL team-xG JSX: retained provider rows through real normalizer, strict league/game/season/team/time/source/count binding, current-table scope, own-update unknown, genuine zeros, no model effect, exact safe source links, DB receipt mismatch/unknown/postgame and unavailable legacy states');
