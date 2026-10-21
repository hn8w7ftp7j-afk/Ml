import { validDate } from './identity.js';
import { openingVariableAccepted } from './opening-core.js';
import { nbaOpeningValidationDiagnostics } from './opening-diagnostics.js';

export const NBA_OPENING_COMPOSITE_VERSION = 'nba-opening-composite-totals-v6-margins-v1';
const totalsV6Version = 'nba-opening-totals-early-baseline-hybrid-v6';
const totalsV6Protocol = '01bd869099a83f1113e499732ebc6bac10be5f716961ca7ef02aa793f09ce795';
const totalsV6Candidates = Object.freeze({
  fullTotal: 'd4ab69332c3c6eedd276cb2a43f613b26ef932f371c7816ffdb343d9bb8168d3',
  halfTotal: '9810add719acdbc04c54d0347fc66828ca1e7feef3158df8385654dd63f1ff59',
});
const totalsV6Manifest = '7afaad0d3ad268fcb9eac4a17793ad1c085400a27637c562c6f7f50844417cb8';
const totalsV6Development = '4411b1804e4ed332b9d4f2e89f4a2a48f6c395de34fe5cb2467fdf03a89b108f';
const digest = value => /^[a-f0-9]{64}$/.test(value || '');
// JSONB preserves values and array order, but not object key order. Compare
// every field recursively; serialization order is not analysis evidence.
function sameJson(left, right) {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}
export const isNbaOpeningModelVersion = version => version === 'nba-regular-cross-season-v1' || version === NBA_OPENING_COMPOSITE_VERSION;

export const NBA_JOB_STORAGE = 'sports-nba-analysis-job-v1';
export function validNbaJob(job) {
  return job && validDate(job.date) && (typeof job.runId === 'string' && /^[a-zA-Z0-9_:-]{8,300}$/.test(job.runId)
    || typeof job.requestId === 'string' && /^[a-zA-Z0-9-]{16,100}$/.test(job.requestId));
}

// NBA results never pass through baseball materialization, scoring or caches.
export function mergeNbaAnalysisResults(batch, previous = [], date) {
  if (batch?.league !== 'NBA' || batch.date !== date || !Array.isArray(batch.results)) throw new Error('NBA 結果聯盟或日期不符');
  const rows = new Map(previous.map(row => [row.game.id, row]));
  const seen = new Set();
  for (const entry of batch.results) {
    const query = entry.task?.nbaQuery;
    const game = entry.task?.game;
    const pk = Number(game?.gamePk);
    const id = `nba:espn:game:${query?.id}`;
    if (!query || query.date !== date || game?.id !== id || game?.league !== 'NBA' || !Number.isSafeInteger(pk)
      || pk !== Number(query.id) || seen.has(id)) throw new Error('NBA 結果場次身分無效');
    seen.add(id);
    const result = entry.payload || null;
    if (result && (result.league !== 'NBA' || result.gameId !== id || result.date !== date
      || result.observedAt !== query.observedAt || result.executable !== false
      || !['ready', 'reference', 'insufficient', 'blocked'].includes(result.status))) throw new Error('NBA 分析與盤口時間不符');
    if (entry.ok && result?.status === 'reference') {
      const ref = result.referencePrediction;
      if (result.modelVersion !== 'nba-total-pace-rest-v1' || result.prediction !== null || result.assessment !== null
        || result.probabilityEstimate !== null || ref?.modelVersion !== 'nba-prior-regular-reference-v1'
        || ref.calibrated !== false || ref.probabilityEstimate !== null || ref.expectedNet !== null || ref.direction !== null
        || game.seasonType !== 'preseason' || ref.sourceSeasonYear !== game.season?.year - 1 || ref.sourceSeasonType !== 'regular' || !validDate(ref.through) || ref.through >= date
        || ![ref.home?.games, ref.away?.games].every(n => Number.isInteger(n) && n >= 20)
        || Math.abs(ref.total - ref.homePoints - ref.awayPoints) > 1e-8
        || !['homePoints', 'awayPoints', 'total'].every(key => Number.isFinite(ref[key]))) throw new Error('NBA 跨季基準結果無效');
    } else if (entry.ok && isNbaOpeningModelVersion(result?.modelVersion)) {
      if (result.status !== 'ready' || game.seasonType !== 'regular' || !validOpeningResult(result,date)) throw new Error('NBA 跨季例行賽分析無效');
    } else if (entry.ok && result?.modelVersion === 'nba-regular-four-market-v1') {
      if (result.status !== 'ready' || !['regular','postseason'].includes(game.seasonType) || !validRegularResult(result,date)) throw new Error('NBA 全場與上半場分析無效');
    } else if (entry.ok && result?.modelVersion === 'nba-preseason-history-ridge-v1') {
      if (result.status !== 'ready' || game.seasonType !== 'preseason' || !validPreseasonResult(result, date)) throw new Error('NBA 季前賽盤口分析無效');
    } else if (entry.ok && (result?.status !== 'ready' || result.modelVersion !== 'nba-total-pace-rest-v1'
      || !['home', 'away', 'baseTotal', 'total', 'correction'].every(key => Number.isFinite(result.prediction?.[key]))
      || !result.assessment || !Number.isFinite(result.assessment.positiveExpectedNet)
      || !Number.isFinite(result.assessment.negativeExpectedNet))) throw new Error('NBA 已完成結果缺少有效分析');
    const previousRow = rows.get(id);
    rows.set(id, { ...(previousRow || { game, quote: null, canAnalyze: false, observedAt: null, reason: '請重新讀取盤口' }),
      result, jobState: result?.status || 'failed', jobError: entry.error || '',
      resultRunId: batch.runId || null });
  }
  return [...rows.values()].sort((a, b) => Date.parse(a.game.startTime) - Date.parse(b.game.startTime));
}

