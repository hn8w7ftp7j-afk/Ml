import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerResearchArtifacts } from '../lib/soccer/research-frozen.js';
import { soccerHalfTimeArtifacts } from '../lib/soccer/half-time-frozen.js';
import { soccerCalibrationShadowArtifacts } from '../lib/soccer/calibration-frozen.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { matchSoccerReaderGames } from '../lib/soccer/reader.js';
import { SOCCER_ACCOUNT_RULE_CONFIRMATION as accountPolicy, soccerAccountRulesKnown } from '../lib/soccer/account-rule-policy.js';
const fixture=await soccerSqlFixture(),query=async(sql,params=[])=>(await fixture.db.query(sql,params)).rows;
const envKeys=['DATABASE_URL','DATABASE_V2_URL'],previousEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
process.env.DATABASE_URL='postgres://fixture.invalid/soccer-auto-reader';delete process.env.DATABASE_V2_URL;
const {enqueueSoccerReaderAnalysis,drainSoccerReaderAnalysis,soccerReaderAnalysisCandidates,soccerReaderEconomicPriceSet,soccerReaderCapturePolicyScope}=await import('../lib/soccer/reader-auto-analysis.js');
const {soccerMarketEconomicPriceIdentity}=await import('../lib/soccer/market-return-validation.js');
const {soccerJournalHash}=await import('../lib/soccer/journal.js');
const now=Date.parse('2026-11-05T10:00:00Z'),at=new Date(now).toISOString(),date='2026-11-05';
const game=league=>({id:`soccer:${league}:123`,sourceId:'123',league,date,startTime:'2026-11-05T11:00:00.000Z',status:'scheduled',
  home:{id:`soccer:${league}:team:359`,sourceId:'359',name:'Arsenal'},away:{id:`soccer:${league}:team:364`,sourceId:'364',name:'Chelsea'}});
const source={revision:'a'.repeat(64),observationId:'b'.repeat(64),observedAt:at,firstFetchedAt:at,receivedAt:at,persistedAt:at,sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'};
const reader=league=>({league:league.toUpperCase(),boardDate:date,...source,
  games:[{league:league.toUpperCase(),boardDate:date,boardTime:'19:00',homeKey:'Arsenal',awayKey:'Chelsea',markets:[
    {period:'FT',kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:.9,underWater:.95,rawRows:['大2.5 0.90 小0.95'],serverObservation:source,
      periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:league==='epl'?'英格蘭超級聯賽':'歐洲冠軍聯賽',tableHeaders:['全場'],marketHeader:'全場大小'}}]}]});
