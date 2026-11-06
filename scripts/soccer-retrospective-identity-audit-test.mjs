import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
const fixture=await soccerSqlFixture(),old={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/later-source-identity';delete process.env.DATABASE_V2_URL;
const {soccerProviderIdentityFixture}=await import('./helpers/soccer-provider-identity-fixture.mjs');
const {fetchSoccerRetrospectiveIdentityAudit,soccerRetrospectiveIdentityCandidates}=await import('../lib/soccer/retrospective-identity-audit.js');
const {readSoccerRetrospectivePairDiagnostic}=await import('../lib/soccer/retrospective-pair-service.js');
const {buildSoccerRetrospectivePairDiagnostic}=await import('../lib/soccer/retrospective-pair-diagnostic.js');
const {SOCCER_FORWARD_SCHEMA}=await import('../lib/soccer/forward-validation-service.js');
const {SOCCER_FORWARD_VERSION,SOCCER_FORWARD_POLICY,soccerForwardHash,soccerForwardAnalysisRevision,soccerForwardModelDescriptor}=await import('../lib/soccer/forward-validation.js');
const {soccerReaderIdentityVerified}=await import('../lib/soccer/reader-identity-proof.js');
const {canonicalSoccerMarketReturnCaptures}=await import('../lib/soccer/market-return-validation.js');
const {soccerReaderHash}=await import('../lib/soccer/reader.js');
const {canonicalSoccerPayload}=await import('../reader/soccer-parser.js');
const {loadSoccerRetrospectiveReaderReceipts,loadSoccerRetrospectiveGameReaderReceipts}=await import('../lib/soccer/retrospective-reader-receipts.js');

// Retained provider fixture and real adapter/parser/normalizer, without an
// identity authority mock. Dates and database are controlled test observations.
const f=await soccerProviderIdentityFixture(),{now,game,date,raw}=f,iso=value=>new Date(value).toISOString();
const snapshot={...f.build(structuredClone(f.board)),runStartedAt:iso(now-1000)};
assert.equal(snapshot.readerIdentityEvidence,null);assert.equal(snapshot.directions.flatMap(row=>row.quotes).length,0);
assert.ok(snapshot.provisionalReaderResearch.quotes.length);
const protocol={version:SOCCER_FORWARD_VERSION,activatedAt:iso(now-60000),policy:SOCCER_FORWARD_POLICY};
const revision=soccerForwardAnalysisRevision(snapshot),capture={captureId:soccerForwardHash('legacy-real-adapter-fixture'),captureSequence:'1',
  league:'epl',gameId:game.id,date,period:'REGULATION_FT',variant:'BASELINE',modelHash:soccerForwardHash(soccerForwardModelDescriptor(snapshot,'REGULATION_FT','BASELINE')),
  revision,capturedAt:iso(now+1000),snapshot};
const auditAt=Date.parse(game.startTime)+86400000,finalRaw=structuredClone(raw);
finalRaw.status=finalRaw.competitions[0].status={type:{state:'post',completed:true,name:'STATUS_FULL_TIME'}};
for(const team of finalRaw.competitions[0].competitors)team.score='0';
const network=events=>async()=>Response.json({leagues:[f.payload.header.league],events});
const audit=await fetchSoccerRetrospectiveIdentityAudit(game,{now:()=>auditAt,fetchImpl:network([finalRaw])});
assert.equal(audit.status,'LATER_SOURCE_SCOPED_IDENTITY_VERIFIED',JSON.stringify(audit));
assert.ok(audit.sources.every(source=>Date.parse(source.fetchedAt)>Date.parse(game.startTime)));
assert.equal(audit.verifiedAtOriginalCutoff,false);assert.equal(audit.dateBoardCompletenessVerified,false);
assert.equal(soccerRetrospectiveIdentityCandidates(audit,game,auditAt)[0].status,'final','audit never rewrites current final status to scheduled');
assert.equal(soccerRetrospectiveIdentityCandidates(structuredClone(audit),game,auditAt),null,'JSON hashes and flags cannot issue private receipt');
assert.equal(soccerRetrospectiveIdentityCandidates(audit,game,auditAt-1),null);
assert.equal(soccerRetrospectiveIdentityCandidates(audit,game,auditAt+180000),null,'a later use cannot call an old receipt fresh');
assert.equal(soccerRetrospectiveIdentityCandidates(audit,{...game,startTime:iso(Date.parse(game.startTime)+60000)},auditAt),null);
const duplicate=structuredClone(finalRaw);duplicate.id='987654321';duplicate.uid=undefined;duplicate.competitions[0].id=duplicate.id;duplicate.competitions[0].uid=undefined;
assert.equal((await fetchSoccerRetrospectiveIdentityAudit(game,{now:()=>auditAt,fetchImpl:network([finalRaw,duplicate])})).status,'UNAVAILABLE');
assert.equal((await fetchSoccerRetrospectiveIdentityAudit(game,{now:()=>auditAt,fetchImpl:async()=>({ok:false,status:503})})).status,'UNAVAILABLE');

try{
  const {ensureSoccerJournal,soccerJournalHash}=await import('../lib/soccer/journal.js');
  await ensureSoccerJournal();for(const sql of SOCCER_FORWARD_SCHEMA)await fixture.db.query(sql);
  await fixture.db.query(`INSERT INTO sports_soccer_forward_protocol_v1(protocol_version,policy_hash,policy,activated_at) VALUES($1,$2,$3,$4)`,
    [protocol.version,soccerForwardHash(protocol.policy),JSON.stringify(protocol.policy),protocol.activatedAt]);
  await fixture.db.query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload) VALUES($1,$2,$3,$4,$5)`,
    ['epl',game.id,revision,snapshot.observedAt,JSON.stringify(snapshot)]);
  await fixture.db.query(`INSERT INTO sports_soccer_forward_captures_v1(capture_id,protocol_version,league,game_id,board_date,period,variant,model_hash,analysis_revision,captured_at)
    VALUES($1,$2,'epl',$3,$4,'REGULATION_FT','BASELINE',$5,$6,$7)`,[capture.captureId,protocol.version,game.id,date,capture.modelHash,revision,capture.capturedAt]);
  const payload=structuredClone(f.reader);
  for(const key of['revision','observationId','firstFetchedAt','receivedAt','persistedAt'])delete payload[key];
  payload.observedAt=iso(now+30000);payload.contentHash=soccerReaderHash(canonicalSoccerPayload(payload));
  const observationId=soccerJournalHash(payload),periodHash=period=>{
    const games=payload.games.filter(row=>row.periodsCovered?.includes(period)||row.markets.some(m=>m.period===period)).map(row=>{
      const markets=row.markets.filter(m=>m.period===period).map(({serverObservation,...market})=>market),state=row.periodStates?.[period]||(markets.length?'open':'locked');
      return{...row,periodsCovered:[period],periodStates:{[period]:state},marketStatus:state,markets};});
    return soccerJournalHash({league:payload.league,boardDate:date,period,games});
  };
  await fixture.db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,persisted_at,payload)
    VALUES($1,'EPL',$2,$3,$4,$5,$6,$7)`,[observationId,date,payload.contentHash,payload.observedAt,iso(now+31000),iso(now+32000),JSON.stringify(payload)]);
  for(const period of payload.periodsCovered)await fixture.db.query(`INSERT INTO sports_soccer_reader_period_observations_v2(observation_id,period,content_hash) VALUES($1,$2,$3)`,[observationId,period,periodHash(period)]);
  const before=JSON.stringify(snapshot),sql=globalThis.__SOCCER_TEST_SQL;let writes=0;
  globalThis.__SOCCER_TEST_SQL=async(queries,tx)=>{writes+=queries.filter(row=>/^\s*(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)/i.test(row.query)).length;return sql(queries,tx);};
  const scope={league:'epl',date,gameId:game.id};
  const report=await readSoccerRetrospectivePairDiagnostic(scope,{now:auditAt,auditIdentity:async()=>audit});
  assert.equal(report.status,'RESEARCH_DIAGNOSTIC_AVAILABLE',JSON.stringify(report));assert.equal(report.selectedPairCount,4);
  assert.equal(report.readerContentValidated,true);assert.equal(report.readerObservationCount,1);assert.equal(writes,0);
  assert.equal(report.dateCoverage,'PARTIAL_SINGLE_GAME');assert.equal(report.dateBoardCompletenessVerified,false);
  assert.equal(report.verifiedAtOriginalCutoff,false);assert.equal(report.formalEligible,false);assert.equal(report.OOS,false);
  for(const pair of report.pairs){assert.equal(pair.predictionAnalysisCutoff,snapshot.analysisCutoff);assert.equal(pair.predictionCapturedAt,capture.capturedAt.replace('Z','000Z'));
    assert.equal(pair.identityAuditHash,audit.contentHash);assert.equal(pair.identityVerifiedAt,audit.verifiedAt);assert.ok(Date.parse(pair.decisionAt)<Date.parse(game.startTime));}
  assert.equal(JSON.stringify(snapshot),before);assert.equal(soccerReaderIdentityVerified(snapshot),false);
  assert.equal(soccerReaderIdentityVerified({...snapshot,readerIdentityEvidence:audit}),false,'later audit cannot impersonate original-cutoff identity proof');
  assert.equal(canonicalSoccerMarketReturnCaptures([capture],protocol,auditAt).observations.length,0,'later audit never authorizes original or current return cohort');
  const forged=await readSoccerRetrospectivePairDiagnostic(scope,{now:auditAt,auditIdentity:async()=>structuredClone(audit)});
  assert.equal(forged.selectedPairCount,null);assert.equal(forged.readerContentValidated,false);
  const receipts=await loadSoccerRetrospectiveReaderReceipts('epl',date,{maxRows:1000});
  const unknown=structuredClone(receipts);
  for(const row of unknown.rows)for(const rawGame of row.payload.games)for(const market of rawGame.markets){market.period='UNKNOWN';market.periodEvidence={status:'UNKNOWN',tableHeaders:[],sectionTitle:'英格蘭超級聯賽'};}
  const blocked=buildSoccerRetrospectivePairDiagnostic({league:'epl',date,protocol,captures:[capture],reader:unknown,identityAudit:audit,now:auditAt});
  assert.equal(blocked.selectedPairCount,0,'later identity cannot infer a missing market period');
  // Reproduce the Production aggregate-byte failure with whole valid originals,
  // including padding outside the selected-game projection. Every full journal
  // hash must still be verified before discarding any original content.
  for(let index=0;index<17;index++){
    const large={...structuredClone(payload),observedAt:iso(now+40000+index),fixturePadding:'x'.repeat(1024*1024)};
    large.contentHash=soccerReaderHash(canonicalSoccerPayload(large));const id=soccerJournalHash(large);
    await fixture.db.query(`INSERT INTO sports_soccer_reader_observations_v2(observation_id,league,board_date,content_hash,source_observed_at,received_at,persisted_at,payload)
      VALUES($1,'EPL',$2,$3,$4,$5,$6,$7)`,[id,date,large.contentHash,large.observedAt,iso(now+41000+index),iso(now+42000+index),JSON.stringify(large)]);
    for(const period of payload.periodsCovered)await fixture.db.query(`INSERT INTO sports_soccer_reader_period_observations_v2(observation_id,period,content_hash) VALUES($1,$2,$3)`,[id,period,periodHash(period)]);
  }
  assert.equal((await loadSoccerRetrospectiveReaderReceipts('epl',date,{maxRows:1000})).status,'PARTIAL','old one-response aggregate exceeds16MiB');
  const paged=await loadSoccerRetrospectiveGameReaderReceipts('epl',date,game);
  assert.equal(paged.status,'COMPLETE',JSON.stringify({...paged,rows:undefined}));assert.equal(paged.verifiedOriginalCount,18);
  assert.ok(paged.observedBytes>16*1024*1024);assert.ok(paged.rawPayloadPages>1);
  assert.ok(paged.rows.every(row=>row.fullPayloadHashVerified===true&&!Object.hasOwn(row.payload,'fixturePadding')));
  const largeReport=await readSoccerRetrospectivePairDiagnostic(scope,{now:auditAt,auditIdentity:async()=>audit});
  assert.equal(largeReport.selectedPairCount,4);assert.equal(largeReport.verifiedReaderOriginalCount,18);
  const tiny=await loadSoccerRetrospectiveGameReaderReceipts('epl',date,game,{maxTotalBytes:1024});
  assert.equal(tiny.status,'PARTIAL');assert.deepEqual(tiny.rows,[]);assert.ok(tiny.reasonCodes.includes('READER_RECEIPT_TOTAL_BYTE_BUDGET'));
  const {soccerJournalQuery}=await import('../lib/soccer/journal.js');
  const corrupt=await loadSoccerRetrospectiveGameReaderReceipts('epl',date,game,{query:async(statement,values)=>{
    const result=await soccerJournalQuery(statement,values);
    if(statement.includes("'payload',o.payload")&&result[0]?.items?.length)result[0].items[0].payload.fixturePadding='tampered outside selected game';
    return result;
  }});
  assert.equal(corrupt.status,'PARTIAL');assert.deepEqual(corrupt.rows,[]);assert.ok(corrupt.reasonCodes.includes('READER_ORIGINAL_CONTENT_VALIDATION_FAILED'));
  const stalledAt=Date.now(),stalled=await loadSoccerRetrospectiveGameReaderReceipts('epl',date,game,{budgetMs:5,query:()=>new Promise(()=>{})});
  assert.equal(stalled.status,'PARTIAL');assert.equal(stalled.observedCount,null);assert.ok(Date.now()-stalledAt<500,'consumer bounds even a never-resolving database read');
  console.log('PASS later historical identity: real adapter/parser/immutable PostgreSQL readback, four legacy pairs, >16MiB full-original paged hash validation, original clocks, fresh private later audit, forged/ambiguous/missing source, corrupt omitted content, byte limits and unknown period rejection; no formal/OOS authority');
}finally{for(const[key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await fixture.close();}
