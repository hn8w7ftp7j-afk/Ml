import { createHash } from 'node:crypto';
import { openingTraining } from './opening-training.js';
import { openingResearchHistory } from './opening-research-history.js';
import { validateOpeningHistory, openingVariableAccepted } from './opening-core.js';
import { nbaOpeningValidationDiagnostics } from './opening-diagnostics.js';
import { validDate } from './identity.js';
import { parseCreditLine, evaluateWeightedContract } from './analysis-core/credit-total.js';
import { TOTALS_V6_PROTOCOL, TOTALS_V6_PROTOCOL_HASH, totalsV6Candidate,
  buildTotalsV6Observations, totalsV6AsOfRow, totalsV6Distribution } from './opening-research-v6.js';

// Independent validation is a server-reviewed, byte-pinned artifact. The public
// default remains unaccepted until the release owner binds actual evidence.
export const V6_RUNTIME_VALIDATION_PIN = null;
export const V6_RUNTIME_SCORE_EVIDENCE_VERSION = 'nba-opening-regular-season-stress-v1';
export const V6_RUNTIME_SOURCE_HISTORY_PINS = Object.freeze({
  older:'9a57ff85ce3f93e8aae8ddf2ce00dab77f4b7b4e052b6a7aae821f124e1894c6',
  recent:'dbba448fefb530dcbb967c4858c90212472e8fe80c1dbc5545c48e0c4dbbdcc1',
});
export const totalsV6RuntimeHash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const targets = { fullTotal: 'fullTotal', firstHalfTotal: 'halfTotal' };
const identityKeys = ['date','year','homeId','awayId','neutralSite'];
const fullKeys = [...identityKeys,'homeScore','awayScore'];
const order = (a,b) => a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId);
const same = (a,b,keys) => keys.every(key=>a[key]===b[key]);
const digest = x => /^[a-f0-9]{64}$/.test(x||'');
const freeze = value => { if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value; };
const error = code => { throw Error(code); };

function checkedBaseHistory(older,recent,pins) {
  if(!Array.isArray(older)||!Array.isArray(recent)||!pins
    ||!digest(pins.older)||!digest(pins.recent)
    ||totalsV6RuntimeHash(older)!==pins.older||totalsV6RuntimeHash(recent)!==pins.recent)error('NBA_TOTALS_V6_RUNTIME_SOURCE_PIN_MISMATCH');
  const rows=[...older,...recent].sort(order);
  if(!validateOpeningHistory(rows))error('NBA_TOTALS_V6_RUNTIME_BASE_HISTORY_INVALID');
  return freeze(structuredClone(rows));
}

// The live full/half inputs have already crossed the verified history service.
// Recheck every identity and score join here rather than borrowing full scores
// for a missing half. Dates on or after the target never enter any feature.
function mergeRuntimeHistory(base,regularHistory,halfHistory,game) {
  if(!Array.isArray(regularHistory)||!Array.isArray(halfHistory))error('NBA_TOTALS_V6_RUNTIME_LIVE_HISTORY_INVALID');
  const eligible = r => r?.seasonType==='regular'&&r.date<game.taipeiDate&&r.year<=game.season.year;
  const halves=new Map(),fullIds=new Set();
  for(const row of halfHistory.filter(eligible)) {
    if(halves.has(row.gameId))error('NBA_TOTALS_V6_RUNTIME_HALF_DUPLICATE');
    halves.set(row.gameId,row);
  }
  const byId=new Map(base.filter(eligible).map(r=>[r.gameId,r]));
  for(const row of regularHistory.filter(eligible)) {
    if(fullIds.has(row.gameId))error('NBA_TOTALS_V6_RUNTIME_FULL_DUPLICATE');
    fullIds.add(row.gameId);
    const prior=byId.get(row.gameId),half=halves.get(row.gameId);
    if(prior&&!same(prior,row,fullKeys))error('NBA_TOTALS_V6_RUNTIME_FULL_CONFLICT');
    if(half&&!same(half,row,identityKeys))error('NBA_TOTALS_V6_RUNTIME_HALF_IDENTITY_CONFLICT');
    if(prior&&half&&(prior.homeHalf!==half.homeHalf||prior.awayHalf!==half.awayHalf))error('NBA_TOTALS_V6_RUNTIME_HALF_CONFLICT');
    if(!prior) {
      if(!half)error('NBA_TOTALS_V6_RUNTIME_LIVE_HALF_MISSING');
      byId.set(row.gameId,{...row,homeHalf:half.homeHalf,awayHalf:half.awayHalf,checkpointSha256:half.checkpointSha256});
    }
  }
  const result=[...byId.values()].sort(order);
  if(!validateOpeningHistory(result))error('NBA_TOTALS_V6_RUNTIME_MERGED_HISTORY_INVALID');
  if(result.some(r=>r.gameId===game.id))error('NBA_TOTALS_V6_RUNTIME_TARGET_IN_HISTORY');
  return result;
}

