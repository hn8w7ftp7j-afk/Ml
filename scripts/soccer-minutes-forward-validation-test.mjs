import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {soccerSqlFixture} from './helpers/soccer-sql-fixture.mjs';
import {soccerPersonnelInputsFixture} from './helpers/soccer-personnel-inputs-fixture.mjs';
import {normalizeSoccerSchedule} from '../lib/soccer/data.js';
import {normalizeSoccerPrematch} from '../lib/soccer/prematch.js';
import {enrichSoccerPrematchInputs} from '../lib/soccer/prematch-inputs.js';

const iso=v=>new Date(v).toISOString(),digest=data=>createHash('sha256').update(JSON.stringify(data)).digest('hex');
const p=(id,probabilities,expectedMinutes)=>({id,probabilities,expectedMinutes});
const body={teams:{home:{sourceId:'1',status:'FROZEN_PRIOR_FORECAST',model:[p('11',[0,1,0],45)],baseline:[p('11',[1,0,0],90)],unmodeledCurrentRosterIds:[]},away:{sourceId:'2',status:'UNAVAILABLE',model:[],baseline:[]}}};
const target={ok:true,targetHash:'a'.repeat(64),teams:{home:{sourceId:'1',players:[{id:'11',starter:true,appeared:true,regulationClockMinutes:90}]},away:{sourceId:'2',players:[]}}};

