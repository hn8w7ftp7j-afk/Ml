import assert from 'node:assert/strict';
import { buildSoccerRetrospectivePairDiagnostic } from '../lib/soccer/retrospective-pair-diagnostic.js';
import { fixtureCapture, changed, protocol, iso, captured, start, after, sha } from './helpers/soccer-forward-fixture.mjs';
import { matchSoccerReaderGames } from '../lib/soccer/reader.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import '../reader/soccer-teams.js';
const capture = changed(fixtureCapture(), row => {
  row.snapshot.evidence.game.home.name = 'Arsenal';
  row.snapshot.evidence.game.away.name = 'Manchester City';
  row.snapshot.directions = [];
});
const { game } = capture.snapshot.evidence, date = game.date;
function receipt(ms, line = '2.5', league = 'EPL') {
  const observedAt = iso(ms), id = sha([ms,line,league]);
  return {observationId:id, contentHash:sha(['content',line]), sourceObservedAt:observedAt,
    receivedAt:iso(ms+1000), persistedAt:iso(ms+2000), deviceHash:sha('test-device'),
    periods:[{period:'FT',contentHash:sha(['ft',line])}], payload: {league,boardDate:date, observedAt,
      sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/',periodsCovered:['FT'],games:[{
        league,boardDate:date,boardTime:'19:00',homeKey:globalThis.Tai888SoccerTeams.key('Arsenal'),awayKey:globalThis.Tai888SoccerTeams.key('Manchester City'),
        homeRaw:'Arsenal',awayRaw:'Manchester City',markets:[{period:'FT',kind:'TOTAL',unit:'GOALS',line,overWater:.9,underWater:.95,
          rawRows:[`大${line} 0.9`,'小 0.95'],periodEvidence:{period:'FT',status:'EXPLICIT',sectionTitle:'英格蘭超級聯賽',tableHeaders:['全場'],marketHeader:'全場大小'}}]}]}};
}
const first = receipt(captured+30000), repeat = receipt(captured+60000), different = receipt(captured+90000,'3.5');
const input = {league:'epl',date,protocol,captures:[capture],reader:{status:'COMPLETE',rows:[repeat,different,first]},now:after};
const before = JSON.stringify(input);
const report = buildSoccerRetrospectivePairDiagnostic(input);
assert.equal(report.status,'RESEARCH_DIAGNOSTIC_AVAILABLE');
assert.equal(report.selectedPairCount,4,JSON.stringify(report));
assert.equal(report.uniqueGames,1);
assert.equal(report.duplicatePriceCount,2);
assert.equal(report.formalEligible,false); assert.equal(report.R,null); assert.equal(report.OOS,false);
assert.equal(report.forecastCoverage,'NOT_VERIFIED');
assert.equal(JSON.stringify(input),before,'never rewrite forecast or source receipts');
assert.ok(report.pairs.every(row=>row.captureId===capture.captureId && row.predictionCapturedAt===capture.capturedAt));
assert.ok(report.pairs.filter(row=>row.sourceObservationId===first.observationId).length===2,'first usable receipt wins independent of input order');
const laterForecast=changed(capture,row=>{row.captureId=sha('later-same-model');row.captureSequence='2';row.capturedAt=iso(captured+1000);});
const firstForecast=buildSoccerRetrospectivePairDiagnostic({...input,captures:[laterForecast,capture]});
assert.ok(firstForecast.pairs.every(row=>row.captureId===capture.captureId),'same game/model/period uses the earliest validated forecast independent of input order');
const tied=changed(capture,row=>{row.captureId=sha('same-millisecond-capture');row.captureSequence='2';row.snapshot.note='a separately saved revision';});
const uncertain=buildSoccerRetrospectivePairDiagnostic({...input,captures:[capture,tied]});
assert.equal(uncertain.status,'PARTIAL');assert.equal(uncertain.selectedPairCount,0);assert.ok(uncertain.excludedReasons.FORECAST_TIME_TIE_AMBIGUOUS);
assert.ok(!JSON.stringify(report).includes(first.deviceHash),'never leak device identity');
const partial = buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'PARTIAL',rows:[first],reasonCodes:['READER_RECEIPT_ROW_BUDGET']}});
assert.equal(partial.status,'PARTIAL'); assert.equal(partial.selectedPairCount,0);
assert.ok(partial.excludedReasons.READER_RECEIPT_ROW_BUDGET);
const budgetCaptures=Array.from({length:21},(_,i)=>changed(capture,row=>{row.gameId=`soccer:epl:${100+i}`;row.snapshot.gameId=row.gameId;
  row.snapshot.evidence.game.id=row.gameId;row.snapshot.evidence.game.sourceId=String(100+i);
  row.snapshot.evidence.source.url=row.snapshot.evidence.source.url.replace('event=100',`event=${100+i}`);
  row.snapshot.evidence.game.source.url=row.snapshot.evidence.game.source.url.replace('event=100',`event=${100+i}`);}));