/** Target-label-free V6 point calculation, shared with the V6 distribution.
 * Early games retain the canonical prior-20 point baseline exactly; mature
 * games keep the V4 adaptive point. No claim of early point improvement is made.
 * Historical replay parity is tested against each independently built V6 row.
 */
export function predictTotalsV6AsOf(game,history,target,observations) {
  totalsV6Candidate(target);
  if(!validateOpeningHistory(history)||!Array.isArray(observations))error('NBA_TOTALS_V6_RUNTIME_POINT_INPUT_INVALID');
  const rows=history.filter(r=>r.date<game.taipeiDate&&r.year<=game.season.year).sort(order),states=new Map(),features=[];
  const prefix=target==='fullTotal'?'full':'half';
  const state = year => { if(!states.has(year))states.set(year,{n:0,sum:0,through:null,teams:new Map()});return states.get(year); };
  const team = (s,id) => s?.teams.get(id)||{n:0,for:0,against:0};
  const frame = row => {
    const old=states.get(row.year-1),fresh=state(row.year),ho=team(old,row.homeId),ao=team(old,row.awayId);
    if(!old?.n||ho.n<20||ao.n<20)return null;
    const h=team(fresh,row.homeId),a=team(fresh,row.awayId);
    const rate=(p,c,key)=>(10*p[key]/p.n+c[key])/(10+c.n);
    const baseline=(rate(ho,h,'for')+rate(ao,a,'against')+rate(ao,a,'for')+rate(ho,h,'against'))/2;
    const canonicalRate=(p,c,key)=>(20*p[key]/p.n+c[key])/(20+c.n);
    const canonicalBaseline=(canonicalRate(ho,h,'for')+canonicalRate(ao,a,'against')+canonicalRate(ao,a,'for')+canonicalRate(ho,h,'against'))/2;
    const league=(120*(old.sum/old.n)+fresh.sum)/(120+fresh.n);
    return {baseline,canonicalBaseline,league,currentGames:{home:h.n,away:a.n},through:[old.through,fresh.through].filter(Boolean).sort().at(-1)};
  };
  for(let start=0;start<rows.length;) {
    let end=start+1;while(end<rows.length&&rows[end].date===rows[start].date)end++;
    for(const row of rows.slice(start,end)) {
      const f=frame(row);
      if(f)features.push({year:row.year,date:row.date,x:f.baseline-f.league,y:row.homeScore+row.awayScore-f.league});
      // Half labels are the first two actual periods, never full/2.
      if(f&&target==='halfTotal')features.at(-1).y=row.homeHalf+row.awayHalf-f.league;
    }
    for(const row of rows.slice(start,end)) {
      const s=state(row.year),home=row[`${prefix==='full'?'homeScore':'homeHalf'}`],away=row[`${prefix==='full'?'awayScore':'awayHalf'}`];
      s.n++;s.sum+=home+away;s.through=row.date;
      for(const [id,scored,conceded] of [[row.homeId,home,away],[row.awayId,away,home]]) {
        const t=team(s,id);s.teams.set(id,{n:t.n+1,for:t.for+scored,against:t.against+conceded});
      }
    }
    start=end;
  }
  const targetFrame=frame({year:game.season.year,homeId:game.home.id,awayId:game.away.id});
  const prior=features.filter(r=>r.year<game.season.year&&r.year>=game.season.year-3&&r.date<game.taipeiDate);
  if(!targetFrame||prior.length<30)return null;
  const mean=key=>prior.reduce((s,r)=>s+r[key],0)/prior.length,xb=mean('x'),yb=mean('y');
  const slope=prior.reduce((s,r)=>s+(r.x-xb)*(r.y-yb),0)/(1000+prior.reduce((s,r)=>s+(r.x-xb)**2,0));
  const candidate=totalsV6Candidate(target),current=observations.filter(r=>r.year===game.season.year&&r.date<game.taipeiDate
    &&r.target===target&&r.candidateId===candidate.candidateId&&r.modelVersion===candidate.modelVersion);
  const rawPrediction=targetFrame.league+slope*(targetFrame.baseline-targetFrame.league);
  const correction=current.reduce((s,r)=>s+r.rawError,0)/(120+current.length);
  if(![slope,rawPrediction,correction].every(Number.isFinite))error('NBA_TOTALS_V6_RUNTIME_POINT_NONFINITE');
  const phase=targetFrame.currentGames.home<10&&targetFrame.currentGames.away<10?'early':'mature';
  const inheritedV4PointPrediction=rawPrediction+correction;
  const pointPrediction=phase==='early'?targetFrame.canonicalBaseline:inheritedV4PointPrediction;
  return totalsV6AsOfRow({gameId:game.id,date:game.taipeiDate,year:game.season.year,target,
    prediction:pointPrediction,pointPrediction,inheritedV4PointPrediction,baseline:targetFrame.canonicalBaseline,
    rawPrediction,correction,correctionSamples:current.length,
    correctionThrough:current.at(-1)?.date??null,currentGames:targetFrame.currentGames,
    phase,
    featureThrough:targetFrame.through,fitThrough:prior.at(-1).date,fitSamples:prior.length,
    fit:{slope,intercept:0},feature:{baseline:targetFrame.baseline,leagueEstimate:targetFrame.league}},observations,target);
}