let r=reader('epl'),g=game('epl'),calls=0;
const board=()=>({ok:true,league:{id:g.league},date,until:date,coverage:{complete:true},games:[g]});
const candidates=()=>soccerReaderAnalysisCandidates(r,board(),{league:g.league,date,now});
function success({reader=r,game=g,cutoff=now}={}){
  const r=reader,g=game,now=cutoff,at=new Date(now).toISOString();
  const shadow=soccerCalibrationShadowArtifacts(g.league);
  const directions=buildSoccerMarketDirections({reader:r,game:g,matchedGames:matchSoccerReaderGames(r,[g],now),now});
  const provisionalReaderResearch={status:'UNVERIFIED_SCHEDULE_SCOPE',league:g.league,gameId:g.id,date:g.date,
    identityScope:'UNIQUE_AMONG_FETCHED_SCHEDULE_ONLY',scheduleCompletenessVerified:false,
    formalEligible:false,calibrationEligible:false,promotionEligible:false,executable:false,W:null,R:null,S:null,
    quotes:directions.flatMap(d=>d.quotes.map(q=>({...q,formalEligible:false,eligible:false,executable:false,W:null,R:null,S:null})))};
  return{status:200,payload:{ok:true,persisted:true,journalPersisted:true,executable:false,analysisStatus:'COMPLETED',status:'RESEARCH_ONLY',
    evidence:{game:g},readerEvidence:{status:'NO_MATCHED_QUOTE',games:[]},directions:[],provisionalReaderResearch,revision:'c'.repeat(64),prediction:soccerResearchArtifacts().leagues[g.league].liveModel,
    inputVersions:{readerSourceObservations:r.sourceObservations||[]},
    halfTimePrediction:soccerHalfTimeArtifacts().leagues[g.league].liveModel,
    calibrationShadowCapture:{persisted:true,status:'SHADOW_PREDICTION_SAVED',fullTimeCaptured:true,halfTimeCaptured:true,
      freeze:{status:'DATABASE_FROZEN',league:g.league,freezeId:'1'.repeat(64),candidateHash:shadow.candidate.contentHash,
        planHash:shadow.plan.contentHash,frozenAt:new Date(now-1000).toISOString()},
      capture:{status:'DATABASE_PREGAME_CAPTURED',league:g.league,gameId:g.id,freezeId:'1'.repeat(64),captureId:'2'.repeat(64),
        captureSequence:'1',analysisRevision:'c'.repeat(64),sourceReceiptId:'3'.repeat(64),predictionHash:'4'.repeat(64),capturedAt:at}},
    forwardCapture:{persisted:true,captures:[{variant:'BASELINE',period:'REGULATION_FT',captureId:'d'.repeat(64),captureSequence:'1',capturedAt:at}]}}};
}
const deps={query,now:()=>now,loadReader:async()=>r,schedule:async()=>board(),analyze:async(input,overrides)=>{
  calls++;assert.equal(input.league,g.league);assert.equal(input.eventId,g.sourceId);
  assert.equal((await overrides.fetchSoccerSchedule(input.league,input.date)).ok,true);return success();}};
const release=async()=>{await query("UPDATE sports_soccer_reader_analysis_queue_v1 SET retry_at=clock_timestamp()-interval '1 second',lease_until=NULL");
  await query("UPDATE sports_soccer_reader_analysis_claims_v1 SET lease_until=clock_timestamp()-interval '1 second' WHERE state<>'CAPTURED'");};
