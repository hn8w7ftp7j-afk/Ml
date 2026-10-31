import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { fixtureCapture, resultFor } from './helpers/soccer-forward-fixture.mjs';
import { soccerDate } from '../lib/soccer/contracts.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { soccerForwardAnalysisRevision, soccerForwardHash, evaluateSoccerForwardCapture, buildSoccerForwardReport } from '../lib/soccer/forward-validation.js';
import { evaluateSoccerMarketReturnCapture } from '../lib/soccer/market-return-validation.js';
import { buildSoccerRetrospectivePayoffReport, buildSoccerRetrospectivePayoffReportHydrated } from '../lib/soccer/retrospective-payoff.js';

// Synthetic clock counterexample in the actual PostgreSQL-backed scanner.
// The first/latest checks have source times after their own DB receipts, while
// an intermediate check is valid. Identical economic/result keys must not let
// compaction discard that usable original evidence.
const fixture = await soccerSqlFixture(), { db } = fixture;
const env = Object.fromEntries(['DATABASE_URL', 'DATABASE_V2_URL'].map(key => [key, process.env[key]]));
process.env.DATABASE_URL = 'postgres://fixture.invalid/retrospective-proof-retention';
delete process.env.DATABASE_V2_URL;
const iso = value => new Date(value).toISOString();
try {
  const service = await import('../lib/soccer/forward-validation-service.js');
  const { SOCCER_FORWARD_SCAN_SCHEMA, loadSoccerForwardScanGame } = await import('../lib/soccer/forward-validation-scan.js');
  const protocol = await service.ensureSoccerForwardProtocol();
  const query = async (sql, params=[]) => (await db.query(sql, params)).rows;
  const base = Date.now(), kickoff = base + 3600000, sourceAt = base + 7200000, now = sourceAt + 10000;
  const snapshot = fixtureCapture({ id:'700' }).snapshot;
  snapshot.runStartedAt = snapshot.observedAt = snapshot.analysisCutoff = iso(base);
  snapshot.date = snapshot.evidence.game.date = soccerDate(kickoff);
  snapshot.evidence.game.startTime = iso(kickoff);
  for (const source of [snapshot.evidence.source, snapshot.evidence.game.source, snapshot.evidence.scheduleSource]) source.fetchedAt = iso(base);
  snapshot.inputVersions.evidenceFetchedAt = iso(base);
  snapshot.inputVersions.scheduleSourceVersion = {...snapshot.evidence.scheduleSource};
  snapshot.directions = buildSoccerMarketDirections({game:snapshot.evidence.game,now:base,
    reader:{revision:soccerForwardHash('retention-reader'),observationId:soccerForwardHash('retention-observation'),
      observedAt:iso(base),firstFetchedAt:iso(base),receivedAt:iso(base),persistedAt:iso(base),
      sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'},
    matchedGames:[{officialGameId:snapshot.gameId,league:'EPL',boardDate:snapshot.date,matchStatus:'MATCHED',prestart:true,
      markets:[{period:'FT',kind:'TOTAL',unit:'GOALS',line:'2.5',overWater:.95,underWater:.9,
        rawRows:['大2.5 .95','小 .9'],periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:'英格蘭超級聯賽',tableHeaders:['全場'],marketHeader:'全場大小'}}]}]});
  const revision = soccerForwardAnalysisRevision(snapshot);
  await query(`INSERT INTO sports_soccer_analysis_v1(league,game_id,analysis_hash,observed_at,payload)
    VALUES('epl',$1,$2,$3::timestamptz,$4::jsonb)`,[snapshot.gameId,revision,snapshot.observedAt,JSON.stringify(snapshot)]);
  await service.captureSoccerForwardSnapshot(snapshot,revision);
  const full = (await service.loadSoccerForwardEvidence({league:'epl',date:snapshot.date})).captures
    .find(row=>row.period==='REGULATION_FT'&&row.variant==='BASELINE');
  const checks = [];
  for (const [name,dbAt,logicalAt,fetchedAt] of [
    ['first',sourceAt-1000,sourceAt+1000,sourceAt],
    ['middle',sourceAt+2000,sourceAt+1000,sourceAt],
    ['latest',sourceAt+4000,sourceAt+6000,sourceAt+5000],
  ]) {
    const result = resultFor(full);
    result.observedAt = iso(fetchedAt); result.sources = result.sources.map(source=>({...source,fetchedAt:iso(fetchedAt)}));
    const evaluation = evaluateSoccerForwardCapture(full,protocol,result,now);
    assert.equal(evaluation.status,'EVALUATED');
    evaluation.marketReturnValidation = evaluateSoccerMarketReturnCapture({capture:full,protocol,result,now:logicalAt});
    assert.equal(evaluation.marketReturnValidation.status,'PENDING');
    const checkId = soccerForwardHash(['retention-check',name]);
    const payload = {status:'EVALUATED',evaluation,resultEvidence:result};
    await query(`INSERT INTO sports_soccer_forward_result_checks_v1(check_id,capture_id,checked_at,payload)
      VALUES($1,$2,$3::timestamptz,$4::jsonb)`,[checkId,full.captureId,iso(dbAt),JSON.stringify(payload)]);
    checks.push({captureId:full.captureId,checkId,checkedAt:iso(dbAt),resultEvidence:result,evaluation});
  }
  const before = {protocol,captures:[full],checks,evaluations:checks.map(row=>row.evaluation)};
  const oracle = buildSoccerRetrospectivePayoffReport(before,{now});
  assert.equal(oracle.replayedQuoteObservations,2,'the full history contains a genuinely usable middle receipt');
  for (const sql of SOCCER_FORWARD_SCAN_SCHEMA) await query(sql);
  const cursor = 'a'.repeat(48), scope={league:'epl',from:snapshot.date,through:snapshot.date};
  await query(`INSERT INTO sports_soccer_forward_scans_v1(cursor,scope,purpose,frozen_at,total_games)
    VALUES($1,$2::jsonb,'read',$3::timestamptz,1)`,[cursor,JSON.stringify(scope),iso(now)]);
  await query(`INSERT INTO sports_soccer_forward_scan_captures_v1(cursor,capture_id,capture_sequence,league,game_id)
    VALUES($1,$2,$3,'epl',$4)`,[cursor,full.captureId,full.captureSequence,full.gameId]);
  for (const check of checks) await query('INSERT INTO sports_soccer_forward_scan_checks_v1(cursor,check_id) VALUES($1,$2)',[cursor,check.checkId]);
  const loaded = await loadSoccerForwardScanGame(cursor,{league:'epl',game_id:full.gameId},{query,protocol,now});
  assert.equal(loaded.readCoverage.loadedResultCheckRows,3);
  assert.ok(loaded.checks.some(row=>row.checkId===checks[1].checkId),'compaction retains the usable middle DB receipt');
  const replay = await buildSoccerRetrospectivePayoffReportHydrated(loaded,{now,hydrateCapture:async id=>{
    assert.equal(id,full.captureId);return full;
  }});
  assert.equal(replay.replayedQuoteObservations,oracle.replayedQuoteObservations);
  assert.equal(replay.pendingQuoteObservations,0);
  assert.deepEqual(replay.groups,oracle.groups,'compaction preserves the hypothetical payoff calculation');
  const legacyBefore=buildSoccerForwardReport({...before,now}),legacyAfter=buildSoccerForwardReport({...loaded,now});
  for (const key of ['evaluatedGameModelPeriods','conflictingResultCaptures','formalEligible','promotionEligible'])
    assert.equal(legacyAfter[key],legacyBefore[key],`legacy ${key} remains unchanged`);
  assert.equal(replay.formalEligible,false);assert.equal(replay.accountSettlementVerified,false);
  assert.equal(replay.W,null);assert.equal(replay.R,null);assert.equal(replay.S,null);
  console.log('PASS actual scanner proof retention: invalid first/latest DB source receipts cannot displace valid middle proof; full-history and compacted replay agree without changing legacy results or formal eligibility');
} finally {
  for(const [key,value] of Object.entries(env)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  await fixture.close();
}