const budget=buildSoccerRetrospectivePairDiagnostic({...input,captures:budgetCaptures,reader:{status:'COMPLETE',rows:Array(1000).fill(first)}});
assert.equal(budget.status,'PARTIAL');assert.ok(budget.excludedReasons.PAIR_COMPARISON_BUDGET);
assert.deepEqual(budget.pairs,[],'comparison budget cannot yield a falsely complete prefix');
const foreign = buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'COMPLETE',rows:[receipt(captured+30000,'2.5','UCL')]}});
assert.equal(foreign.selectedPairCount,0); assert.ok(foreign.excludedReasons.READER_SCOPE_MISMATCH);
const early = buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'COMPLETE',rows:[receipt(captured-1000)]}});
assert.equal(early.selectedPairCount,0); assert.ok(early.excludedReasons.READER_NOT_AFTER_FORECAST);
const stale = receipt(captured+30000); stale.persistedAt=iso(captured+30000+180000);
assert.equal(buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'COMPLETE',rows:[stale]}}).selectedPairCount,0);
const late = receipt(start+1000);
assert.equal(buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'COMPLETE',rows:[late]}}).selectedPairCount,0);
const future=buildSoccerRetrospectivePairDiagnostic({...input,now:captured+40000,reader:{status:'COMPLETE',rows:[repeat]}});
assert.equal(future.selectedPairCount,0);assert.ok(future.excludedReasons.READER_DECISION_IN_FUTURE);
const tampered=structuredClone(capture); tampered.snapshot.prediction.cells[0].probability=.999;
assert.equal(buildSoccerRetrospectivePairDiagnostic({...input,captures:[tampered]}).selectedPairCount,0);
const renamed=changed(capture,row=>{row.captureId=sha('conflicting-team-label');row.captureSequence='2';row.snapshot.evidence.game.home.nameZh='利物浦';});
const conflict=buildSoccerRetrospectivePairDiagnostic({...input,captures:[capture,renamed]});
assert.equal(conflict.selectedPairCount,0);assert.ok(conflict.excludedReasons.FORECAST_GAME_CONTEXT_CONFLICT);
const post = receipt(captured+30000); post.payload.games[0].boardTime='19:01';
assert.equal(buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'COMPLETE',rows:[post]}}).selectedPairCount,0);
// The oldest available decision wins, even if an earlier DB receipt carried
// a source clock further into the future. Arrival order cannot pick a winner.
const skew=receipt(captured+120000), earlierDecision=receipt(captured+80000);
skew.receivedAt=iso(captured+50000);skew.persistedAt=iso(captured+51000);
const skewResult=buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'COMPLETE',rows:[skew,earlierDecision]}});
assert.ok(skewResult.pairs.every(row=>row.sourceObservationId===earlierDecision.observationId));
const preciseTime=(base,micros)=>iso(base).replace('Z',`${String(micros).padStart(3,'0')}Z`);
const subMsLate=receipt(captured+30000),subMsEarly=receipt(captured+30000);
subMsLate.observationId=sha('later-source-clock');subMsEarly.observationId=sha('earlier-full-receipt');
subMsLate.sourceObservedAt=subMsLate.payload.observedAt=preciseTime(captured+30000,900);
subMsLate.receivedAt=preciseTime(captured+30000,50);subMsLate.persistedAt=preciseTime(captured+30000,100);
subMsEarly.sourceObservedAt=subMsEarly.payload.observedAt=preciseTime(captured+30000,200);
subMsEarly.receivedAt=preciseTime(captured+30000,250);subMsEarly.persistedAt=preciseTime(captured+30000,300);
const precise=buildSoccerRetrospectivePairDiagnostic({...input,reader:{status:'COMPLETE',rows:[subMsLate,subMsEarly]}});
assert.ok(precise.pairs.every(row=>row.sourceObservationId===subMsEarly.observationId),
  'exact first availability wins over earlier persistedAt when source clocks differ within a millisecond');
// Existing snapshot-priced economic directions are not silently counted a second time.
const decision=captured+32000;
const reader={...first.payload,revision:first.observationId,observationId:first.observationId,
  observedAt:first.sourceObservedAt,firstFetchedAt:first.receivedAt,receivedAt:first.receivedAt,persistedAt:first.persistedAt};
const priced=changed(capture,row=>{
  row.snapshot.directions=buildSoccerMarketDirections({game:row.snapshot.evidence.game,reader,
    matchedGames:matchSoccerReaderGames(reader,[row.snapshot.evidence.game],decision),now:decision});
  row.snapshot.analysisCutoff=iso(decision);row.snapshot.observedAt=iso(decision);row.capturedAt=iso(decision+1);
});
const duplicate=buildSoccerRetrospectivePairDiagnostic({...input,captures:[capture,priced],reader:{status:'COMPLETE',rows:[first,repeat]}});
assert.equal(duplicate.selectedPairCount,0);assert.ok(duplicate.excludedReasons.ALREADY_IN_ORIGINAL_SNAPSHOT);
console.log('PASS retrospective pair diagnosis: original frozen predictions, independent clocked Reader receipts, exact scope, time and market identity, stable economic dedup, immutable source, partial fail closed and no formal claims');