export function verifyTotalsV6IndependentEvidence(manifest,{expectedSha256,expectedArchiveSha256,expectedSourceHistoryHash,target,targetSeasonYear}={}) {
  const reject = reason => ({accepted:false,reason,metrics:manifest?.targets?.[target]?.metrics??null,validationYear:manifest?.holdoutYear??null});
  if(!digest(expectedSha256)||!manifest||totalsV6RuntimeHash(manifest)!==expectedSha256)return reject('NBA_TOTALS_V6_INDEPENDENT_MANIFEST_UNPINNED');
  const candidate=totalsV6Candidate(target),entry=manifest.targets?.[target];
  if(manifest.version!=='nba-opening-v6-independent-evaluation-v1'||manifest.modelVersion!==candidate.modelVersion
    ||manifest.protocolHash!==TOTALS_V6_PROTOCOL_HASH||!digest(expectedArchiveSha256)||!digest(expectedSourceHistoryHash)
    ||manifest.reviewedArchiveSha256!==expectedArchiveSha256||manifest.sourceHistoryHash!==expectedSourceHistoryHash
    ||!Number.isInteger(targetSeasonYear)||manifest.holdoutYear!==TOTALS_V6_PROTOCOL.independentHoldoutYear||manifest.holdoutYear>=targetSeasonYear
    ||manifest.role!=='EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS'
    ||! /^[a-f0-9]{40}$/.test(manifest.selectionFrozenCommit||'')||!digest(manifest.developmentReportHash)
    ||manifest.holdoutConsumed!==true||manifest.reselectionAllowed!==false
    ||!['HOLDOUT_PASSED_REQUIRES_CURRENT_REGRESSION_AND_INTEGRATION_REVIEW','BLOCKED_HOLDOUT_FAILED'].includes(manifest.status)
    ||manifest.executable!==false||manifest.promotionEligible!==false
    ||JSON.stringify(entry?.candidate)!==JSON.stringify(candidate))return reject('NBA_TOTALS_V6_INDEPENDENT_SCOPE_INVALID');
  if(entry.passed!==true||!Array.isArray(entry.reasons)||entry.reasons.length||!openingVariableAccepted(entry.metrics)
    ||!Number.isInteger(entry.metrics.probabilitySamples)||entry.metrics.probabilitySamples<1000)return reject('NBA_TOTALS_V6_INDEPENDENT_MARKET_FAILED');
  return {accepted:true,reason:null,metrics:entry.metrics,validationYear:manifest.holdoutYear};
}

