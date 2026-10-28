import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {soccerSqlFixture} from './helpers/soccer-sql-fixture.mjs';
import {normalizeSoccerSchedule} from '../lib/soccer/data.js';
import {normalizeSoccerPrematch} from '../lib/soccer/prematch.js';
import {fetchSoccerTeamXg,unavailableSoccerTeamXg,getSoccerTeamXgProvider} from '../lib/soccer/team-xg.js';

const fixture=await soccerSqlFixture(),envKeys=['DATABASE_URL','DATABASE_V2_URL'];
const before=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
process.env.DATABASE_URL='postgres://fixture.invalid/soccer-team-xg-service';delete process.env.DATABASE_V2_URL;
const html=fs.readFileSync(new URL('./fixtures/soccer/opta-epl-20261028.html',import.meta.url),'utf8');
const uclHtml=fs.readFileSync(new URL('./fixtures/soccer/opta-ucl-20261028.html',import.meta.url),'utf8');
const payload=JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/epl-summary.json',import.meta.url)));
const kickoff=new Date(Date.now()+3600000).toISOString();payload.header.date=kickoff;
const comp=payload.header.competitions[0];comp.date=kickoff;
comp.status={type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}};
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function freshEvidence(){
  const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${payload.header.id}`,
    requestedAt:new Date(Date.now()-2).toISOString(),fetchedAt:new Date(Date.now()).toISOString(),contentHash:hash(payload)};
  const board=normalizeSoccerSchedule({leagues:[payload.header.league],events:[{...payload.header,date:comp.date,status:comp.status}]},'epl',source);
  assert.equal(board.ok,true);
  return normalizeSoccerPrematch(payload,board.games[0],source,Date.now());
}
try{
  const {analyzeSoccerGame,loadSoccerCurrentAnalysis}=await import('../lib/soccer/analysis-service.js');
  const {buildSoccerAnalysis}=await import('../lib/soccer/analysis.js');
  const {archiveSoccerTeamXg}=await import('../lib/soccer/team-xg-store.js');
  const game=freshEvidence().game,query={league:'epl',date:game.date,eventId:game.sourceId};
  let buildCount=0;
  const dependencies={
    fetchSoccerSchedule:async()=>({ok:true,games:[game]}),fetchSoccerPrematch:async()=>freshEvidence(),
    fetchSoccerWorkload:async()=>({ok:false,status:'INCOMPLETE',teams:{},sources:[],modelEffectApplied:false,executable:false}),
    loadSoccerReaderSnapshot:async()=>null,
    fetchSoccerTeamXg:game=>fetchSoccerTeamXg(game,{fetchImpl:async()=>Object.defineProperty(new Response(game.league==='ucl'?uclHtml:html,{headers:{'content-type':'text/html'}}),'url',{value:getSoccerTeamXgProvider(game.league).sourceUrl}),ttlMs:0}),
    buildSoccerAnalysis:options=>{
      buildCount++;
      const value=options.evidence.xg;
      if(value.ok){assert.ok(value.sourceDocumentArchive,'archival finishes before analysis');assert.equal(value.formalEligible,false);}
      const result=buildSoccerAnalysis(options);
      const baseline=buildSoccerAnalysis({...options,evidence:{...options.evidence,xg:unavailableSoccerTeamXg('TEAM_XG_NOT_PART_OF_FIXTURE',game)}});
      for(const key of ['prediction','halfTimePrediction','personnelPrediction','scenarioResearch'])
        assert.deepEqual(result[key],baseline[key],`${key} remains independent of new observation`);
      return result;
    },
  };
  const response=await analyzeSoccerGame(query,dependencies);
  assert.equal(response.status,200,JSON.stringify(response.payload));
  const value=response.payload.evidence.xg;assert.equal(value.ok,true,JSON.stringify(value));
  assert.equal(value.sourceDocumentArchive.status,'ARCHIVED');assert.equal(value.sourceDocumentArchive.persisted,true);
  assert.equal(value.sourceDocumentArchive.prematchReceipt,true);assert.equal(value.source.sourcePublishedAt,null);
  assert.equal(response.payload.inputVersions.teamXgSourceVersion.receiptId,value.sourceDocumentArchive.receiptId);
  assert.equal(response.payload.requirements.layers[0].items.find(item=>item.key==='xg').status,'PARTIAL');
  assert.ok(response.payload.missing.some(item=>item.label==='逐場非十二碼 xG 與射門品質'));
  assert.equal(response.payload.formalScoringEnabled,false);assert.equal(response.payload.executable,false);
  assert.equal(response.payload.persisted,true);assert.equal(response.payload.publishedCurrent,true);
  const recovered=await loadSoccerCurrentAnalysis('epl',game.date,game.sourceId);
  assert.deepEqual(recovered.currentVersion.evidence.xg,value,'current API recovery retains original stats and receipt');
  assert.equal(JSON.stringify(response.payload).includes('<!DOCTYPE'),false,'full source body remains server-only');

  const noArchive=await analyzeSoccerGame(query,{...dependencies,archiveSoccerTeamXg:async()=>{throw Error('private-db-secret');}});
  assert.equal(noArchive.status,200);assert.equal(noArchive.payload.evidence.xg.ok,true);
  assert.equal(noArchive.payload.evidence.xg.sourceDocumentArchive.persisted,false);
  assert.equal(noArchive.payload.evidence.xg.sourceDocumentArchive.reason,'TEAM_XG_SOURCE_STORAGE_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(noArchive),/private-db-secret/);
  const unavailable=await analyzeSoccerGame(query,{...dependencies,fetchSoccerTeamXg:async()=>{throw Error('private-source-secret');}});
  assert.equal(unavailable.status,200);assert.equal(unavailable.payload.evidence.xg.status,'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(unavailable),/private-source-secret/);
  let wrongArchive=0;
  const wrong=await analyzeSoccerGame(query,{...dependencies,fetchSoccerTeamXg:async game=>({...(await dependencies.fetchSoccerTeamXg(game)),gameId:'soccer:epl:9'}),
    archiveSoccerTeamXg:async value=>{wrongArchive++;return archiveSoccerTeamXg(value);}});
  assert.equal(wrong.status,200);assert.equal(wrong.payload.evidence.xg.status,'UNKNOWN');
  assert.equal(wrong.payload.evidence.xg.reason,'TEAM_XG_GAME_SCOPE_MISMATCH');assert.equal(wrongArchive,0);
  const uclPayload=JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/ucl-summary.json',import.meta.url)));
  uclPayload.header.date=kickoff;const uclCompetition=uclPayload.header.competitions[0];
  uclCompetition.date=kickoff;uclCompetition.status=structuredClone(comp.status);
  function uclEvidence(){
    const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/uefa.champions/summary?event=${uclPayload.header.id}`,
      requestedAt:new Date(Date.now()-2).toISOString(),fetchedAt:new Date(Date.now()).toISOString(),contentHash:hash(uclPayload)};
    const board=normalizeSoccerSchedule({leagues:[uclPayload.header.league],events:[{...uclPayload.header,date:kickoff,status:uclCompetition.status}]},'ucl',source);
    assert.equal(board.ok,true);return normalizeSoccerPrematch(uclPayload,board.games[0],source,Date.now());
  }
  const uclGame=uclEvidence().game;
  const ucl=await analyzeSoccerGame({league:'ucl',date:uclGame.date,eventId:uclGame.sourceId},{...dependencies,
    fetchSoccerSchedule:async()=>({ok:true,games:[uclGame]}),fetchSoccerPrematch:async()=>uclEvidence()});
  assert.equal(ucl.status,200,JSON.stringify(ucl.payload));assert.equal(ucl.payload.evidence.xg.ok,true,JSON.stringify(ucl.payload.evidence.xg));
  assert.equal(ucl.payload.evidence.xg.sourceDocumentArchive.status,'ARCHIVED');
  assert.equal(ucl.payload.evidence.xg.sourceDocumentArchive.league,'ucl');assert.equal(ucl.payload.evidence.xg.teams.away.xg,5.7);
  assert.equal(ucl.payload.evidence.xg.source.url,getSoccerTeamXgProvider('ucl').sourceUrl);
  const recoveredUcl=await loadSoccerCurrentAnalysis('ucl',uclGame.date,uclGame.sourceId);
  assert.deepEqual(recoveredUcl.currentVersion.evidence.xg,ucl.payload.evidence.xg);
  assert.equal(buildCount,5);
  console.log('PASS Opta EPL/UCL xG service: actual adapter/private proof → PostgreSQL archive → unchanged model → immutable saved analysis → current API recovery; partial coverage, source/storage failure, wrong scope and no formal S');
}finally{for(const key of envKeys){if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key];}await fixture.close();}