// Provider documents are deliberately synthetic; the actual default analysis,
// immutable source/observation stores and DB-clock capture pipeline run in PG.
const fixture=await soccerSqlFixture(),{db}=fixture,oldUrl=process.env.DATABASE_URL,oldV2=process.env.DATABASE_V2_URL,oldFetch=globalThis.fetch;
process.env.DATABASE_URL='postgres://fixture.invalid/minutes-forward';delete process.env.DATABASE_V2_URL;
const contracts=[];
try {
  const {evaluateSoccerMinutesForwardPrediction,normalizeSoccerMinutesForwardResult,replaySoccerMinutesForwardChecks,
    prepareSoccerMinutesForwardCapture,getSoccerMinutesForwardCaptureProof,readSoccerMinutesForwardReport,
    captureSoccerMinutesForward,evaluateSoccerMinutesForward}=await import('../lib/soccer/minutes-forward-validation.js');
  const metric=evaluateSoccerMinutesForwardPrediction(body,target);
  assert.equal(metric.metrics.model.logLoss,null);assert.equal(metric.metrics.model.logLossState,'POSITIVE_INFINITY');
  assert.equal(metric.metrics.baseline.logLoss,0);assert.equal(metric.metrics.model.minuteMAE,45);
  assert.equal(metric.metrics.model.brier,2);assert.equal(metric.metrics.model.playerTargets,1);
  assert.equal(getSoccerMinutesForwardCaptureProof({body}),null,'pure data never mints capture authority');
  const {analyzeSoccerGame}=await import('../lib/soccer/analysis-service.js');
  const {buildSoccerAnalysis}=await import('../lib/soccer/analysis.js');
  const store=await import('../lib/soccer/minutes-forward-store.js');
  const protocolDefinition=(await import('../lib/soccer/minutes-forward-validation.js')).soccerMinutesForwardProtocol('epl');
  assert.equal(protocolDefinition.clockBasis,'PROVIDER_REGULATION_MINUTES_EXCLUDES_ADDED_TIME');
  const {loadSoccerAnalysisRevision}=await import('../lib/soccer/analysis-store.js');
  for(const league of ['epl','ucl']) {
    const empty=await readSoccerMinutesForwardReport(league);contracts.push(empty);
    assert.equal(empty.counts.captures,0);assert.equal(empty.metrics.model.minuteMAE,null);assert.equal(empty.protocol,null);
    const f=soccerPersonnelInputsFixture(league),kickoff=Date.now()+16000,c=f.payload.header.competitions[0];
    c.date=iso(kickoff);f.payload.header.date=c.date;
    f.currentSource.contentHash=digest(f.payload);
    const board=normalizeSoccerSchedule({leagues:[f.payload.header.league],events:[{...f.payload.header,date:c.date,status:c.status}]},league,f.currentSource);
    assert.equal(board.ok,true);const game=board.games[0];
    f.evidence.workload.gameId=game.id;f.evidence.workload.target=structuredClone(game);
    const query={league,date:game.date,eventId:game.sourceId},dependencies={
      fetchSoccerSchedule:async()=>board,
      buildSoccerAnalysis:input=>{const result=buildSoccerAnalysis(input);return league==='epl'
        ?{...result,prediction:null,analysisStatus:'INSUFFICIENT_DATA',qaFlag:'BLOCKED',selectionResult:null,predictionReason:'SYNTHETIC_JOINT_SCORE_UNAVAILABLE'}:result;},
      fetchSoccerPrematch:async()=>{await new Promise(r=>setTimeout(r,8));const at=Date.now(),source={...f.currentSource,requestedAt:iso(at),fetchedAt:iso(at),availableAt:iso(at)};
        return normalizeSoccerPrematch(f.payload,game,source,at);},
      fetchSoccerTeamXg:async()=>({ok:false,reason:'FIXTURE_NOT_PROVIDED'}),
      fetchSoccerWorkload:async()=>f.evidence.workload,
      loadSoccerReaderSnapshot:async()=>null,
      enrichSoccerPrematchInputs:(e,options)=>enrichSoccerPrematchInputs(e,{...options,dependencies:{
        fetchSoccerWeather:async()=>({status:'UNKNOWN',reason:'FIXTURE_NOT_PROVIDED'}),
        fetchSoccerMatchConditionsEvidence:async()=>({})}}),
    };
    const early=await analyzeSoccerGame(query,{...dependencies,ensureSoccerMinutesForwardProtocol:async()=>undefined});
    assert.equal(early.status,200,JSON.stringify(early.payload));
    assert.equal(early.payload.minutesForwardCapture.persisted,false);
    assert.equal(early.payload.minutesForwardCapture.reason,'MINUTES_FORWARD_PROTOCOL_NOT_FROZEN_BEFORE_ANALYSIS',
      'an actual NOT_CAPTURED store receipt cannot be upgraded by the capture wrapper');
    await store.freezeSoccerMinutesForwardProtocol(league);
    const late=await captureSoccerMinutesForward(early.payload,early.payload.revision);
    assert.equal(late.persisted,false);assert.equal(late.status,'NOT_CAPTURED');
    assert.equal(late.reason,'MINUTES_FORWARD_DATABASE_CAPTURE_TIME_INVALID','freezing after an existing run/source never backdates its capture');
    const result=await analyzeSoccerGame(query,dependencies);
    assert.equal(result.status,200,JSON.stringify(result.payload));
    const captureResult=result.payload.minutesForwardCapture;
    assert.equal(captureResult.persisted,true,JSON.stringify({captureResult,status:result.payload.status,analysisStatus:result.payload.analysisStatus,phase:result.payload.evidence?.phase,cutoff:result.payload.analysisCutoff,startTime:result.payload.evidence?.game?.startTime,now:iso(Date.now())}));assert.equal(captureResult.receipt.status,'DATABASE_PREGAME_CAPTURED');
    const revision=captureResult.receipt.analysisRevision,original=await loadSoccerAnalysisRevision(league,game.id,game.date,revision);
    const prepared=await prepareSoccerMinutesForwardCapture(original,revision);assert.ok(getSoccerMinutesForwardCaptureProof(prepared));
    prepared.body.teams.home.model[0].expectedMinutes+=1;assert.equal(getSoccerMinutesForwardCaptureProof(prepared),null);
    const denied=await store.archiveSoccerMinutesForwardCapture(prepared);assert.equal(denied.persisted,false);
    const loaded=await store.loadSoccerMinutesForwardCapture(league,captureResult.receipt.captureId);
    assert.equal(loaded.body.parentAnalysisStatus,result.payload.analysisStatus,'sidecar preserves the original parent status');
    if(league==='epl')assert.equal(result.payload.analysisStatus,'INSUFFICIENT_DATA','an explicit joint-score failure never excludes valid player forecasts or promotes parent analysis');
    assert.ok(loaded.body.teams.home.model.length);assert.equal(loaded.body.teams.home.model.length,loaded.body.teams.home.baseline.length);
    const pending=await readSoccerMinutesForwardReport(league);contracts.push(pending);assert.equal(pending.counts.captures,1);
    assert.equal(pending.counts.evaluated,0);assert.equal(pending.metrics.baseline.minuteRMSE,null);
    const partial=await readSoccerMinutesForwardReport(league,{timeBudgetMs:0});contracts.push(partial);
    assert.equal(partial.page.complete,false);assert.equal(partial.page.nextSequence,'0');
    assert.deepEqual(partial.readCaptureGameKeys,[]);assert.equal(partial.counts.evaluated,0);assert.equal(partial.metrics.model.minuteMAE,null);
    // A real future capture becomes a past game after a bounded 12-second wait.
    // No DB/default timestamp is rewritten or backdated for this transition.
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,kickoff-Date.now()+25)));
    const finished=structuredClone(f.payload),comp=finished.header.competitions[0];
    comp.status={period:2,type:{name:'STATUS_FULL_TIME',completed:true,state:'post'}};
    finished.format={regulation:{periods:2,clock:2700}};
    finished.keyEvents=[{id:'99999971',type:{type:'end-regular-time'},period:{number:2},clock:{value:5400}}];
    for(const team of comp.competitors){team.score='0';team.linescores=[{period:1,value:0},{period:2,value:0}];}
    for(const roster of finished.rosters)for(const player of roster.roster){player.subbedIn=false;player.subbedOut=false;player.stats=[{name:'redCards',value:0}];}
    const scoreboard={leagues:[finished.header.league],events:[{...finished.header,date:comp.date,status:comp.status}]};
    globalThis.fetch=async url=>new Response(JSON.stringify(String(url).includes('/summary?')?finished:scoreboard),{status:200,headers:{'content-type':'application/json'}});
    const evaluated=await evaluateSoccerMinutesForward({league,limit:1});
    assert.equal(evaluated.persisted,true);assert.equal(evaluated.evaluated,1,JSON.stringify(evaluated));
    const report=await readSoccerMinutesForwardReport(league);contracts.push(report);
    assert.equal(report.counts.evaluated,1,JSON.stringify(report));assert.equal(report.metrics.model.games,1);
    assert.equal(report.metrics.model.playerTargets,report.metrics.baseline.playerTargets);
    assert.ok(report.metrics.model.playerTargets>20);assert.ok(report.coverage.unmodeledCurrentRosterPlayers>0);
    assert.equal(report.accepted,false);assert.equal(report.S,null);assert.equal(report.formalEligible,false);
    const raw=(await db.query('SELECT payload FROM sports_soccer_minutes_forward_checks_v1 WHERE league=$1',[league])).rows[0].payload.resultDocuments;
    const same=normalizeSoccerMinutesForwardResult(loaded.body.game,raw,new Date().toISOString());assert.equal(same.ok,true);
    const counter=structuredClone(raw);counter.summaries[0].data.rosters[0].roster[0].stats=[{name:'redCards',value:1}];
    counter.summaries[0].source.contentHash=digest(counter.summaries[0].data);counter.summaries[0].retainedJson=JSON.stringify(counter.summaries[0].data);
    assert.equal(normalizeSoccerMinutesForwardResult(loaded.body.game,counter,new Date().toISOString()).ok,false,'missing dismissal evidence cannot become a numeric target');
    const fresh=(documents,at)=>{const result=structuredClone(documents);for(const doc of [result.scoreboard,...result.summaries]){
      doc.source.fetchedAt=iso(at);doc.source.requestedAt=iso(at);}return result;};
    await new Promise(r=>setTimeout(r,5));
    await store.archiveSoccerMinutesForwardCheck({league,captureId:loaded.captureId,resultDocuments:fresh(raw,Date.now()),status:'EVALUATED'});
    const repeated=await readSoccerMinutesForwardReport(league);assert.equal(repeated.counts.evaluated,1);assert.equal(repeated.counts.quarantined,0,
      'identical player targets at new source clocks are not target corrections');
    const nonfinal=fresh(raw,kickoff+1),live={period:2,type:{name:'STATUS_IN_PROGRESS',completed:false,state:'in'}};
    nonfinal.summaries[0].data.header.competitions[0].status=structuredClone(live);
    nonfinal.scoreboard.data.events[0].status=structuredClone(live);nonfinal.scoreboard.data.events[0].competitions[0].status=structuredClone(live);
    for(const doc of [nonfinal.scoreboard,...nonfinal.summaries]){doc.source.contentHash=digest(doc.data);doc.retainedJson=JSON.stringify(doc.data);}
    await store.archiveSoccerMinutesForwardCheck({league,captureId:loaded.captureId,resultDocuments:nonfinal,status:'PENDING',reason:'RESULT_NORMAL_FINAL_UNCONFIRMED'});
    assert.equal((await readSoccerMinutesForwardReport(league)).counts.evaluated,1,'late-arriving old nonfinal observation cannot withdraw a newer final');
    await new Promise(r=>setTimeout(r,5));
    await store.archiveSoccerMinutesForwardCheck({league,captureId:loaded.captureId,resultDocuments:fresh(nonfinal,Date.now()),status:'PENDING',reason:'RESULT_NORMAL_FINAL_UNCONFIRMED'});
    const withdrawn=await readSoccerMinutesForwardReport(league);contracts.push(withdrawn);
    assert.equal(withdrawn.counts.quarantined,1,JSON.stringify(withdrawn));assert.equal(withdrawn.counts.evaluated,0);
    assert.equal(withdrawn.metrics.model.minuteMAE,null,'a genuinely later nonfinal raw retry withdraws all earlier metrics');
    const deniedSnapshot=await captureSoccerMinutesForward({league,gameId:'invalid',date:game.date},'0'.repeat(64));assert.equal(deniedSnapshot.persisted,false);
  }
  fs.writeFileSync('/tmp/minutes-forward-ui-contract.json',JSON.stringify(contracts));
  console.log('PASS minutes forward default PG integration: pre-run protocol, immutable original+raw observation replay, private capture proof, baseline pairing, real future→final transition, two-endpoint V2 targets, missing entrants, actual API report shapes and no formal promotion; provider responses synthetic only');
} finally {
  globalThis.fetch=oldFetch;if(oldUrl===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldUrl;
  if(oldV2===undefined)delete process.env.DATABASE_V2_URL;else process.env.DATABASE_V2_URL=oldV2;await fixture.close();
}
