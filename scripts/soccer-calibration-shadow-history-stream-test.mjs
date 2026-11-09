import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerCalibrationShadowFixture } from './helpers/soccer-calibration-shadow-fixture.mjs';
import { normalizeSoccerSchedule } from '../lib/soccer/data.js';
import { normalizeSoccerPrematch } from '../lib/soccer/prematch.js';
import { retainSoccerProviderDocument } from '../lib/soccer/provider-document.js';

const fixture=await soccerSqlFixture(),{db}=fixture,old=process.env.DATABASE_URL,oldV2=process.env.DATABASE_V2_URL;
process.env.DATABASE_URL='postgres://fixture.invalid/calibration-stream';delete process.env.DATABASE_V2_URL;
const {analyzeSoccerGame}=await import('../lib/soccer/analysis-service.js');
const {loadSoccerCalibrationShadowValidationEvidence}=await import('../lib/soccer/calibration-shadow-store.js');
const {archiveSoccerCalibrationShadowEvaluation:archive,loadSoccerCalibrationShadowEvaluationHistory:whole,
  readSoccerCalibrationShadowEvaluationHistoryPage:readPage,readSoccerCalibrationHistoryRevision:revision,ensureSoccerCalibrationShadowEvaluationStore:ensure}=await import('../lib/soccer/calibration-shadow-evaluation-store.js');