try{
  // Use real matcher/price adapter, not a caller-supplied eligible flag.
  // Wire aliases are normalized before the authoritative club comparison.
  r.games[0].homeKey=globalThis.Tai888SoccerTeams.key('Arsenal');r.games[0].awayKey=globalThis.Tai888SoccerTeams.key('Chelsea');
  assert.equal(candidates().length,1);
  const original=candidates()[0];
  assert.equal(soccerReaderAnalysisCandidates(r,{...board(),coverage:{complete:false}},{league:'epl',date,now}).length,0,'partial board cannot create an unfulfillable background claim');
  const claimedComplete={ok:true,league:{id:'epl'},date,until:date,games:[g],coverage:{complete:true,identityComplete:true}};
  const claimedCompleteCandidate=soccerReaderAnalysisCandidates(r,claimedComplete,{league:'epl',date,now})[0];
  assert.equal(claimedCompleteCandidate.identityStatus,'PROVISIONAL_SCHEDULE_IDENTITY_UNVERIFIED',
    'a provider completeness claim cannot independently verify schedule identity');
  assert.equal(claimedCompleteCandidate.identity,original.identity,
    'an untrusted completeness flag cannot change the durable capture scope');
  assert.equal(original.shadow.required,true);assert.equal(original.shadow.candidateHash,soccerCalibrationShadowArtifacts('epl').candidate.contentHash);
  const heartbeat=structuredClone(r);heartbeat.games[0].markets[0].serverObservation.observationId='e'.repeat(64);
  assert.equal(soccerReaderAnalysisCandidates(heartbeat,board(),{league:'epl',date,now})[0].identity,original.identity,'receipt-only heartbeat is not a new economic price');
  const changedPath=structuredClone(r);changedPath.games[0].markets[0].serverObservation.pageUrl='https://www.tai888.in/other/';
  assert.notEqual(soccerReaderAnalysisCandidates(changedPath,board(),{league:'epl',date,now})[0].identity,original.identity,'source path is part of the economic identity');
  const changedDevice=structuredClone(r);changedDevice.sourceObservations=[{...source,deviceHash:'f'.repeat(64)}];
  assert.notEqual(soccerReaderAnalysisCandidates(changedDevice,board(),{league:'epl',date,now})[0].identity,original.identity,'server device receipt is part of the economic identity');
  const economicQuote=buildSoccerMarketDirections({reader:r,game:g,matchedGames:matchSoccerReaderGames(r,[g],now),now}).flatMap(direction=>direction.quotes)[0];
  const scopedQuote=structuredClone(economicQuote);scopedQuote.provenance.periodResolution={configHash:'1'.repeat(64),observation:{deviceHash:'f'.repeat(64)}};
  const economicScope={league:'epl',gameId:g.id};
  const originalBinding=soccerReaderEconomicPriceSet([scopedQuote],economicScope);
  scopedQuote.provenance.periodResolution.configHash='2'.repeat(64);
  assert.notDeepEqual(soccerReaderEconomicPriceSet([scopedQuote],economicScope),originalBinding,'binding configuration changes cannot be deduplicated as a heartbeat');
  const policySource=fs.readFileSync('lib/soccer/reader-auto-analysis.js','utf8').replace(/^import .*?;\r?\n/gm,'').replace(/export /g,'');
  const nextPolicyContext=vm.createContext({accountPolicy:{...accountPolicy,version:'SYNTHETIC-NEXT-POLICY-VERSION'},
    soccerAccountRulesKnown,soccerMarketEconomicPriceIdentity});
  vm.runInContext(policySource+';globalThis.policyScope=soccerReaderCapturePolicyScope;',nextPolicyContext);
  assert.notEqual(soccerJournalHash(nextPolicyContext.policyScope([economicQuote],economicScope)),
    soccerJournalHash(soccerReaderCapturePolicyScope([economicQuote],economicScope)),'changed server policy version changes scope without changing prices');
  for(const change of [value=>value.games[0].markets[0].serverObservation.observedAt='2026-11-05T09:00:00Z',
    value=>value.games[0].markets[0].periodEvidence.tableHeaders=['上半場'],value=>value.games[0].homeKey='unknown',
    value=>value.league='UCL']){
    const bad=structuredClone(r);change(bad);assert.equal(soccerReaderAnalysisCandidates(bad,board(),{league:'epl',date,now}).length,0);
  }
  for(const state of ['live','finished','postponed'])assert.equal(soccerReaderAnalysisCandidates(r,{...board(),games:[{...g,status:state}]},{league:'epl',date,now}).length,0);
  const competing={...structuredClone(g),id:'soccer:epl:456',sourceId:'456',status:'postponed'};
  assert.equal(soccerReaderAnalysisCandidates(r,{...board(),games:[g,competing]},{league:'epl',date,now}).length,0,
    'a competing same-day game cannot be ignored just because it is not scheduled');
  assert.equal(soccerReaderAnalysisCandidates(r,board(),{league:'epl',date,now:Date.parse(g.startTime)}).length,0);
  await assert.rejects(()=>enqueueSoccerReaderAnalysis('nba',date,{query}),/SCOPE/);
  await enqueueSoccerReaderAnalysis('epl',date,{query});
  const incomplete=await drainSoccerReaderAnalysis({...deps,schedule:async()=>({...board(),coverage:{complete:false}})});
  assert.equal(incomplete.retryable,1);assert.equal(incomplete.checked,0);
  const incompleteQueue=(await query("SELECT last_reason,retry_at='infinity'::timestamptz AS dormant FROM sports_soccer_reader_analysis_queue_v1 WHERE league='epl' AND board_date=$1::date",[date]))[0];
  assert.deepEqual(incompleteQueue,{last_reason:'SCHEDULE_INCOMPLETE',dormant:false},'partial schedule retries slowly and does not need a new Reader upload');
  await release();
  const malformed=await drainSoccerReaderAnalysis({...deps,schedule:async()=>({...board(),games:[g,structuredClone(g)]})});
  assert.equal(malformed.retryable,1);assert.equal(malformed.checked,0);
  const malformedQueue=(await query("SELECT last_reason,retry_at='infinity'::timestamptz AS dormant FROM sports_soccer_reader_analysis_queue_v1 WHERE league='epl' AND board_date=$1::date",[date]))[0];
  assert.deepEqual(malformedQueue,{last_reason:'SCHEDULE_INCOMPLETE',dormant:false},'malformed identities also retry when the schedule is corrected');
  await release();
  const expiredReader=structuredClone(r);expiredReader.games[0].markets[0].serverObservation.observedAt=new Date(now-181000).toISOString();
  const expired=await drainSoccerReaderAnalysis({...deps,loadReader:async()=>expiredReader,schedule:async()=>{throw Error('provider down');}});
  assert.equal(expired.deferred,1);assert.equal(expired.retryable,0);
  const expiredQueue=(await query("SELECT last_reason,retry_at='infinity'::timestamptz AS dormant FROM sports_soccer_reader_analysis_queue_v1 WHERE league='epl' AND board_date=$1::date",[date]))[0];
  assert.deepEqual(expiredQueue,{last_reason:'NO_FRESH_ELIGIBLE_QUOTES',dormant:true},'expired prices stop retries even during a schedule outage');
  await release();
  const tampered=await drainSoccerReaderAnalysis({...deps,analyze:async()=>{const out=success();out.payload.provisionalReaderResearch.formalEligible=true;return out;}});
  assert.equal(tampered.captured,0,'mislabelled provisional research cannot acknowledge a durable capture');
  assert.equal(tampered.retryable,1);await release();
  const concurrent=await Promise.all([drainSoccerReaderAnalysis(deps),drainSoccerReaderAnalysis(deps)]);
  assert.equal(concurrent.reduce((n,x)=>n+x.captured,0),1);assert.equal(calls,1,'SQL scope lease admits one concurrent worker');
  await enqueueSoccerReaderAnalysis('epl',date,{query});
  assert.equal((await drainSoccerReaderAnalysis(deps)).duplicate,1);assert.equal(calls,1);
  r.games[0].markets[0].overWater=.91;
  await enqueueSoccerReaderAnalysis('epl',date,{query});
  assert.equal((await drainSoccerReaderAnalysis({...deps,analyze:async()=>{calls++;return{status:200,payload:{ok:true,persisted:true}};}})).captured,0);
  assert.equal((await query("SELECT count(*)::int n FROM sports_soccer_reader_analysis_claims_v1 WHERE state='CAPTURED'"))[0].n,1,'save-only response cannot acknowledge a forward capture');
  await release();assert.equal((await drainSoccerReaderAnalysis(deps)).captured,1,'failed capture remains durably recoverable');
  r.games[0].markets[0].overWater=.915;await enqueueSoccerReaderAnalysis('epl',date,{query});
  assert.equal((await drainSoccerReaderAnalysis({...deps,analyze:async()=>{const result=success();result.payload.calibrationShadowCapture.persisted=false;return result;}})).captured,0,'baseline-only save cannot hide a failed applicable calibration capture');
  await release();assert.equal((await drainSoccerReaderAnalysis(deps)).captured,1);
  // A lease holder resumes after a replacement worker has completed. Both the
  // claim receipt and queue completion are fenced by their original tokens.
  r.games[0].markets[0].overWater=.965;await enqueueSoccerReaderAnalysis('epl',date,{query});
  let entered,releaseOld;
  const oldEntered=new Promise(resolve=>{entered=resolve;}),oldReleased=new Promise(resolve=>{releaseOld=resolve;});
  const lateWorker=drainSoccerReaderAnalysis({...deps,analyze:async()=>{entered();await oldReleased;const result=success();result.payload.revision='6'.repeat(64);return result;}});
  await oldEntered;
  const expiredIdentity=candidates()[0].identity;
  const oldClaim=(await query('SELECT attempt_token FROM sports_soccer_reader_analysis_claims_v1 WHERE identity=$1',[expiredIdentity]))[0];
  await query("UPDATE sports_soccer_reader_analysis_claims_v1 SET lease_until=clock_timestamp()-interval '1 second' WHERE identity=$1",[expiredIdentity]);
  await query("UPDATE sports_soccer_reader_analysis_queue_v1 SET lease_until=clock_timestamp()-interval '1 second' WHERE league='epl' AND board_date=$1::date",[date]);
  const replacement=await drainSoccerReaderAnalysis(deps);assert.equal(replacement.captured,1);
  const replacementClaim=(await query('SELECT attempt_token,analysis_revision FROM sports_soccer_reader_analysis_claims_v1 WHERE identity=$1',[expiredIdentity]))[0];
  assert.notEqual(replacementClaim.attempt_token,oldClaim.attempt_token);
  releaseOld();assert.equal((await lateWorker).captured,0,'expired worker must not acknowledge a completed capture');
  assert.deepEqual((await query('SELECT attempt_token,analysis_revision FROM sports_soccer_reader_analysis_claims_v1 WHERE identity=$1',[expiredIdentity]))[0],replacementClaim,'late receipt cannot overwrite replacement');
  assert.equal((await query("SELECT count(*)::int n FROM sports_soccer_reader_analysis_queue_v1 WHERE league='epl' AND board_date=$1::date",[date]))[0].n,0);
  // A same-scope upload during a running analysis must not be erased by its old generation.
  r.games[0].markets[0].overWater=.92;await enqueueSoccerReaderAnalysis('epl',date,{query});
  assert.equal((await drainSoccerReaderAnalysis({...deps,analyze:async()=>{await enqueueSoccerReaderAnalysis('epl',date,{query});return success();}})).captured,1);
  assert.equal((await query('SELECT count(*)::int n FROM sports_soccer_reader_analysis_queue_v1'))[0].n,0,'new generation is re-read under remaining original budget');
  await release();await drainSoccerReaderAnalysis(deps);
  // A valid persisted receipt acquired after kickoff is still not pregame data.
  r.games[0].markets[0].overWater=.93;await enqueueSoccerReaderAnalysis('epl',date,{query});
  assert.equal((await drainSoccerReaderAnalysis({...deps,analyze:async()=>{const result=success();result.payload.forwardCapture.captures[0].capturedAt=g.startTime;return result;}})).captured,0);
  await release();assert.equal((await drainSoccerReaderAnalysis(deps)).captured,1);
  // Price changes while the normal service loads latest Reader data cannot complete the old claim.
  r.games[0].markets[0].overWater=.94;await enqueueSoccerReaderAnalysis('epl',date,{query});
  assert.equal((await drainSoccerReaderAnalysis({...deps,analyze:async()=>{r.games[0].markets[0].overWater=.96;return success();}})).captured,0);
  await release();assert.equal((await drainSoccerReaderAnalysis(deps)).captured,1);
  // Same provider IDs in UCL are an independent durable scope.
  r=reader('ucl');g=game('ucl');r.games[0].homeKey=globalThis.Tai888SoccerTeams.key('Arsenal');r.games[0].awayKey=globalThis.Tai888SoccerTeams.key('Chelsea');
  await enqueueSoccerReaderAnalysis('ucl',date,{query});assert.equal((await drainSoccerReaderAnalysis(deps)).captured,1);
  assert.equal((await query("SELECT count(*)::int n FROM sports_soccer_reader_analysis_claims_v1 WHERE league='ucl' AND state='CAPTURED'"))[0].n,1);
  await enqueueSoccerReaderAnalysis('ucl',date,{query});
  const deferred=await drainSoccerReaderAnalysis({...deps,loadReader:async()=>null});assert.equal(deferred.deferred,1);
  const dormant=(await query("SELECT last_reason,retry_at='infinity'::timestamptz AS dormant FROM sports_soccer_reader_analysis_queue_v1 WHERE league='ucl'"))[0];
  assert.deepEqual(dormant,{last_reason:'NO_FRESH_ELIGIBLE_QUOTES',dormant:true},'unusable inputs retain auditable reason without repeated stale scans');
  await enqueueSoccerReaderAnalysis('ucl',date,{query});
  assert.equal((await drainSoccerReaderAnalysis(deps)).duplicate,1,'next real Reader upload wakes the dormant scope');
  // The same economic price observed before and after owner confirmation is
  // collected once per actual policy applicability, never retroactively.
  const policyDate='2026-11-02',policyGame={...game('epl'),date:policyDate,startTime:'2026-11-02T00:30:00.000Z'};
  const policyReader=structuredClone(reader('epl'));policyReader.boardDate=policyDate;policyReader.games[0].boardDate=policyDate;
  policyReader.games[0].boardTime='08:30';policyReader.games[0].homeKey=globalThis.Tai888SoccerTeams.key('Arsenal');policyReader.games[0].awayKey=globalThis.Tai888SoccerTeams.key('Chelsea');
  let policyNow=Date.parse(accountPolicy.confirmedAt)-1000,policyCalls=0;
  const setPolicyReceipt=()=>{for(const key of ['observedAt','firstFetchedAt','receivedAt','persistedAt']){
    policyReader[key]=new Date(policyNow).toISOString();policyReader.games[0].markets[0].serverObservation[key]=policyReader[key];}};
  setPolicyReceipt();
  const policyBoard=()=>({ok:true,league:{id:'epl'},date:policyDate,until:policyDate,coverage:{complete:true},games:[policyGame]}),policyCandidate=()=>soccerReaderAnalysisCandidates(policyReader,policyBoard(),{league:'epl',date:policyDate,now:policyNow})[0];
  const priorPolicy=policyCandidate();assert.ok(priorPolicy);
  const policyDeps={query,now:()=>policyNow,league:'epl',date:policyDate,loadReader:async()=>policyReader,schedule:async()=>policyBoard(),
    analyze:async()=>{policyCalls++;return success({reader:policyReader,game:policyGame,cutoff:policyNow});}};
  await enqueueSoccerReaderAnalysis('epl',policyDate,{query});assert.equal((await drainSoccerReaderAnalysis(policyDeps)).captured,1);
  policyNow+=2000;setPolicyReceipt();const knownPolicy=policyCandidate();
  assert.equal(knownPolicy.priceHash,priorPolicy.priceHash);assert.notEqual(knownPolicy.policyHash,priorPolicy.policyHash);assert.notEqual(knownPolicy.identity,priorPolicy.identity);
  await enqueueSoccerReaderAnalysis('epl',policyDate,{query});assert.equal((await drainSoccerReaderAnalysis(policyDeps)).captured,1);
  policyNow+=1000;setPolicyReceipt();await enqueueSoccerReaderAnalysis('epl',policyDate,{query});
  assert.equal((await drainSoccerReaderAnalysis(policyDeps)).duplicate,1);assert.equal(policyCalls,2,'later heartbeats do not multiply either policy cohort');
  const tables=await query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  assert.ok(tables.every(row=>!row.tablename.includes('manual_records')&&!row.tablename.includes('bet_ledger')),'worker never creates or writes a wager ledger');
  const route=fs.readFileSync('app/api/soccer/reader/route.js','utf8');
  assert.ok(route.indexOf('await saveSoccerReaderSnapshot')<route.indexOf('await enqueueSoccerReaderAnalysis'));
  assert.match(route,/await launchSoccerReaderContinuation/);assert.doesNotMatch(route,/await drainSoccerReaderAnalysis\(\);\s*return response/);
  // Synthetic future fixture through the actual model, immutable analysis store,
  // forward capture service and real PostgreSQL receipt. No fabricated response.
  const {analyzeSoccerGame}=await import('../lib/soccer/analysis-service.js');
  const raw=JSON.parse(fs.readFileSync(new URL('./fixtures/soccer/epl-summary.json',import.meta.url),'utf8'));
  // A synthetic new identity is necessary: the retained original event has
  // already been inspected by the calibration package and must stay excluded.
  const syntheticEvent='991010123';raw.header.id=syntheticEvent;raw.header.uid=raw.header.uid.replace(/~e:\d+/,`~e:${syntheticEvent}`);
  raw.header.competitions[0].id=syntheticEvent;
  raw.header.competitions[0].uid=raw.header.competitions[0].uid.replace(/~e:\d+/,`~e:${syntheticEvent}`).replace(/~c:\d+/,`~c:${syntheticEvent}`);
  const kickoff=new Date(Math.floor((Date.now()+3600000)/60000)*60000).toISOString();
  raw.header.date=kickoff;raw.header.competitions[0].date=kickoff;
  raw.header.competitions[0].status={type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}};
  function evidence(){
    const receipt={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${raw.header.id}`,
      requestedAt:new Date(Date.now()-2).toISOString(),fetchedAt:new Date().toISOString(),contentHash:createHash('sha256').update(JSON.stringify(raw)).digest('hex')};
    const schedule=normalizeSoccerSchedule({leagues:[raw.header.league],events:[{...raw.header,status:raw.header.competitions[0].status}]},'epl',receipt);
    return normalizeSoccerPrematch(raw,schedule.games[0],receipt,Date.now());
  }
  const liveGame=evidence().game,liveReader=reader('epl'),freshAt=new Date().toISOString();
  liveReader.boardDate=liveGame.date;
  const rawGame=liveReader.games[0];rawGame.boardDate=liveGame.date;rawGame.boardTime=new Date(Date.parse(kickoff)+8*3600000).toISOString().slice(11,16);
  rawGame.homeKey=globalThis.Tai888SoccerTeams.key(liveGame.home.name);rawGame.awayKey=globalThis.Tai888SoccerTeams.key(liveGame.away.name);
  for(const key of ['observedAt','firstFetchedAt','receivedAt','persistedAt']){
    liveReader[key]=freshAt;rawGame.markets[0].serverObservation[key]=freshAt;
  }
  const schedule=async()=>({ok:true,league:{id:'epl'},date:liveGame.date,until:liveGame.date,
    coverage:{complete:true},games:[liveGame]});let actualResponse;
  await enqueueSoccerReaderAnalysis('epl',liveGame.date,{query});
  const actualDeps={query,loadReader:async()=>liveReader,schedule,
    analyze:async(input,overrides)=>{
      actualResponse=await analyzeSoccerGame(input,{...overrides,enrichSoccerPrematchInputs:async evidence=>evidence,fetchSoccerPrematch:async()=>evidence(),
        loadSoccerReaderSnapshot:async()=>liveReader,
        fetchSoccerWorkload:async()=>({ok:false,status:'INCOMPLETE',teams:{},sources:[],modelEffectApplied:false,executable:false}),
        fetchSoccerTeamXg:async()=>{throw Error('synthetic unavailable ancillary source');}});
      return actualResponse;
    }};
  const actual=await drainSoccerReaderAnalysis(actualDeps);
  assert.equal(actual.captured,1,JSON.stringify({actual,response:actualResponse?.payload?.forwardCapture,status:actualResponse?.payload?.status}));
  const claim=(await query("SELECT receipt FROM sports_soccer_reader_analysis_claims_v1 WHERE game_id=$1 AND state='CAPTURED'",[liveGame.id]))[0];
  assert.ok(claim);assert.equal(claim.receipt.revision,actualResponse.payload.revision);
  assert.equal(claim.receipt.identityStatus,'PROVISIONAL_SCHEDULE_IDENTITY_UNVERIFIED');
  assert.equal(claim.receipt.formalScoringEnabled,false);assert.equal(claim.receipt.executable,false);
  const saved=(await query('SELECT payload FROM sports_soccer_analysis_v1 WHERE analysis_hash=$1',[claim.receipt.revision]))[0];
  assert.equal(saved.payload.directions.flatMap(direction=>direction.quotes).length,0,'unverified board cannot create formal original directions');
  assert.ok(saved.payload.provisionalReaderResearch?.quotes.length,'actual persisted analysis preserves unverified research prices');
  assert.equal(saved.payload.formalScoringEnabled,false);
  const savedCapture=(await query('SELECT capture_id FROM sports_soccer_forward_captures_v1 WHERE capture_id=$1',[claim.receipt.captures[0].captureId]))[0];
  assert.equal(savedCapture.capture_id,claim.receipt.captures[0].captureId);
  const shadowReceipt=claim.receipt.calibrationShadow.capture;
  assert.ok(shadowReceipt,JSON.stringify(actualResponse.payload.calibrationShadowCapture));
  assert.equal((await query('SELECT capture_id FROM sports_soccer_calibration_captures_v1 WHERE capture_id=$1',[shadowReceipt.captureId]))[0].capture_id,shadowReceipt.captureId);
  // A later price produces a new baseline receipt but reuses the first genuine
  // calibration shadow for this game, preserving its original revision.
  rawGame.markets[0].overWater=.98;await enqueueSoccerReaderAnalysis('epl',liveGame.date,{query});
  assert.equal((await drainSoccerReaderAnalysis(actualDeps)).captured,1);
  const reused=actualResponse.payload.calibrationShadowCapture.capture;
  assert.equal(reused.captureId,shadowReceipt.captureId);
  assert.equal(reused.analysisRevision,shadowReceipt.analysisRevision);
  assert.notEqual(actualResponse.payload.revision,reused.analysisRevision);
  // Exercise the shipped transport with only the existing parser/auth/storage
  // interfaces substituted. Queuing is real PostgreSQL; model work must await
  // the registered after-response callback, including storage failure paths.
  let afterCallback,drainStarted=false,savedUploads=0;
  const httpDate='2026-11-06',httpInput={league:'EPL',boardDate:httpDate,games:[{markets:[]}]};
  const context=vm.createContext({Response,NextResponse:{json:(body,options)=>Response.json(body,options)},
    readerCorsHeaders:()=>({}),readerOriginAllowed:()=>true,bearerToken:()=>'',verifyReaderToken:async()=>({deviceId:'synthetic-device'}),
    checkRateLimit:()=>({allowed:true}),readJsonBody:async()=>httpInput,validateSoccerCapture:()=>({ok:true,payload:httpInput}),
    saveSoccerReaderSnapshot:async()=>{savedUploads++;return{persisted:true,revision:'5'.repeat(64)};},
    enqueueSoccerReaderAnalysis:(league,date)=>enqueueSoccerReaderAnalysis(league,date,{query}),
    launchSoccerReaderContinuation:async scope=>{afterCallback=()=>context.drainSoccerReaderAnalysis(scope);return{status:'STARTED',durable:true,runId:'wrun_01ARYZ6S41TSV4RRFFQ69G5FAV'};},
    drainSoccerReaderAnalysis:async options=>{drainStarted=true;return drainSoccerReaderAnalysis({...options,query,loadReader:async()=>null,schedule:async()=>({ok:true,games:[]})});},
  });
  const routeBody=route.replace(/^import .*?;\r?\n/gm,'').replace(/export const /g,'const ').replace(/export async function /g,'async function ');
  vm.runInContext(routeBody+';globalThis.post=POST;',context);
  const request=new Request('https://fixture.invalid/api/soccer/reader',{method:'POST',headers:{'x-device-id':'synthetic-device'}});
  const queued=await (await context.post(request)).json();assert.equal(queued.automaticCapture.durable,true);assert.equal(drainStarted,false);
  assert.equal((await query('SELECT count(*)::int n FROM sports_soccer_reader_analysis_queue_v1 WHERE board_date=$1::date',[httpDate]))[0].n,1);
  await afterCallback();assert.equal(drainStarted,true);
  context.enqueueSoccerReaderAnalysis=async()=>{throw Error('synthetic queue unavailable');};
  const unavailable=await (await context.post(request)).json();assert.equal(unavailable.ok,true);assert.equal(unavailable.automaticCapture.durable,false);
  assert.equal(savedUploads,2,'queue outage cannot turn a completed Reader save into a failed upload');
  console.log('PASS Reader auto capture: PostgreSQL leases/economic source-scope dedup/retries/generation fence; actual model → immutable analysis → forward and calibration DB receipts; official pregame and league isolation; no wagers; after-response transport');
}finally{for(const key of envKeys){if(previousEnv[key]===undefined)delete process.env[key];else process.env[key]=previousEnv[key];}await fixture.close();}
