import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture, resultFor } from './helpers/soccer-forward-fixture.mjs';
import { soccerDate } from '../lib/soccer/contracts.js';
import { soccerForwardHash, soccerForwardAnalysisRevision, soccerForwardModelDescriptor, compactSoccerForwardCapture, validateSoccerForwardCapture, evaluateSoccerForwardCapture } from '../lib/soccer/forward-validation.js';
const fixture=await soccerSqlFixture(),{db}=fixture;
const oldDb=process.env.DATABASE_URL,oldDbV2=process.env.DATABASE_V2_URL;process.env.DATABASE_URL='postgres://fixture.invalid/scan';delete process.env.DATABASE_V2_URL;
try{
 const service=await import('../lib/soccer/forward-validation-service.js');
 const {continueSoccerForwardScan,continueSoccerForwardBacklog,loadSoccerForwardScanGame, SoccerForwardScanError}=await import('../lib/soccer/forward-validation-scan.js');
 const protocol=await service.ensureSoccerForwardProtocol(),now=Date.now(),iso=x=>new Date(x).toISOString();
 // This is a capacity/correctness fixture, not a benchmark of WASM PostgreSQL
 // on the host running CI. Keep its logical execution clock fixed; deadline
 // enforcement is tested separately below with an explicitly advanced clock.
 const capacityScan=(range,options={})=>continueSoccerForwardScan(range,{now:()=>now,...options});
 const p=fixtureCapture().snapshot;p.runStartedAt=p.observedAt=p.analysisCutoff=iso(now);p.date=soccerDate(now+3600000);p.evidence.game.date=p.date;p.evidence.game.startTime=iso(now+3600000);
 for(const source of [p.evidence.source,p.evidence.game.source,p.evidence.scheduleSource])source.fetchedAt=iso(now);
 p.inputVersions.evidenceFetchedAt=iso(now);p.inputVersions.scheduleSourceVersion={...p.evidence.scheduleSource};
 const revision=soccerForwardAnalysisRevision(p),scope={league:'epl',date:p.date};
 await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[p.gameId,revision,p.observedAt,JSON.stringify(p)]);
 const receipt=await service.captureSoccerForwardSnapshot(p,revision),original=(await service.loadSoccerForwardEvidence(scope)).captures.find(c=>c.period==='REGULATION_FT'&&c.variant==='BASELINE');
 assert.equal(validateSoccerForwardCapture(original,protocol,Date.now()).ok,true);
 const compact=compactSoccerForwardCapture(original,protocol,Date.now());
 assert.equal(compact.snapshot.prediction.cells,undefined);assert.equal(validateSoccerForwardCapture(compact,protocol,Date.now()).ok,true);
 assert.equal(validateSoccerForwardCapture(JSON.parse(JSON.stringify(compact)),protocol,Date.now()).ok,false,'a serialized trusted-looking compact snapshot cannot bypass original revision verification');
 assert.throws(()=>{compact.snapshot.evidence.game.startTime='2099-01-01T00:00:00Z';},TypeError,'in-process proof summaries cannot be mutated after admission');
 const result=resultFor(original);result.sources=result.sources.map(s=>({...s,fetchedAt:iso(now+7200000)}));result.observedAt=iso(now+7200000);result.halfTime=null;
 const evaluation=evaluateSoccerForwardCapture(original,protocol,result,now+7200000);assert.equal(evaluation.status,'EVALUATED');
 // >25k full archived checks and >8 MiB are read in keyset batches. A changed
 // oldest/newest outcome must remain visible, never just the latest suffix.
 const checked={version:'SOCCER-PROSPECTIVE-SAVED-PREDICTION-v1',status:'EVALUATED',evaluation,resultEvidence:result,padding:'x'.repeat(500)};
 await db.query(`INSERT INTO sports_soccer_forward_result_checks_v1(check_id,capture_id,payload)
   SELECT lpad(i::text,64,'0'),$1,$2::jsonb FROM generate_series(1,25001) i`,[original.captureId,JSON.stringify(checked)]);
 const corrected={...evaluation,actualScore:{home:0,away:1},actualOutcome:'away',resultHash:soccerForwardHash('changed-scan-result')};
 await db.query(`INSERT INTO sports_soccer_forward_result_checks_v1(check_id,capture_id,payload) VALUES($1,$2,$3::jsonb)`,['f'.repeat(64),original.captureId,JSON.stringify({...checked,evaluation:corrected})]);
 // >5000 receipts and >24 MiB UNIQUE full originals. Deliberately mismatched
 // revisions are excluded source fixtures, never admitted model evidence.
 const large=structuredClone(p);large.gameId=large.evidence.game.id='soccer:epl:900';large.evidence.game.sourceId='900';
 await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
   SELECT 'epl',$1,lpad(i::text,64,'0'),$2::timestamptz,$3::jsonb||jsonb_build_object('padding',repeat('x',17000),'revisionMarker',i) FROM generate_series(1,1701) i`,[large.gameId,p.observedAt,JSON.stringify(large)]);
 const variants=[['REGULATION_FT','BASELINE'],['REGULATION_HT','BASELINE'],['REGULATION_FT','PERSONNEL_CHALLENGER']].map(([period,variant],index)=>({period,variant,index,model:soccerForwardHash(soccerForwardModelDescriptor(large,period,variant))}));
 await db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision)
   SELECT lpad((i*3+r.index+100000)::text,64,'0'),$1,'epl',$2,$3::date,r.period,r.variant,r.model,lpad(i::text,64,'0') FROM generate_series(1,1701) i CROSS JOIN jsonb_to_recordset($4::jsonb) AS r(period text,variant text,index integer,model text)`,[protocol.version,large.gameId,p.date,JSON.stringify(variants)]);
 const before=(await db.query(`SELECT count(*)::int AS n FROM sports_soccer_forward_captures_v1`)).rows[0].n;assert.ok(before>5000);
 const physical=(await db.query(`SELECT sum(octet_length(payload::text))::bigint AS n FROM sports_soccer_analysis_v1`)).rows[0].n;assert.ok(Number(physical)>24*1024*1024);
 const checksBytes=(await db.query(`SELECT sum(octet_length(payload::text))::bigint AS n FROM sports_soccer_forward_result_checks_v1`)).rows[0].n;assert.ok(Number(checksBytes)>8*1024*1024);
 let page=await capacityScan(scope,{gameLimit:1,timeBudgetMs:25000,readOptions:{captureRows:37,resultCheckRows:701}});
 assert.equal(page.report.scan.processedGames,1);assert.equal(page.report.complete,false);assert.equal(page.report.scan.complete,false);assert.ok(page.report.scan.nextCursor);
 assert.equal(page.report.returnErrorResearch.completeWithinRequestedScope,false);
 assert.equal(page.report.conflictingResultCaptures,1,'contradictory result evidence from opposite ends of 25k history remains quarantined');
 assert.equal(page.report.readCoverage.loadedResultCheckRows,25002);
 const cursor=page.report.scan.nextCursor;
 await assert.rejects(()=>capacityScan({...scope,league:'ucl'},{cursor}),/聯盟、日期/);
 await assert.rejects(()=>capacityScan(scope,{cursor,purpose:'evaluate'}),/核對方式/);
 await assert.rejects(()=>capacityScan(scope,{cursor:'0'.repeat(48)}),/到期/);
 await db.query(`UPDATE sports_soccer_forward_scans_v1 SET lease_owner='parallel-fixture',lease_until=clock_timestamp()+interval '1 minute' WHERE cursor=$1`,[cursor]);
 await assert.rejects(()=>capacityScan(scope,{cursor}),/正在處理/);
 await db.query(`UPDATE sports_soccer_forward_scans_v1 SET lease_owner=NULL,lease_until=NULL WHERE cursor=$1`,[cursor]);
 // Late receipts/results cannot enter the frozen MVCC manifests.
 const late=structuredClone(p);late.gameId=late.evidence.game.id='soccer:epl:901';late.evidence.game.sourceId='901';const lateRev=soccerForwardAnalysisRevision(late);
 await db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[late.gameId,lateRev,late.observedAt,JSON.stringify(late)]);await service.captureSoccerForwardSnapshot(late,lateRev);
 await db.query(`INSERT INTO sports_soccer_forward_result_checks_v1(check_id,capture_id,payload) VALUES($1,$2,$3::jsonb)`,['e'.repeat(64),original.captureId,JSON.stringify(checked)]);
 page=await capacityScan(scope,{cursor,gameLimit:1,timeBudgetMs:25000,readOptions:{captureRows:37,resultCheckRows:701}});
 assert.equal(page.report.scan.processedGames,2);assert.equal(page.report.scan.totalGames,2);assert.equal(page.report.scan.nextCursor,null);assert.equal(page.report.complete,true);
 assert.equal(page.report.capturedSnapshotPeriods,before,'all >5000 sealed receipts counted once; late game excluded');
 assert.equal(page.report.readCoverage.loadedCaptureRows,before);assert.equal(page.report.readCoverage.loadedUniqueAnalysisRows,1702);
 assert.equal(page.report.readCoverage.loadedCapturePayloadBytes,Number(physical));assert.equal(page.report.readCoverage.loadedResultCheckRows,25002);
 assert.equal(page.report.conflictingResultCaptures,1);assert.equal(page.report.formalEligible,false);assert.equal(page.report.marketReturnValidation.S,null);
 assert.equal(page.report.returnErrorResearch.accepted,false);
 assert.ok(page.report.excludedReasons.FORWARD_ORIGINAL_REVISION_MISMATCH>=5103,'bad originals remain excluded, never turned into accepted samples by compaction');
 const again=await capacityScan(scope,{cursor,timeBudgetMs:25000});assert.deepEqual(again.report.groups,page.report.groups);assert.equal(again.report.capturedSnapshotPeriods,before,'terminal resume is idempotent');
 let fresh=await capacityScan(scope,{gameLimit:25,timeBudgetMs:25000,readOptions:{captureRows:37,resultCheckRows:701}});
 while(fresh.report.scan.nextCursor)fresh=await capacityScan(scope,{cursor:fresh.report.scan.nextCursor,gameLimit:25,timeBudgetMs:25000});
 assert.equal(fresh.report.capturedSnapshotPeriods,before+3);assert.equal(fresh.report.readCoverage.loadedResultCheckRows,25003,'new scan sees subsequent evidence without mutating old scan');
 // An oversized first item is rejected before loading payload bytes. No token
 // may claim complete merely because it skipped an unreadable original.
 await assert.rejects(()=>capacityScan(scope,{readOptions:{capturePayloadBytes:1},timeBudgetMs:25000}),e=>e instanceof SoccerForwardScanError&&e.code==='SOCCER_FORWARD_SCAN_INCOMPLETE'&&/安全容量/.test(e.publicMessage));
 await assert.rejects(()=>capacityScan(scope,{readOptions:{resultCheckPayloadBytes:1},timeBudgetMs:25000}),/單筆賽果/);
 const sourceCount=(await db.query('SELECT count(*)::int AS n FROM sports_soccer_forward_captures_v1')).rows[0].n;
 await db.query(`INSERT INTO sports_soccer_forward_scans_v1(cursor,scope,purpose,frozen_at,expires_at) VALUES($1,$2::jsonb,'read',clock_timestamp(),clock_timestamp()-interval '1 minute')`,['a'.repeat(48),JSON.stringify({league:'epl',from:p.date,through:p.date})]);
 await capacityScan(scope,{cursor});assert.equal((await db.query(`SELECT count(*)::int AS n FROM sports_soccer_forward_scans_v1 WHERE cursor=$1`,['a'.repeat(48)])).rows[0].n,0);
 assert.equal((await db.query('SELECT count(*)::int AS n FROM sports_soccer_forward_captures_v1')).rows[0].n,sourceCount,'expiry cleanup only removes derived scan caches');
 // Deadline behavior is independent of host throughput: expire the clock
 // after a real frozen manifest and lease, before the first payload batch.
 // The failed game must not be committed or marked complete, and its lease
 // must be released so a later request can resume it.
 let deadlineClock=now,deadlineCursor=null,expired=false;
 const deadlineQuery=async(sql,params=[])=>{
  const rows=(await db.query(sql,params)).rows;
  if(sql.includes('SET lease_owner=$2'))deadlineCursor=params[0];
  if(!expired&&sql.includes('SELECT count(*)::integer AS n FROM sports_soccer_forward_scan_captures_v1')){deadlineClock+=11;expired=true;}
  return rows;
 };
 await assert.rejects(()=>continueSoccerForwardScan(scope,{query:deadlineQuery,now:()=>deadlineClock,timeBudgetMs:10}),
  error=>error instanceof SoccerForwardScanError&&/尚未讀完/.test(error.publicMessage));
 assert.equal(expired,true);assert.ok(deadlineCursor);
 const timedOut=(await db.query('SELECT processed_games,complete,state,lease_owner,lease_until FROM sports_soccer_forward_scans_v1 WHERE cursor=$1',[deadlineCursor])).rows[0];
 assert.equal(timedOut.processed_games,0);assert.equal(timedOut.complete,false);assert.equal(timedOut.state,null);
 assert.equal(timedOut.lease_owner,null);assert.equal(timedOut.lease_until,null);
 console.log('PASS complete durable scan: >24MiB originals/>5000 receipts and >8MiB/>25k checks, fixed manifests, bounded batches, old/new correction quarantine, scope/purpose/lease fencing, terminal idempotence, safe oversized rejection, deterministic deadline abort/lease release and source-preserving cache cleanup');
}finally{if(oldDb===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=oldDb;if(oldDbV2===undefined)delete process.env.DATABASE_V2_URL;else process.env.DATABASE_V2_URL=oldDbV2;await fixture.close();}