const marketKeys = ['fullTotal', 'fullRunline', 'firstHalfTotal', 'firstHalfRunline'];
export function validPreseasonResult(result, date) {
  const model = result.preseasonAnalysis;
  if (!model || !['fullTotal', 'fullMargin', 'halfTotal', 'halfMargin'].every(key => Number.isFinite(model[key]))
    || !validDate(model.through) || model.through >= date || model.trainingSamples < 30 || model.distributionSamples < 50) return false;
  let ready = 0;
  for (const key of marketKeys) {
    const market = result.marketAnalyses?.[key];
    if (!market || !['ready', 'blocked', 'unavailable'].includes(market.status)) return false;
    if (market.status !== 'ready') continue;
    ready++;
    if (market.samples < 50 || !Number.isFinite(market.effectiveN) || market.effectiveN <= 0 || !validDate(market.through) || market.through >= date
      || market.validatedBettingWinRate !== null || !sameJson(market.quote, result.quotes?.[key])) return false;
    for (const side of key.endsWith('Total') ? ['over', 'under'] : ['home', 'away']) {
      const value = market.sides?.[side];
      if (!value || !Number.isFinite(value.expectedNet) || !['winProbability', 'lossProbability', 'pushProbability'].every(name => Number.isFinite(value[name]) && value[name] >= 0 && value[name] <= 1)
        || Math.abs(value.winProbability + value.lossProbability + value.pushProbability - 1) > 1e-8) return false;
    }
  }
  return ready > 0;
}
const sameQuote = (left, right, total) => !left && !right || !!left && !!right && (total ? ['line', 'overWater', 'underWater'] : ['line', 'lineSide', 'homeWater', 'awayWater']).every(key => left[key] === right[key]);
export function nbaResultQuoteCurrent(row, now = Date.now()) {
  const result = row?.result;
  const fresh = row?.canAnalyze === true && now - Date.parse(row.observedAt) >= 0 && now - Date.parse(row.observedAt) < 180000
    && now - Date.parse(row.pageActivityAt || row.observedAt) < 180000 && Date.parse(row.game.startTime) > now;
  if (!fresh || !['ready', 'reference'].includes(result?.status)) return false;
  if (['nba-preseason-history-ridge-v1','nba-regular-four-market-v1'].includes(result.modelVersion) || isNbaOpeningModelVersion(result.modelVersion)) return marketKeys.every(key => sameQuote(row.quote?.[key], result.quotes?.[key], key.endsWith('Total')));
  return result.observedAt === row.observedAt && sameQuote(row.quote?.fullTotal, result.quote, true);
}