export function verifyTotalsV6RegressionEvidence(report,{expectedSha256,expectedHistoryHash,target}={}) {
  const reject=reason=>({accepted:false,reason});
  if(!digest(expectedSha256)||!report||totalsV6RuntimeHash(report)!==expectedSha256)return reject('NBA_TOTALS_V6_REGRESSION_UNPINNED');
  const developmentReport=report.version===TOTALS_V6_PROTOCOL.version;
  if(!developmentReport&&report.version!=='nba-opening-v6-current-regression-v1'
    ||!developmentReport&&report.modelVersion!==TOTALS_V6_PROTOCOL.version
    ||report.protocolHash!==TOTALS_V6_PROTOCOL_HASH||report.historyHash!==expectedHistoryHash
    ||report.executable!==false||report.promotionEligible!==false)return reject('NBA_TOTALS_V6_REGRESSION_SCOPE_INVALID');
  if(developmentReport&&totalsV6RuntimeHash(report.protocol)!==TOTALS_V6_PROTOCOL_HASH)return reject('NBA_TOTALS_V6_REGRESSION_SCOPE_INVALID');
  const targetEntry=report.targets?.[target],years=developmentReport?targetEntry?.years:targetEntry;
  if(developmentReport&&JSON.stringify(targetEntry?.candidate)!==JSON.stringify(totalsV6Candidate(target)))return reject('NBA_TOTALS_V6_REGRESSION_SCOPE_INVALID');
  const requiredYears=TOTALS_V6_PROTOCOL.developmentYears;
  for(const year of new Set(requiredYears)) {
    const entry=years?.[year];
    if(!entry||entry.passed!==true||!Array.isArray(entry.reasons)||entry.reasons.length||!openingVariableAccepted(entry.metrics)
      ||!Number.isInteger(entry.metrics.probabilitySamples)||entry.metrics.probabilitySamples<1000)return reject('NBA_TOTALS_V6_REGRESSION_MARKET_FAILED');
  }
  return {accepted:true,reason:null};
}

