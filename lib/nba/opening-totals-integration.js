import { TOTALS_V6_PROTOCOL, TOTALS_V6_PROTOCOL_HASH,totalsV6Candidate } from './opening-research-v6.js';

export const NBA_OPENING_COMPOSITE_VERSION = 'nba-opening-composite-totals-v6-margins-v1';
const totals = { fullTotal:'fullTotal', firstHalfTotal:'halfTotal' };
const metricFields = ['samples','earlySamples','modelMAE','baselineMAE','earlyModelMAE','earlyBaselineMAE','modelBrier','baselineBrier','modelLogLoss','baselineLogLoss'];
const metricPairs = {modelMAE:'baselineMAE',earlyModelMAE:'earlyBaselineMAE',modelBrier:'baselineBrier',modelLogLoss:'baselineLogLoss'};

function diagnosticMetrics(diagnostic) {
  const metrics={};
  for(const key of metricFields) {
    const modelKey=Object.keys(metricPairs).find(model=>metricPairs[model]===key),check=diagnostic?.checks?.find(row=>row.id===(modelKey||key));
    metrics[key]=check?.[modelKey?'baseline':'actual']??null;
  }
  metrics.probabilitySamples=diagnostic?.probabilitySamples??null;
  return metrics;
}

/** Keep spread forecasts and valuations by reference. Only the two total
 * markets may be supplied by the separately reviewed release adapter.
 * This is called exclusively inside the regular-season warmup branch.
 */
export function mergeNbaOpeningTotals(legacy,replacement,game) {
  if(!legacy?.openingAnalysis||legacy.modelVersion!=='nba-regular-cross-season-v1'||legacy.status==='blocked'
    ||game?.league!=='NBA'||game.seasonType!=='regular'||replacement?.modelVersion!==TOTALS_V6_PROTOCOL.version
    ||replacement.protocolHash!==TOTALS_V6_PROTOCOL_HASH)return legacy;
  const markets={...legacy.marketAnalyses},targetMetadata={};
  for(const [key,target] of Object.entries(totals)) {
    const incoming=replacement.marketAnalyses?.[key];
    const audit=replacement.totalsAnalysis?.[target],diagnostic=incoming?.validationDiagnostics;
    const accepted=audit?.independentValidationAccepted===true&&audit?.regressionAccepted===true&&diagnostic?.accepted===true;
    const valid=incoming?.modelVersion===TOTALS_V6_PROTOCOL.version&&incoming.candidateId===totalsV6Candidate(target).candidateId
      &&['ready','unavailable','insufficient','blocked'].includes(incoming.status)&&(incoming.status!=='ready'||accepted);
    if(valid)markets[key]=incoming;
    else if(replacement.status==='blocked'||incoming)markets[key]={status:legacy.quotes?.[key]?'blocked':'unavailable',modelVersion:TOTALS_V6_PROTOCOL.version,
      reason:replacement.issues?.[0]?.message||'大小分模型資料未通過核對'};
    const market=markets[key];
    targetMetadata[target]={accepted:valid&&accepted,
      metrics:diagnosticMetrics(diagnostic),candidateId:market?.candidateId??null,modelVersion:TOTALS_V6_PROTOCOL.version,
      validationYear:diagnostic?.validationYear??TOTALS_V6_PROTOCOL.independentHoldoutYear};
  }
  const model=legacy.openingAnalysis,full=replacement.totalsAnalysis?.fullTotal?.pointPrediction,half=replacement.totalsAnalysis?.halfTotal?.pointPrediction;
  const fullTotal=Number.isFinite(full)?full:model.fullTotal,halfTotal=Number.isFinite(half)?half:model.halfTotal;
  if(![fullTotal,halfTotal].every(Number.isFinite)||fullTotal<=Math.abs(model.fullMargin)||halfTotal<=Math.abs(model.halfMargin)||halfTotal>=fullTotal)
    return {...legacy,status:'blocked',issues:[{code:'NBA_OPENING_COMPOSITE_TOTAL_INVALID',message:'大小分與既有分差預測未通過數學核對'}]};
  const ready=Object.values(markets).some(m=>m.status==='ready'),fullMarket=markets.fullTotal;
  const totalsValidation={...replacement.totalsAnalysis,version:'nba-opening-totals-v6-validation-v1',modelVersion:TOTALS_V6_PROTOCOL.version,
    protocolHash:TOTALS_V6_PROTOCOL_HASH,validationYear:TOTALS_V6_PROTOCOL.independentHoldoutYear,
    role:'EARLIER_ERA_EXTERNAL_RETROSPECTIVE_NOT_PROSPECTIVE_OOS',targets:targetMetadata,
    ...(replacement.releaseEvidence?{releaseEvidence:replacement.releaseEvidence}:{})};
  return {...legacy,modelVersion:NBA_OPENING_COMPOSITE_VERSION,status:ready?'ready':'insufficient',
    prediction:{...legacy.prediction,home:(fullTotal+model.fullMargin)/2,away:(fullTotal-model.fullMargin)/2,total:fullTotal,
      correction:fullTotal-legacy.prediction.baseTotal},
    assessment:ready?{positiveExpectedNet:fullMarket.sides?.over?.expectedNet??null,negativeExpectedNet:fullMarket.sides?.under?.expectedNet??null}:null,
    openingAnalysis:{...model,fullTotal,halfTotal,totalsValidation},marketAnalyses:markets,
    issues:[...legacy.issues.filter(issue=>!ready||issue.code!=='NBA_OPENING_NO_VALIDATED_QUOTE'),...(replacement.issues||[])],
    executable:false,strictPointInTime:false,promotionEligible:false};
}