export function validOpeningResult(result,date){
 const model=result.openingAnalysis,year=result.training?.seasonYear;
 if(!isNbaOpeningModelVersion(result.modelVersion)||!model||!Number.isInteger(year)||!Number.isInteger(model.validationYear)||model.validationYear>=year
  ||!validDate(model.through)||model.through>=date||!validDate(model.baselineThrough)||model.baselineThrough>=date
  ||model.trainingSamples<30||model.distributionSamples<50||!/^[a-f0-9]{64}$/.test(model.archiveHash||'')
  ||result.strictPointInTime!==false||result.promotionEligible!==false||!['fullTotal','fullMargin','halfTotal','halfMargin'].every(k=>Number.isFinite(model[k])))return false;
 let ready=0;
 for(const key of marketKeys){
  const m=result.marketAnalyses?.[key];
  if(!m||!['ready','blocked','unavailable','insufficient'].includes(m.status))return false;
  if(m.status!=='ready')continue;
  const variable=`${key.startsWith('firstHalf')?'half':'full'}${key.endsWith('Total')?'Total':'Margin'}`,v=model.validation?.metrics?.[variable];
  const v6Total=result.modelVersion===NBA_OPENING_COMPOSITE_VERSION&&key.endsWith('Total');
  if((v6Total?!validOpeningV6TotalMarket(result,key,date):model.acceptance?.[variable]?.accepted!==true||!openingVariableAccepted(v))
   ||m.samples<50||!Number.isFinite(m.quantity)||!Number.isFinite(m.effectiveN)||m.effectiveN<=0||!validDate(m.through)||m.through>=date
   ||m.rebateRate!==.015||m.validatedBettingWinRate!==null||!sameJson(m.quote,result.quotes?.[key]))return false;
  for(const side of key.endsWith('Total')?['over','under']:['home','away']){
   const s=m.sides?.[side];
   if(!s||!Number.isFinite(s.expectedNet)||!['winProbability','lossProbability','pushProbability'].every(k=>Number.isFinite(s[k])&&s[k]>=0&&s[k]<=1)
    ||Math.abs(s.winProbability+s.lossProbability+s.pushProbability-1)>1e-8)return false;
  }
  ready++;
 }
 return ready>0;
}

// Client-side materialization checks are deliberately browser-safe. These pins
// identify the reviewed server release; they are not a substitute for server
// evidence verification and cannot grant a failed market qualification.
function openingV6ValidationScope(result,key,date){
 const variable=({fullTotal:'fullTotal',firstHalfTotal:'halfTotal'})[key];
 const proof=result?.openingAnalysis?.totalsValidation,target=proof?.targets?.[variable];
 const year=result?.training?.seasonYear;
 if(!variable||result?.modelVersion!==NBA_OPENING_COMPOSITE_VERSION
  ||proof?.version!=='nba-opening-totals-v6-validation-v1'||proof.modelVersion!==totalsV6Version
  ||proof.protocolHash!==totalsV6Protocol||proof.validationYear!==2011||!Number.isInteger(year)||year<=2011
  ||proof.role!=='EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS'
  ||proof.validationManifestHash!==totalsV6Manifest||proof.regressionManifestHash!==totalsV6Development
  ||!digest(proof.historyHash)
  ||proof.sourceHistoryPins?.older!=='9a57ff85ce3f93e8aae8ddf2ce00dab77f4b7b4e052b6a7aae821f124e1894c6'
  ||proof.sourceHistoryPins?.recent!=='dbba448fefb530dcbb967c4858c90212472e8fe80c1dbc5545c48e0c4dbbdcc1'
  ||target?.modelVersion!==totalsV6Version||target.candidateId!==totalsV6Candidates[variable]
  ||target.validationYear!==2011||!validDate(date))return null;
 return {proof,target,variable};
}