function totalMarket(key,quote,row,distribution,validation) {
  const diagnostic=nbaOpeningValidationDiagnostics({market:key,metrics:validation.metrics,acceptance:validation.accepted,validationYear:validation.validationYear});
  diagnostic.modelVersion=TOTALS_V6_PROTOCOL.version;
  if(validation.reason)diagnostic.failureCodes.push(validation.reason);
  const base={validationDiagnostics:diagnostic,modelVersion:TOTALS_V6_PROTOCOL.version,candidateId:totalsV6Candidate(targets[key]).candidateId};
  if(!quote)return {...base,status:'unavailable',reason:'此盤口尚未開盤'};
  const line=parseCreditLine(String(quote.line),'total'),waters={positive:quote.overWater,negative:quote.underWater};
  if(!line||!Object.values(waters).every(v=>Number.isFinite(v)&&v>0&&v<=3))return {...base,status:'blocked',reason:'大小分盤口或雙邊水位未核對'};
  if(!validation.accepted)return {...base,status:'insufficient',quote:{...quote},reason:'此版本的大小分尚無通過核對的獨立市場驗證，暫不產生 W／R／S。'};
  if(!row||!distribution||distribution.samples<50)return {...base,status:'insufficient',quote:{...quote},reason:'此版本可核對的同階段跨季誤差不足 50 筆。'};
  const value=evaluateWeightedContract(distribution.center,distribution.residuals,line,waters,row.date,365,.015);
  const seasons=[...new Set(distribution.residuals.map(r=>r.year))].sort((a,b)=>a-b).flatMap(year=>{
    const rows=distribution.residuals.filter(r=>r.year===year);
    return rows.length<30?[]:[{year,samples:rows.length,value:evaluateWeightedContract(distribution.center,rows,line,waters,row.date,365,.015)}];
  });
  for(const side of ['positive','negative']) {
    const evidence=seasons.map(s=>({year:s.year,samples:s.samples,expectedNet:s.value[side].expectedNet}));
    value[side].robustExpectedNet=evidence.length>=2?Math.min(value[side].expectedNet,...evidence.map(s=>s.expectedNet)):null;
    value[side].scoreEvidence={version:V6_RUNTIME_SCORE_EVIDENCE_VERSION,basis:'minimum_prior_regular_season_expected_net',
      targetDate:row.date,targetSeasonYear:row.year,seasons:evidence,candidateId:base.candidateId,protocolHash:TOTALS_V6_PROTOCOL_HASH};
  }
  return {...base,status:'ready',quote:{...quote},quantity:row.prediction,distributionCenter:distribution.center,
    samples:distribution.samples,effectiveN:value.effectiveN,through:distribution.through,unitStake:100,rebateRate:.015,
    probabilityBasis:'candidate_matched_phase_centered_location_adjusted_cross_season_innovations',validatedBettingWinRate:null,
    sides:{over:value.positive,under:value.negative}};
}

/** All factory arguments are trusted server release inputs, never query data.
 * A matching caller flag does not grant acceptance: exact reviewed manifest,
 * model/source identities and all original raw metric gates must agree.
 */
