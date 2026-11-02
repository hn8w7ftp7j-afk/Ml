import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { soccerPersonnelObservation } from '../lib/soccer/personnel-model.js';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture } from './helpers/soccer-forward-fixture.mjs';
import { soccerForwardAnalysisRevision, soccerForwardHash, soccerForwardModelDescriptor, validateSoccerForwardCapture,
  evaluateSoccerForwardCapture, buildSoccerForwardReport, SOCCER_FORWARD_POLICY } from '../lib/soccer/forward-validation.js';
import { soccerDate } from '../lib/soccer/contracts.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { SOCCER_MARKET_RETURN_VERSION } from '../lib/soccer/market-return-validation.js';
const fixture=await soccerSqlFixture(),{db}=fixture;
const oldDatabase=process.env.DATABASE_URL,oldDatabaseV2=process.env.DATABASE_V2_URL;
process.env.DATABASE_URL='postgres://fixture.invalid/soccer-forward';delete process.env.DATABASE_V2_URL;
try {
  const { ensureSoccerForwardProtocol, captureSoccerForwardSnapshot, loadSoccerForwardEvidence, readSoccerForwardValidation,
    archiveSoccerForwardCheck, runSoccerForwardValidation } = await import('../lib/soccer/forward-validation-service.js');
  const protocol=await ensureSoccerForwardProtocol(),now=Date.now(),start=now+3600000;
  const iso=value=>new Date(value).toISOString();
  const original=fixtureCapture().snapshot;
  original.runStartedAt=iso(now); original.observedAt=iso(now); original.analysisCutoff=iso(now);
  original.date=soccerDate(start);original.evidence.game.date=original.date;original.evidence.game.startTime=iso(start);
  for(const source of [original.evidence.source,original.evidence.game.source,original.evidence.scheduleSource])source.fetchedAt=iso(now);
  original.inputVersions.evidenceFetchedAt=iso(now);
  original.inputVersions.scheduleSourceVersion={...original.evidence.scheduleSource};
  original.directions=buildSoccerMarketDirections({game:original.evidence.game,now,
    reader:{revision:soccerForwardHash('synthetic-reader'),observationId:soccerForwardHash('synthetic-observation'),
      observedAt:iso(now),firstFetchedAt:iso(now),receivedAt:iso(now),persistedAt:iso(now),sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'},
    matchedGames:[{officialGameId:original.gameId,league:'EPL',boardDate:original.date,prestart:true,matchStatus:'MATCHED',markets:[{
      kind:'TOTAL',period:'FT',unit:'GOALS',line:'2.5',overWater:.95,underWater:.9,rawRows:['大 2.5 .95','小 .9'],
      periodEvidence:{sectionTitle:'英格蘭超級聯賽',tableHeaders:['全場'],marketHeader:'全場大小',period:'FT',status:'EXPLICIT'},
    }]}]});
  const revision=soccerForwardAnalysisRevision(original);
  await db.query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES ($1,$2,$3,$4::timestamptz,$5::jsonb)`,['epl',original.gameId,revision,original.observedAt,JSON.stringify(original)]);
  const receipt=await captureSoccerForwardSnapshot({league:'epl',gameId:original.gameId,prediction:'client-content-is-ignored'},revision);
  assert.equal(receipt.captures.length,3);assert.equal(receipt.persisted,true);
  assert.ok(receipt.captures.every(row=>Date.parse(row.capturedAt)>=now&&Date.parse(row.capturedAt)<start));
  assert.equal((await captureSoccerForwardSnapshot(original,revision)).captures[0].captureId,receipt.captures[0].captureId,'same original revision has the same immutable first receipt');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_forward_captures_v1')).rows[0].n,3);
  const scope={league:'epl',date:original.date};
  let evidence=await loadSoccerForwardEvidence(scope);
  assert.equal(evidence.captures.length,3);assert.deepEqual(evidence.captures[0].snapshot,original);
  const ft=evidence.captures.find(row=>row.period==='REGULATION_FT'&&row.variant==='BASELINE');
  assert.equal(ft.revision,revision);assert.equal(ft.modelHash,soccerForwardHash(soccerForwardModelDescriptor(original,'REGULATION_FT')));
  assert.equal(validateSoccerForwardCapture(ft,protocol,Date.now()).ok,true,'DB timestamp receipt, not observed_at, qualifies this pregame snapshot');
  const report=await readSoccerForwardValidation(scope);
  assert.equal(report.selectedGameModelPeriods,2);assert.equal(report.excludedSnapshotPeriods,1);assert.equal(report.evaluatedGameModelPeriods,0);
  assert.equal(report.excludedReasons.FORWARD_PERSONNEL_MODEL_UNVERIFIED,1);
  assert.equal(report.marketReturnValidation.periodsWithoutReturnEvidence,1,'existing priced predictions do not become return samples before checked original prices/results/terms');
  assert.equal(report.marketReturnValidation.unpricedPredictionPeriods,1);
  assert.equal((await readSoccerForwardValidation({league:'ucl',date:original.date})).capturedSnapshotPeriods,0);
  for(const table of ['protocol','captures'])await assert.rejects(()=>db.query(`UPDATE sports_soccer_forward_${table}_v1 SET ${table==='protocol'?'policy=policy':'analysis_revision=analysis_revision'}`),/SOCCER_IMMUTABLE_HISTORY/);
  const after=start+7200000;
  const result={ok:true,verified:true,status:'NORMAL_FINAL_CROSSCHECKED',league:'epl',gameId:original.gameId,date:original.date,startTime:original.evidence.game.startTime,
    teamIds:{home:original.evidence.game.home.id,away:original.evidence.game.away.id},fullTime:{home:2,away:1,period:'REGULATION_FT'},
    halfTime:null,halfTimeMissingReason:'NO_HT_PROOF',observedAt:iso(after),resultHash:soccerForwardHash('synthetic-result'),
    sources:[original.evidence.source,original.evidence.scheduleSource].map(source=>({...source,fetchedAt:iso(after)})),evidenceScope:SOCCER_FORWARD_POLICY.resultEvidence};
  const evaluation=evaluateSoccerForwardCapture(ft,protocol,result,after);
  assert.equal(evaluation.status,'EVALUATED');
  await archiveSoccerForwardCheck(ft,evaluation,result);await archiveSoccerForwardCheck(ft,evaluation,result);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_forward_result_checks_v1')).rows[0].n,1,'exact result retries do not double score the cohort');
  assert.equal((await readSoccerForwardValidation(scope,{now:()=>after})).evaluatedGameModelPeriods,1);
  await assert.rejects(()=>db.query('DELETE FROM sports_soccer_forward_result_checks_v1'),/SOCCER_IMMUTABLE_HISTORY/);
  const correctionTime=now+7*3600000;
  const revisedResult={...result,resultHash:soccerForwardHash('synthetic-corrected-result'),fullTime:{home:0,away:1,period:'REGULATION_FT'},
    sources:result.sources.map(source=>({...source,fetchedAt:iso(correctionTime)})),observedAt:iso(correctionTime)};
  let correctionFetches=0;
  const corrected=await runSoccerForwardValidation(scope,{now:()=>correctionTime,limit:1,timeBudgetMs:1000,
    fetchResult:async()=>{correctionFetches++;return revisedResult;}});
  assert.equal(correctionFetches,1,'the actual runner must revisit already-scored games after the predeclared recheck interval');
  assert.equal(corrected.recheckedGameModelPeriods,1);
  const conflict=await readSoccerForwardValidation(scope,{now:()=>correctionTime});
  assert.equal(conflict.evaluatedGameModelPeriods,0);assert.equal(conflict.conflictingResultCaptures,1,'a provider correction discovered by the runner appends evidence and withdraws the old score pending review');
  const returnChecks=(await db.query(`SELECT payload->'evaluation'->'marketReturnValidation' AS evidence FROM sports_soccer_forward_result_checks_v1
    WHERE capture_id=$1 AND payload->'evaluation'->'marketReturnValidation' IS NOT NULL`,[ft.captureId])).rows;
  assert.equal(returnChecks.length,1);assert.equal(returnChecks[0].evidence.version,SOCCER_MARKET_RETURN_VERSION);
  assert.match(returnChecks[0].evidence.evidenceHash,/^[a-f0-9]{64}$/);assert.equal(returnChecks[0].evidence.quoteObservations,2);
  assert.ok(returnChecks[0].evidence.observations.every(row=>row.status==='OBSERVED'&&row.originalQuote.provenance.observedAt===iso(now)),
    'current-clock quotes use confirmed account rules; original quote time is preserved and later corrections are still quarantined');
  assert.equal(conflict.marketReturnValidation.quarantinedPredictionPeriods,1);
  assert.equal(conflict.marketReturnValidation.observedQuoteReturns,0);assert.equal(conflict.marketReturnValidation.conflictingQuoteReturns,2);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM sports_soccer_forward_result_checks_v1 WHERE payload->'evaluation'->>'captureId'=$1`,[ft.captureId])).rows[0].n,2,'original evaluated result remains intact beside its changed result');
  // Real SQL must size uncompressed JSON before projecting payloads. A
  // highly compressible oversized field reproduces the TOAST-vs-heap hazard.
  const padded=structuredClone(original);padded.gameId='soccer:epl:150';padded.evidence.game.id=padded.gameId;padded.evidence.game.sourceId='150';
  padded.evidence.source.url=padded.evidence.source.url.replace('event=100','event=150');padded.readBudgetFixture='x'.repeat(180000);
  const paddedRevision=soccerForwardAnalysisRevision(padded);
  await db.query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES ('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[padded.gameId,paddedRevision,padded.observedAt,JSON.stringify(padded)]);
  await captureSoccerForwardSnapshot(padded,paddedRevision);
  const payloadSize=Number((await db.query('SELECT octet_length(payload::text)::bigint AS bytes FROM sports_soccer_analysis_v1 WHERE analysis_hash=$1',[revision])).rows[0].bytes);
  const captureBudget=payloadSize;
  let returnedCaptureBytes=0,returnedCheckBytes=0,metadataMeasured=false;
  const tracedQuery=async(sql,params=[])=>{
    const rows=(await db.query(sql,params)).rows;
    if(sql.includes('AS cumulative_payload_bytes')&&sql.includes('WITH candidates')){
      metadataMeasured=true;assert.ok(sql.includes('octet_length(a.payload::text)'));assert.ok(rows.every(row=>!Object.hasOwn(row,'payload')));
    }
    if(sql.startsWith('SELECT DISTINCT ON (c.league,c.game_id,c.analysis_revision)'))returnedCaptureBytes+=rows.reduce((sum,row)=>sum+Buffer.byteLength(JSON.stringify(row.payload)),0);
    if(sql.includes('WITH histories'))returnedCheckBytes+=rows.reduce((sum,row)=>sum+(row.payload?Buffer.byteLength(JSON.stringify(row.payload)):0),0);
    return rows;
  };
  const bounded=await loadSoccerForwardEvidence(scope,{query:tracedQuery,capturePayloadBytes:captureBudget});
  assert.equal(metadataMeasured,true);assert.equal(bounded.captures.length,3,'one full analysis byte budget admits FT, HT and personnel receipts without three transfers');
  assert.equal(bounded.readCoverage.loadedUniqueAnalysisRows,1);
  assert.ok(bounded.captures.every(row=>row.snapshot===bounded.captures[0].snapshot),'variant receipts share one unchanged immutable payload');
  assert.deepEqual(bounded.captures[0].snapshot,original);
  assert.equal(bounded.captures[0].revision,soccerForwardAnalysisRevision(bounded.captures[0].snapshot));
  const uniqueCaptureBytes=returnedCaptureBytes;
  await captureSoccerForwardSnapshot(original,revision);
  const retryBounded=await loadSoccerForwardEvidence(scope,{capturePayloadBytes:captureBudget});
  assert.equal(retryBounded.captures.length,3);assert.equal(retryBounded.readCoverage.loadedCapturePayloadBytes,payloadSize,'receipt retries cannot inflate the byte charge');
  assert.ok(uniqueCaptureBytes<=payloadSize);
  assert.ok(returnedCaptureBytes<=captureBudget);assert.equal(bounded.readCoverage.loadedCapturePayloadBytes,captureBudget);
  assert.equal(bounded.truncated,true);assert.ok(bounded.readCoverage.reasons.includes('CAPTURE_PAYLOAD_BYTE_BUDGET'));
  assert.match(bounded.readCoverage.guidance,/縮小/);assert.equal((await readSoccerForwardValidation(scope,{capturePayloadBytes:captureBudget})).complete,false);
  const oversizedFirst=await loadSoccerForwardEvidence(scope,{capturePayloadBytes:payloadSize-1});
  assert.equal(oversizedFirst.captures.length,0,'an oversized first payload is not loaded as a special case');
  assert.equal(oversizedFirst.truncated,true);assert.equal(oversizedFirst.readCoverage.loadedCapturePayloadBytes,0);
  const rowBound=await loadSoccerForwardEvidence(scope,{limit:1});
  assert.equal(rowBound.captures.length,1);assert.ok(rowBound.readCoverage.reasons.includes('CAPTURE_ROW_BUDGET'));
  returnedCaptureBytes=0;returnedCheckBytes=0;
  const boundedChecks=await loadSoccerForwardEvidence(scope,{query:tracedQuery,resultCheckPayloadBytes:1});
  assert.equal(returnedCheckBytes,0,'SQL never projects a result-history payload beyond its byte budget');
  assert.equal(boundedChecks.evaluations.length,0);assert.equal(boundedChecks.truncated,true);
  assert.ok(boundedChecks.incompleteResultCaptureIds.includes(ft.captureId));
  const partialChecks=await readSoccerForwardValidation(scope,{resultCheckPayloadBytes:1,now:()=>correctionTime});
  assert.equal(partialChecks.complete,false);assert.equal(partialChecks.evaluatedGameModelPeriods,0,'a truncated correction history cannot restore a score');
  assert.equal(partialChecks.groups.find(group=>group.period==='REGULATION_FT'&&group.variant==='BASELINE').pendingReasons.FORWARD_RESULT_HISTORY_READ_INCOMPLETE,1);
  const rowBoundChecks=await loadSoccerForwardEvidence(scope,{resultCheckRows:1});
  assert.ok(rowBoundChecks.readCoverage.reasons.includes('RESULT_CHECK_ROW_BUDGET'));
  assert.equal(rowBoundChecks.evaluations.length,0,'whole histories are excluded rather than taking a newest-N suffix that hides an older correction');
  assert.ok(returnedCaptureBytes<=24*1024*1024);
  await assert.rejects(()=>loadSoccerForwardEvidence(scope,{capturePayloadBytes:24*1024*1024+1}),/READ_BUDGET_INVALID/);
  const past=structuredClone(original);past.gameId='soccer:epl:200';past.evidence.game.id=past.gameId;past.evidence.game.sourceId='200';
  past.evidence.source.url=past.evidence.source.url.replace('event=100','event=200');past.evidence.game.startTime=iso(now-1000);
  // Moving kickoff across Taipei midnight also changes this fixture's board date.
  past.date=soccerDate(past.evidence.game.startTime);past.evidence.game.date=past.date;
  const pastRevision=soccerForwardAnalysisRevision(past);
  await db.query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES ('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[past.gameId,pastRevision,past.observedAt,JSON.stringify(past)]);
  await captureSoccerForwardSnapshot(past,pastRevision);
  evidence=await loadSoccerForwardEvidence({league:'epl',date:past.date});
  const pastCapture=evidence.captures.find(row=>row.gameId===past.gameId);
  assert.equal(validateSoccerForwardCapture(pastCapture,protocol,Date.now()).reason,'FORWARD_FIRST_CAPTURE_NOT_PREGAME','a backdated observed_at cannot manufacture a historical forward sample');
  await assert.rejects(()=>captureSoccerForwardSnapshot(original,'f'.repeat(64)),/ORIGINAL_SNAPSHOT_MISSING/);
  const legacy=structuredClone(original);legacy.gameId='soccer:epl:300';legacy.evidence.game.id=legacy.gameId;legacy.evidence.game.sourceId='300';
  legacy.evidence.source.url=legacy.evidence.source.url.replace('event=100','event=300');
  const legacyRevision=soccerForwardAnalysisRevision(legacy),legacyId=soccerForwardHash(['SOCCER-PROSPECTIVE-SAVED-PREDICTION-v1','epl',legacy.gameId,'REGULATION_FT','BASELINE',legacyRevision]);
  await db.query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES ('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[legacy.gameId,legacyRevision,legacy.observedAt,JSON.stringify(legacy)]);
  await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision)
    VALUES($1,$2,'epl',$3,$4::date,'REGULATION_FT','BASELINE',$5,$6)`,[legacyId,protocol.version,legacy.gameId,legacy.date,soccerForwardHash(soccerForwardModelDescriptor(legacy,'REGULATION_FT')),legacyRevision]);
  const beforeLegacy=(await db.query('SELECT captured_at FROM sports_soccer_forward_captures_v1 WHERE capture_id=$1',[legacyId])).rows[0].captured_at;
  const recovery=await runSoccerForwardValidation(scope,{limit:1,timeBudgetMs:1000,fetchResult:async()=>{throw Error('games are still upcoming');}});
  assert.equal(recovery.capturedRevisions,1,'the real runner selects an incomplete period bundle even when its FT receipt already exists');
  const recovered=(await db.query('SELECT period,variant,captured_at FROM sports_soccer_forward_captures_v1 WHERE analysis_revision=$1',[legacyRevision])).rows;
  assert.equal(recovered.length,3);assert.ok(recovered.every(row=>Date.parse(row.captured_at)<start));
  assert.equal(new Date((await db.query('SELECT captured_at FROM sports_soccer_forward_captures_v1 WHERE capture_id=$1',[legacyId])).rows[0].captured_at).toISOString(),new Date(beforeLegacy).toISOString(),'repair never replaces the original FT receipt');
  const atomic=structuredClone(legacy);atomic.gameId='soccer:epl:400';atomic.evidence.game.id=atomic.gameId;atomic.evidence.game.sourceId='400';atomic.evidence.source.url=atomic.evidence.source.url.replace('event=300','event=400');
  const atomicRevision=soccerForwardAnalysisRevision(atomic);
  await db.query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES ('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[atomic.gameId,atomicRevision,atomic.observedAt,JSON.stringify(atomic)]);
  await assert.rejects(()=>captureSoccerForwardSnapshot(atomic,atomicRevision,{query:async(sql,params=[])=>{
    if(sql.includes('INSERT INTO sports_soccer_forward_captures_v1')){const rows=JSON.parse(params[1]);rows[2].period='INVALID_PERIOD';params=[...params];params[1]=JSON.stringify(rows);}
    return (await db.query(sql,params)).rows;
  }}),/check constraint/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_forward_captures_v1 WHERE analysis_revision=$1',[atomicRevision])).rows[0].n,0,'a third-period failure rolls back the entire single-statement bundle');
  assert.equal((await captureSoccerForwardSnapshot(atomic,atomicRevision)).captures.length,3);

  // Time budget holds even when there are many eligible game/model/periods.
  let clock=after,calls=0,archives=0;
  const allEvidence=await loadSoccerForwardEvidence(scope),savedEvidence={...allEvidence,captures:allEvidence.captures.filter(row=>row.gameId===original.gameId)};
  const summary=await runSoccerForwardValidation(scope,{now:()=>clock,limit:1,timeBudgetMs:50,loadEvidence:async()=>({...savedEvidence,evaluations:[]}),query:async()=>[],
    fetchResult:async()=>{calls++;clock+=100;return result;},archive:async()=>{archives++;}});
  assert.equal(calls,1);assert.equal(archives,0);assert.equal(summary.budgetExhausted,true);assert.equal(summary.deferred,2);
  // Exercise retained ESPN payloads through the shipped fetchers, prematch
  // normalizer, model, service, immutable DB save, receipt and report. Only the
  // fixture kickoff is moved into the future so the real DB clock can admit a
  // test receipt; these records never leave this isolated fixture database.
  const {analyzeSoccerGame}=await import('../lib/soccer/analysis-service.js');
  const oldFetch=globalThis.fetch;
  const rawHash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const shiftFixture=filename=>{
    const value=JSON.parse(fs.readFileSync(new URL(`./fixtures/soccer/${filename}.json`,import.meta.url)));
    value.header.date=iso(Date.now()+3*3600000);
    const competition=value.header.competitions[0];competition.date=value.header.date;
    competition.status={...competition.status,type:{id:'1',name:'STATUS_SCHEDULED',state:'pre',completed:false}};
    return value;
  };
  try {
    for(const league of ['epl','ucl']){
      const value=shiftFixture(`${league}-summary`),competition=value.header.competitions[0],slug=value.header.league.slug;
      const scoreboard={leagues:[value.header.league],events:[{...value.header,date:competition.date,status:competition.status}]};
      const requested=[];
      globalThis.fetch=async input=>{
        const url=new URL(String(input));requested.push(url.href);assert.equal(url.origin,'https://site.api.espn.com');
        assert.equal(url.pathname.includes(`/${slug}/`),true);
        if(url.pathname.endsWith('/summary')){assert.equal(url.searchParams.get('event'),value.header.id);return Response.json(value);}
        assert.ok(url.pathname.endsWith('/scoreboard'));return Response.json(scoreboard);
      };
      const actual=await analyzeSoccerGame({league,date:soccerDate(competition.date),eventId:value.header.id},{
        fetchSoccerTeamXg:async()=>({ok:false,reason:'TEAM_XG_NOT_PART_OF_FIXTURE'}),
        fetchSoccerWorkload:async()=>({ok:false,status:'INCOMPLETE',teams:{},sources:[],modelEffectApplied:false,executable:false}),
      });
      assert.equal(actual.status,200,JSON.stringify(actual.payload));
      assert.equal(actual.payload.forwardCapture.persisted,true);assert.equal(actual.payload.forwardCapture.captures.length,3);
      assert.equal(actual.payload.evidence.game.source.url,actual.payload.evidence.source.url,'normalized game provenance belongs to the actual summary response');
      assert.equal(actual.payload.evidence.source.contentHash,rawHash(value));
      assert.equal(actual.payload.evidence.scheduleSource.contentHash,rawHash(scoreboard),'the original scoreboard response is preserved before the normalizer derives its summary game');
      assert.ok(actual.payload.evidence.scheduleSource.url.includes('/scoreboard?dates='));
      assert.ok(requested.includes(actual.payload.evidence.scheduleSource.url));
      const scheduleVersion=Object.fromEntries(['provider','url','contentHash','fetchedAt'].map(key=>[key,actual.payload.evidence.scheduleSource[key]]));
      assert.deepEqual(actual.payload.inputVersions.scheduleSourceVersion,scheduleVersion);
      for(const side of ['home','away']){
        assert.equal(actual.payload.evidence.teams[side].lineup.status,'NOT_PUBLISHED');
        assert.deepEqual(actual.payload.evidence.teams[side].lineup.rawSource,actual.payload.evidence.rawSource,'lineup retains the original summary receipt');
        for(const field of ['provider','url','contentHash','fetchedAt'])assert.equal(actual.payload.evidence.teams[side].lineup.source[field],actual.payload.evidence.source[field]);
        assert.equal(actual.payload.evidence.teams[side].lineup.source.availableAt,actual.payload.evidence.source.availableAt);
        assert.equal(actual.payload.evidence.teams[side].lineup.source.sourcePublishedAt,null);
        assert.equal(actual.payload.evidence.teams[side].lineup.source.independentlyConfirmed,false);
        assert.deepEqual(actual.payload.evidence.teams[side].lineup.source.scope,{league,gameId:actual.payload.gameId,field:`teams.${side}.lineup`});
      }
      const actualEvidence=await loadSoccerForwardEvidence({league,date:actual.payload.date});
      const actualCaptures=actualEvidence.captures.filter(row=>row.gameId===actual.payload.gameId);
      assert.equal(actualCaptures.length,3);
      assert.ok(actualCaptures.filter(row=>row.variant==='BASELINE').every(row=>validateSoccerForwardCapture(row,actualEvidence.protocol,Date.now()).ok));
      assert.equal(validateSoccerForwardCapture(actualCaptures.find(row=>row.variant==='PERSONNEL_CHALLENGER'),actualEvidence.protocol,Date.now()).reason,'FORWARD_PERSONNEL_MODEL_UNVERIFIED');
      const actualReport=buildSoccerForwardReport({...actualEvidence,captures:actualCaptures,now:Date.now()});
      assert.equal(actualReport.selectedGameModelPeriods,2,'actual service FT and HT baseline forecasts are admitted, not merely stored');
      assert.equal(actualReport.excludedReasons.FORWARD_PERSONNEL_MODEL_UNVERIFIED,1);
      assert.equal(actualReport.excludedReasons.FORWARD_INPUT_SOURCE_AVAILABILITY_UNVERIFIED,undefined);
      assert.equal(actualReport.evaluatedGameModelPeriods,0,'a pregame receipt does not manufacture a postgame outcome');
    }
    const xiPayload=shiftFixture('historic-summary'),xiCompetition=xiPayload.header.competitions[0];
    const xiBoard={leagues:[xiPayload.header.league],events:[{...xiPayload.header,date:xiCompetition.date,status:xiCompetition.status}]};
    const xiAt=Date.now(),xiSummarySource={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${xiPayload.header.id}`,contentHash:rawHash(xiPayload),fetchedAt:iso(xiAt)};
    const xiGame=normalizeSoccerSchedule(xiBoard,'epl',{...xiSummarySource,url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard?dates=${soccerDate(xiCompetition.date).replaceAll('-','')}`,contentHash:rawHash(xiBoard)}).games[0];
    const xiEvidence=normalizeSoccerPrematch(xiPayload,xiGame,xiSummarySource,xiAt),xiObservation=soccerPersonnelObservation(xiEvidence,{asOf:xiAt});
    assert.equal(xiObservation.personnel.availability,'OBSERVED_PREMATCH_XI');
    for(const side of ['home','away']){
      assert.equal(xiEvidence.teams[side].lineup.status,'PROVIDER_REPORTED_XI');assert.equal(xiEvidence.teams[side].lineup.starters.length,11);
      assert.deepEqual(xiEvidence.teams[side].lineup.rawSource,xiSummarySource);
      for(const field of ['provider','url','contentHash','fetchedAt'])assert.equal(xiEvidence.teams[side].lineup.source[field],xiSummarySource[field]);
      assert.equal(xiEvidence.teams[side].lineup.source.availableAt,xiSummarySource.fetchedAt);
      assert.equal(xiEvidence.teams[side].lineup.source.sourcePublishedAt,null);
      assert.equal(xiEvidence.teams[side].lineup.source.independentlyConfirmed,false);
      assert.deepEqual(xiEvidence.teams[side].lineup.source.scope,{league:'epl',gameId:xiEvidence.game.id,field:`teams.${side}.lineup`});
      assert.deepEqual(xiObservation.personnel.teams[side].starters,xiEvidence.teams[side].lineup.starters.map(player=>player.id));
    }
  } finally {globalThis.fetch=oldFetch;}
  // Different revisions of one game must keep their own original bytes.
  const revisedSnapshot=structuredClone(original);revisedSnapshot.readBudgetFixture='second-version';
  const secondRevision=soccerForwardAnalysisRevision(revisedSnapshot);
  await db.query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES ('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[original.gameId,secondRevision,original.observedAt,JSON.stringify(revisedSnapshot)]);
  await captureSoccerForwardSnapshot(revisedSnapshot,secondRevision);
  // An intentionally invalid same-hash/different-game DB fixture verifies that
  // read dedup is scoped by all three FK columns, not a globally assumed hash.
  // The model validator must still reject its forged revision after loading.
  const collision=structuredClone(original);collision.gameId='soccer:epl:777';collision.evidence.game.id=collision.gameId;
  collision.evidence.game.sourceId='777';collision.readBudgetFixture='different-game-same-revision';
  await db.query(`INSERT INTO sports_soccer_analysis_v1 (league,game_id,analysis_hash,observed_at,payload) VALUES ('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[collision.gameId,revision,collision.observedAt,JSON.stringify(collision)]);
  await captureSoccerForwardSnapshot(collision,revision);
  const scopedRead=await loadSoccerForwardEvidence(scope);
  const versionOne=scopedRead.captures.filter(row=>row.gameId===original.gameId&&row.revision===revision);
  const versionTwo=scopedRead.captures.filter(row=>row.gameId===original.gameId&&row.revision===secondRevision);
  const differentGame=scopedRead.captures.filter(row=>row.gameId===collision.gameId&&row.revision===revision);
  assert.equal(versionOne.length,3);assert.equal(versionTwo.length,3);assert.equal(differentGame.length,3);
  assert.deepEqual(versionOne[0].snapshot,original);assert.deepEqual(versionTwo[0].snapshot,revisedSnapshot);
  assert.deepEqual(differentGame[0].snapshot,collision);
  assert.notEqual(versionOne[0].snapshot,versionTwo[0].snapshot);assert.notEqual(versionOne[0].snapshot,differentGame[0].snapshot);
  assert.equal(validateSoccerForwardCapture(differentGame[0],protocol,Date.now()).ok,false,'dedup does not bypass original revision verification');
  const scopedUnique=new Set(scopedRead.captures.map(row=>JSON.stringify([row.league,row.gameId,row.revision])));
  assert.equal(scopedRead.readCoverage.loadedUniqueAnalysisRows,scopedUnique.size);
  const physicalBytes=(await db.query(`SELECT sum(octet_length(a.payload::text))::bigint AS n FROM sports_soccer_analysis_v1 a
    WHERE EXISTS (SELECT 1 FROM sports_soccer_forward_captures_v1 c WHERE c.league=a.league AND c.game_id=a.game_id AND c.analysis_revision=a.analysis_hash
      AND c.league='epl' AND c.board_date=$1::date)`,[original.date])).rows[0].n;
  assert.equal(scopedRead.readCoverage.loadedCapturePayloadBytes,Number(physicalBytes),'bytes are charged once per immutable composite revision');
  console.log('PASS PostgreSQL soccer forward chain: DB-clock capture after actual immutable analysis, fixed/idempotent receipts, separate absent challenger, source/league isolation, append-only results/protocol, corrections quarantined, historical backfill rejected, bounded result work and uncompressed snapshot/check read budgets without hiding correction history; retained EPL/UCL normalizer→actual service→DB→forward report with separately bound summary/scoreboard provenance and real lineup source fields.');
} finally {
  if(oldDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldDatabase;
  if(oldDatabaseV2===undefined)delete process.env.DATABASE_V2_URL;else process.env.DATABASE_V2_URL=oldDatabaseV2;
  await fixture.close();
}