const {readSoccerCalibrationShadowReport:report,evaluateSoccerCalibrationShadow:evaluate}=await import('../lib/soccer/calibration-shadow-validation.js');
const f=soccerCalibrationShadowFixture(1),iso=value=>new Date(value).toISOString(),hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
try{
  await ensure();
  const raw=structuredClone(f.source.summaries[0].data),id='994000001',kickoff=Date.now()+2500;
  raw.header.id=id;raw.header.uid=`s:600~l:700~e:${id}`;
  const competition=raw.header.competitions[0];competition.id=id;competition.uid=`${raw.header.uid}~c:${id}`;
  raw.header.date=competition.date=iso(kickoff);competition.status={type:{state:'pre',completed:false,name:'STATUS_SCHEDULED'}};
  const source={provider:'ESPN',url:`https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${id}`,
    requestedAt:iso(Date.now()-20),fetchedAt:iso(Date.now()-10),contentHash:hash(raw)};
  const game=normalizeSoccerSchedule({leagues:[raw.header.league],events:[raw.header]},'epl',source).games[0];
  const evidence=normalizeSoccerPrematch(raw,game,source,Date.now());
  const saved=await analyzeSoccerGame({league:'epl',date:game.date,eventId:id},{
    enrichSoccerPrematchInputs:async evidence=>evidence,
    fetchSoccerSchedule:async()=>({ok:true,games:[game]}),fetchSoccerPrematch:async()=>evidence,
    fetchSoccerWorkload:async()=>({ok:false}),fetchSoccerTeamXg:async()=>({ok:false}),loadSoccerReaderSnapshot:async()=>null,
  });
  assert.equal(saved.payload.calibrationShadowCapture.persisted,true,JSON.stringify(saved.payload.calibrationShadowCapture));
  const captureId=saved.payload.calibrationShadowCapture.capture.captureId;
  const remaining=kickoff-Date.now()+5;if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
  const context=await loadSoccerCalibrationShadowValidationEvidence('epl',{captureIds:[captureId]});
  const record=context.records[0];
  const documents=(revision,options={})=>{
    const docs=f.resultDocuments(record,options);
    // Changed non-result provider data reproduces repeated source documents;
    // padding is synthetic and ignored by the result normalizer.
    docs.scoreboard.data.syntheticRevision=revision;
    docs.scoreboard.data.syntheticLargeProviderText='x'.repeat(1024*1024);
    for(const document of [docs.scoreboard,...docs.summaries]){
      document.source.fetchedAt=iso(Date.now()-1);document.source.requestedAt=document.source.fetchedAt;
      document.source.contentHash=hash(document.data);
    }
    return {scoreboard:retainSoccerProviderDocument(docs.scoreboard),summaries:docs.summaries.map(retainSoccerProviderDocument)};
  };
  for(let index=0;index<9;index++)await archive({league:'epl',captureId,resultDocuments:documents(index),status:'PENDING'});
  const bytes=Number((await db.query('SELECT sum(octet_length(payload::text))::bigint AS bytes FROM sports_soccer_calibration_checks_v1')).rows[0].bytes);
  assert.ok(bytes>16*1024*1024,'actual JSONB history exceeds the previous whole-history budget');
  await assert.rejects(()=>whole('epl',{captureIds:[captureId]}),/EXCEEDS_READ_BUDGET/);
  let afterCheckId='',count=0,pages=0;
  do{const page=await readPage('epl',{captureIds:[captureId],afterCheckId,byteBudget:3*1024*1024});
    assert.ok(page.loadedBytes<=3*1024*1024);count+=page.checks.length;pages++;
    if(page.completeWithinRequestedScope){assert.equal(page.totalCheckRows,count);break;}
    assert.ok(page.nextCheckId>afterCheckId);afterCheckId=page.nextCheckId;
  }while(true);
  assert.equal(count,9);assert.ok(pages>=9);
  const first=await report('epl');
  const firstRevision=await revision('epl',context.freezeReceipt.freezeId);
  assert.equal(firstRevision.captures,1);
  const firstPage=await report('epl',{}, {afterSequence:'0',revision:null});
  assert.equal(firstPage.validationPage.revision,firstRevision.revision);
  assert.equal(firstPage.validationPage.reachedEnd,true);
  assert.equal(firstPage.validationCoverage.completeWithinRequestedScope,true);
  assert.equal((await revision('ucl',context.freezeReceipt.freezeId)).captures,0);
  assert.equal(first.untouchedValidatedGames,1,'stored PENDING flags do not replace full revalidation of original provider data');
  assert.equal(first.validationCoverage.completeWithinRequestedScope,true);assert.equal(first.validationCoverage.readResultCheckRows,9);
  assert.equal(first.validation.before.FT.games,1);assert.equal(first.validation.after.HT.games,1);
  // A conflicting original result followed by another matching/latest check
  // must remain quarantined across every byte-bounded history page.
  await archive({league:'epl',captureId,resultDocuments:documents(10,{homeScore:2}),status:'EVALUATED'});
  await archive({league:'epl',captureId,resultDocuments:documents(11),status:'EVALUATED'});
  const corrected=await report('epl');
  assert.notEqual((await revision('epl',context.freezeReceipt.freezeId)).revision,firstRevision.revision);
  await assert.rejects(()=>report('epl',{}, {afterSequence:'0',revision:firstRevision.revision}),e=>e.status===409);
  assert.equal(corrected.quarantinedGames,1);assert.equal(corrected.untouchedValidatedGames,0);
  assert.equal(corrected.validation.before.FT.games,0);assert.equal(corrected.validation.after.HT.games,0);
  assert.equal(corrected.validationCoverage.readResultCheckRows,11);assert.equal(corrected.accepted,false);
  let clock=Date.now();
  const partial=await report('epl',{now:()=>clock,readHistoryPage:async(...args)=>{const page=await readPage(...args);clock+=20000;return page;}});
  assert.equal(partial.validationStatus,'PARTIAL_HISTORY_READ');assert.equal(partial.validationCoverage.completeWithinRequestedScope,false);
  assert.equal(partial.validationCoverage.readCaptures,0,'an unfinished capture scope admits no earlier metrics before later conflicts are inspected');
  let partialClock=Date.now(),archivedCurrent=0;
  const partialPost=await evaluate({league:'epl',limit:1},{now:()=>partialClock,
    readHistoryPage:async(...args)=>{const page=await readPage(...args);partialClock+=20000;return page;},
    archive:async()=>{archivedCurrent++;return {persisted:true};},
    fetchJson:async url=>{const docs=documents(12);return url.includes('/summary?')?docs.summaries[0]:docs.scoreboard;}});
  assert.equal(partialPost.summary.status,'PARTIAL_HISTORY_READ');assert.equal(partialPost.summary.persisted,false);
  assert.equal(archivedCurrent,0,'an exhausted pre-archive replay cannot report cron persistence success');
  const checked=await evaluate({league:'epl',limit:1},{fetchJson:async url=>{const docs=documents(12);return url.includes('/summary?')?docs.summaries[0]:docs.scoreboard;}});
  assert.equal(checked.summary.quarantinedGames,1,'POST also replays all prior conflict evidence through bounded pages');
  assert.equal(checked.summary.validatedGames,0);assert.equal(checked.summary.persisted,true);
  console.log('PASS actual PostgreSQL >16MiB immutable calibration history: bounded full-source pages, complete replay/dedup, older conflict survives newest matching result, GET/POST preserve quarantine and timing, deadline remains explicit partial; no cap increase or stored-PASS admission');
}finally{if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;if(oldV2===undefined)delete process.env.DATABASE_V2_URL;else process.env.DATABASE_V2_URL=oldV2;await fixture.close();}