export function createOpeningTotalsV6Runtime({olderHistory=openingResearchHistory.history,recentHistory=openingTraining.history,
  sourceHistoryPins=V6_RUNTIME_SOURCE_HISTORY_PINS,
  validationManifest=null,validationPins={},regressionManifest=null,expectedRegressionSha256=null}={}) {
  const sourcePins=freeze({...sourceHistoryPins});
  const base=checkedBaseHistory(olderHistory,recentHistory,sourcePins),baseHistoryHash=totalsV6RuntimeHash(base),manifest=freeze(structuredClone(validationManifest)),pins=freeze({...validationPins});
  const regression=freeze(structuredClone(regressionManifest));
  const cache=new Map();
  return function analyzeNbaOpeningTotalsV6(game,quotes,{regularHistory=[],halfHistory=[]}={}) {
    const result={modelVersion:TOTALS_V6_PROTOCOL.version,protocolHash:TOTALS_V6_PROTOCOL_HASH,status:'insufficient',
      marketAnalyses:{},totalsAnalysis:null,executable:false,strictPointInTime:false,promotionEligible:false,issues:[]};
    const fail=(status,code,message)=>({...result,status,issues:[{code,message}]});
    if(game?.league!=='NBA'||game.seasonType!=='regular'||game.season?.type!=null&&game.season.type!=='regular'
      ||!Number.isInteger(game.season?.year)||!validDate(game.taipeiDate)||!/^nba:espn:game:[1-9]\d+$/.test(game.id||'')
      ||!/^nba:espn:team:(?:[1-9]|[12]\d|30)$/.test(game.home?.id||'')||!/^nba:espn:team:(?:[1-9]|[12]\d|30)$/.test(game.away?.id||'')
      ||game.home.id===game.away.id||typeof game.neutralSite!=='boolean')return fail('blocked','NBA_TOTALS_V6_RUNTIME_GAME_INVALID','大小分賽事身分未核對');
    if(game.neutralSite)return fail('insufficient','NBA_TOTALS_V6_RUNTIME_NEUTRAL_UNVERIFIED','中立場大小分尚未獨立驗證');
    let history;
    try{history=mergeRuntimeHistory(base,regularHistory,halfHistory,game);}catch(e){return fail(e.message.endsWith('HALF_MISSING')?'insufficient':'blocked',e.message,'大小分歷史身分或全半場比分未通過核對');}
    const historyHash=totalsV6RuntimeHash(history),details={};
    for(const [key,target] of Object.entries(targets)) {
      const cacheKey=`${target}:${historyHash}`;
      if(!cache.has(cacheKey)) {
        try{cache.set(cacheKey,buildTotalsV6Observations(history,target));}catch(e){return fail('blocked','NBA_TOTALS_V6_RUNTIME_REPLAY_FAILED','大小分逐日模型重建未通過核對');}
        if(cache.size>4)cache.delete(cache.keys().next().value);
      }
      const observations=cache.get(cacheKey),independent=verifyTotalsV6IndependentEvidence(manifest,{...pins,target,targetSeasonYear:game.season.year});
      let regressionGate=verifyTotalsV6RegressionEvidence(regression,{expectedSha256:expectedRegressionSha256,expectedHistoryHash:baseHistoryHash,target});
      if(regressionGate.accepted&&regression.version===TOTALS_V6_PROTOCOL.version
        &&manifest?.developmentReportHash!==expectedRegressionSha256)regressionGate={accepted:false,reason:'NBA_TOTALS_V6_SELECTION_DEVELOPMENT_BINDING_INVALID'};
      const validation=independent.accepted&&!regressionGate.accepted?{...independent,accepted:false,reason:regressionGate.reason}:independent;
      let row,distribution;
      try{row=predictTotalsV6AsOf(game,history,target,observations);distribution=row?totalsV6Distribution(row,observations,target):null;}
      catch(e){return fail('blocked','NBA_TOTALS_V6_RUNTIME_PREDICTION_FAILED','大小分賽前預測或機率分布未通過核對');}
      if(row&&row.prediction<=0||distribution&&distribution.center<=0)return fail('blocked','NBA_TOTALS_V6_RUNTIME_TOTAL_INVALID','大小分預測總分未通過數學核對');
      result.marketAnalyses[key]=totalMarket(key,quotes?.[key],row,distribution,validation);
      details[target]={pointPrediction:row?.prediction??null,distributionCenter:distribution?.center??null,
        featureThrough:row?.featureThrough??null,fitThrough:row?.fitThrough??null,correctionThrough:row?.correctionThrough??null,
        distributionThrough:distribution?.through??null,distributionSamples:distribution?.samples??0,candidateId:totalsV6Candidate(target).candidateId,
        independentValidationAccepted:independent.accepted,independentValidationYear:independent.validationYear,regressionAccepted:regressionGate.accepted};
    }
    if(details.fullTotal.pointPrediction!==null&&details.halfTotal.pointPrediction!==null
      &&details.halfTotal.pointPrediction>=details.fullTotal.pointPrediction)return fail('blocked','NBA_TOTALS_V6_RUNTIME_HALF_TOTAL_INVALID','上半場與全場預測總分未通過數學核對');
    result.status=Object.values(result.marketAnalyses).some(m=>m.status==='ready')?'ready':'insufficient';
    result.totalsAnalysis={...details,historyHash,sourceHistoryPins:sourcePins,validationManifestHash:manifest?totalsV6RuntimeHash(manifest):null,
      regressionManifestHash:regression?totalsV6RuntimeHash(regression):null,
      validationBasis:'earlier_era_external_retrospective_not_prospective_OOS',limitations:['跨時代回溯外部驗證不等於實際前瞻下注勝率。','人員、傷停、先發與分鐘變動尚未納入。']};
    return result;
  };
}

const defaultRuntime=createOpeningTotalsV6Runtime();
export const analyzeNbaOpeningTotalsV6 = (...args) => defaultRuntime(...args);