export function validOpeningV6TotalMarket(result,key,date){
 const scope=openingV6ValidationScope(result,key,date),market=result?.marketAnalyses?.[key];
 if(!scope||market?.status!=='ready')return false;
 const {proof,target,variable}=scope,audit=proof[variable],metrics=target.metrics;
 if(target.accepted!==true||!openingVariableAccepted(metrics)||!Number.isInteger(metrics?.samples)||!Number.isInteger(metrics?.earlySamples)
  ||!Number.isInteger(metrics?.probabilitySamples)||metrics.probabilitySamples<1000
  ||market.modelVersion!==totalsV6Version||market.candidateId!==totalsV6Candidates[variable]
  ||!Number.isInteger(market.samples)||market.samples<50||!Number.isFinite(market.distributionCenter)||market.distributionCenter<=0
  ||audit?.candidateId!==target.candidateId||audit.independentValidationAccepted!==true||audit.regressionAccepted!==true
  ||audit.independentValidationYear!==2011||audit.pointPrediction!==market.quantity||audit.distributionCenter!==market.distributionCenter
  ||audit.distributionSamples!==market.samples
  ||!['featureThrough','fitThrough','distributionThrough'].every(k=>validDate(audit[k])&&audit[k]<date)
  ||audit.correctionThrough!==null&&(!validDate(audit.correctionThrough)||audit.correctionThrough>=date))return false;
 const diagnostic=nbaOpeningValidationDiagnostics({market:key,metrics,acceptance:true,validationYear:2011});
 diagnostic.modelVersion=totalsV6Version;
 if(!sameJson(market.validationDiagnostics,diagnostic))return false;
 for(const side of ['over','under']){
  const evidence=market.sides?.[side]?.scoreEvidence;
  if(evidence?.candidateId!==target.candidateId||evidence.protocolHash!==totalsV6Protocol)return false;
 }
 return true;
}

export function validOpeningV6FailedDiagnostic(result,key,date){
 const scope=openingV6ValidationScope(result,key,date),market=result?.marketAnalyses?.[key];
 const d=market?.validationDiagnostics;
 return !!scope&&market?.status==='insufficient'&&d?.version==='nba-opening-validation-diagnostics-v1'
  &&d.league==='NBA'&&d.market===key&&d.variable===scope.variable&&d.modelVersion===totalsV6Version
  &&d.validationYear===2011&&d.status==='FAIL'&&d.accepted===false;
}

export function validRegularResult(result,date) {
 const model=result.regularAnalysis;
 if (!model || !['fullTotal','fullMargin'].every(k=>Number.isFinite(model[k])) || !validDate(model.through) || model.through>=date || model.fullSamples<50 || result.strictPointInTime!==false || result.promotionEligible!==false) return false;
 let ready=0;
 for (const key of marketKeys) {
  const m=result.marketAnalyses?.[key];
  if(!m || !['ready','blocked','unavailable','insufficient'].includes(m.status))return false;
  if(m.status!=='ready')continue;
  ready++;
  if(!Number.isFinite(m.quantity)||m.samples<50||!Number.isFinite(m.effectiveN)||m.effectiveN<=0||!validDate(m.through)||m.through>=date||m.validatedBettingWinRate!==null||!sameJson(m.quote,result.quotes?.[key]))return false;
  for(const side of key.endsWith('Total')?['over','under']:['home','away']) {const v=m.sides?.[side];if(!v||!Number.isFinite(v.expectedNet)||!['winProbability','lossProbability','pushProbability'].every(k=>Number.isFinite(v[k])&&v[k]>=0&&v[k]<=1)||Math.abs(v.winProbability+v.lossProbability+v.pushProbability-1)>1e-8)return false;}
 }
 return ready>0;
}
