import { openingTraining } from './opening-training.js';
import { NBA_OPENING_VERSION, OPENING_MARKETS, OPENING_VARIABLES, openingBaseline, fitOpening, validateOpeningHistory, openingVariableAccepted } from './opening-core.js';
import { validDate } from './identity.js';
import { parseCreditLine, evaluateWeightedContract } from './analysis-core/credit-total.js';
import { nbaOpeningValidationDiagnostics } from './opening-diagnostics.js';
export const OPENING_SCORE_EVIDENCE_VERSION='nba-opening-regular-season-stress-v1';
const chronological=(a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId);
const variableFor=k=>`${k.startsWith('firstHalf')?'half':'full'}${k.endsWith('Total')?'Total':'Margin'}`;

export function openingMarket(key,quote,predictions,observations,date,accepted,targetSeasonYear,validationDiagnostics=null){
  const diagnostic=validationDiagnostics?{validationDiagnostics}:{};
  if(!quote)return{...diagnostic,status:'unavailable',reason:'此盤口尚未開盤'};
  const total=key.endsWith('Total'),variable=variableFor(key),sign=total||quote.lineSide==='home'?1:-1;
  const line=parseCreditLine(String(quote.line),total?'total':'spread');
  const waters=total?{positive:quote.overWater,negative:quote.underWater}:{positive:quote[`${quote.lineSide}Water`],negative:quote[`${quote.lineSide==='home'?'away':'home'}Water`]};
  if(!line||!total&&!['home','away'].includes(quote.lineSide)||!Object.values(waters).every(n=>Number.isFinite(n)&&n>0&&n<=3))return{...diagnostic,status:'blocked',reason:'盤口格式、讓分方或雙邊水位未核對'};
  if(!accepted)return{...diagnostic,status:'insufficient',reason:'此開季市場尚未通過歷史驗證，暫不產生 W／R／S。'};
  if(observations.length<50)return{...diagnostic,status:'insufficient',reason:'可核對的跨季例行賽誤差不足 50 筆。'};
  const residuals=observations.map(r=>({date:r.date,error:sign*r.errors[variable]}));
  const valuation=evaluateWeightedContract(sign*predictions[variable],residuals,line,waters,date,365,.015);
  const seasons=[...new Set(observations.map(r=>r.year))].sort((a,b)=>a-b).map(year=>{
    const rows=observations.filter(r=>r.year===year);
    if(rows.length<30)return null;
    return{year,samples:rows.length,distribution:evaluateWeightedContract(sign*predictions[variable],rows.map(r=>({date:r.date,error:sign*r.errors[variable]})),line,waters,date,365,.015)};
  }).filter(Boolean);
  for(const side of ['positive','negative']){
    const evidence=seasons.map(s=>({year:s.year,samples:s.samples,expectedNet:s.distribution[side].expectedNet}));
    valuation[side].robustExpectedNet=evidence.length>=2?Math.min(valuation[side].expectedNet,...evidence.map(s=>s.expectedNet)):null;
    valuation[side].scoreEvidence={version:OPENING_SCORE_EVIDENCE_VERSION,basis:'minimum_prior_regular_season_expected_net',targetDate:date,targetSeasonYear,seasons:evidence};
  }
  return{...diagnostic,status:'ready',quote:{...quote},quantity:predictions[variable],samples:observations.length,effectiveN:valuation.effectiveN,
    through:observations.at(-1).date,unitStake:100,rebateRate:.015,probabilityBasis:'prequential_regular_cross_season_error_distribution_not_certified_EV',validatedBettingWinRate:null,
    sides:total?{over:valuation.positive,under:valuation.negative}:{[quote.lineSide]:valuation.positive,[quote.lineSide==='home'?'away':'home']:valuation.negative}};
}

export function analyzeNbaOpening(game,quotes,{trainingData=openingTraining,regularHistory=[],halfHistory=[]}={}){
  const fail=(status,code,message)=>({status,modelVersion:NBA_OPENING_VERSION,prediction:null,assessment:null,probabilityEstimate:null,executable:false,strictPointInTime:false,promotionEligible:false,issues:[{code,message}]});
  if(game?.league!=='NBA'||game.seasonType!=='regular'||game.season?.type!=null&&game.season.type!=='regular'||!Number.isInteger(game.season?.year)
    ||!validDate(game.taipeiDate)||!/^nba:espn:game:[1-9]\d+$/.test(game.id||'')||game.home?.id===game.away?.id||typeof game.neutralSite!=='boolean')return fail('blocked','NBA_OPENING_GAME_INVALID','開季分析賽事身分未核對');
  if(game.neutralSite)return fail('insufficient','NBA_OPENING_NEUTRAL_UNVERIFIED','中立場的跨季開季模型尚未獨立驗證');
  if(trainingData?.kind!=='NBA_OPENING_FIXED_TRAINING'||trainingData.modelVersion!==NBA_OPENING_VERSION||!Array.isArray(trainingData.history)
    ||!Array.isArray(trainingData.features)||!Array.isArray(trainingData.observations)||![10,20,40].includes(trainingData.priorWeight)||trainingData.ridgePenalty!==1000
    ||!Number.isInteger(trainingData.validation?.holdoutYear)||trainingData.validation.holdoutYear>=game.season.year)return fail('insufficient','NBA_OPENING_VALIDATION_UNAVAILABLE','此球季沒有較早球季的獨立開季驗證');
  const eligible=r=>r.date<game.taipeiDate&&r.year<=game.season.year;
  const byId=new Map();
  for(const row of trainingData.history.filter(eligible)){
    if(byId.has(row.gameId))return fail('blocked','NBA_OPENING_HISTORY_CONFLICT','跨季歷史有重複身分');
    byId.set(row.gameId,row);
  }
  const halves=new Map(halfHistory.filter(r=>r.seasonType==='regular'&&eligible(r)).map(r=>[r.gameId,r]));
  for(const row of regularHistory.filter(r=>r.seasonType==='regular'&&eligible(r))){
    const prior=byId.get(row.gameId),half=halves.get(row.gameId);
    if(prior&&['date','year','homeId','awayId','homeScore','awayScore','neutralSite'].some(k=>prior[k]!==row[k]))return fail('blocked','NBA_OPENING_HISTORY_CONFLICT','本次歷史與跨季封存比分不一致');
    if(half&&['date','year','homeId','awayId','neutralSite'].some(k=>half[k]!==row[k]))return fail('blocked','NBA_OPENING_HALF_IDENTITY_CONFLICT','半場與全場歷史身分不一致');
    if(prior&&half&&(prior.homeHalf!==half.homeHalf||prior.awayHalf!==half.awayHalf))return fail('blocked','NBA_OPENING_HALF_SCORE_CONFLICT','半場歷史比分不一致');
    if(!prior){
      if(!half)return fail('insufficient','NBA_OPENING_LIVE_HALF_MISSING','本季歷史缺少已核對的半場比分');
      byId.set(row.gameId,{...row,homeHalf:half.homeHalf,awayHalf:half.awayHalf,checkpointSha256:half.checkpointSha256});
    }
  }
  const history=[...byId.values()].sort(chronological);
  if(!validateOpeningHistory(history))return fail('blocked','NBA_OPENING_HISTORY_INVALID','例行賽歷史與半場比分未通過核對');
  const baseline=openingBaseline(game,history,trainingData.priorWeight);
  if(!baseline)return fail('insufficient','NBA_OPENING_TEAM_HISTORY_INSUFFICIENT','兩隊上一季各需至少 20 場已核對例行賽');
  const features=trainingData.features.filter(r=>r.date<game.taipeiDate&&r.year<game.season.year).sort(chronological);
  const observations=trainingData.observations.filter(r=>r.date<game.taipeiDate&&r.year<game.season.year&&r.year>=game.season.year-3).sort(chronological);
  if(features.length<30||observations.length<50)return fail('insufficient','NBA_OPENING_RESIDUALS_INSUFFICIENT','較早例行賽訓練或誤差樣本不足');
  if(new Set(features.map(r=>r.gameId)).size!==features.length||new Set(observations.map(r=>r.gameId)).size!==observations.length
    ||features.some(r=>!validDate(r.date)||!OPENING_VARIABLES.every(k=>Number.isFinite(r.baseline?.[k])&&Number.isFinite(r.actual?.[k])))
    ||observations.some(r=>!validDate(r.date)||!validDate(r.trainedThrough)||r.trainedThrough>=r.date||!OPENING_VARIABLES.every(k=>Number.isFinite(r.errors?.[k]))))return fail('blocked','NBA_OPENING_TEMPORAL_EVIDENCE_INVALID','跨季訓練或誤差有日期洩漏／數值缺失');
  const fit=fitOpening(features,baseline,trainingData.ridgePenalty),values=Object.fromEntries(OPENING_VARIABLES.map(k=>[k,fit[k].value]));
  if(!Object.values(values).every(Number.isFinite)||values.fullTotal<=Math.abs(values.fullMargin)||values.halfTotal<=Math.abs(values.halfMargin)||values.halfTotal>=values.fullTotal)return fail('blocked','NBA_OPENING_PREDICTION_INVALID','跨季預測數學核對未通過');
  const markets=Object.fromEntries(OPENING_MARKETS.map(k=>{
    const variable=variableFor(k),metrics=trainingData.validation.holdout?.metrics?.[variable];
    const accepted=trainingData.acceptance?.[variable]?.accepted===true&&openingVariableAccepted(metrics);
    const diagnostics=nbaOpeningValidationDiagnostics({market:k,metrics,acceptance:trainingData.acceptance?.[variable]?.accepted,validationYear:trainingData.validation.holdoutYear});
    return[k,openingMarket(k,quotes?.[k],values,observations,game.taipeiDate,accepted,game.season.year,diagnostics)];
  }));
  const ready=Object.values(markets).some(m=>m.status==='ready');
  const full=markets.fullTotal;
  return{status:ready?'ready':'insufficient',modelVersion:NBA_OPENING_VERSION,executable:false,strictPointInTime:false,promotionEligible:false,probabilityEstimate:null,
    prediction:{home:(values.fullTotal+values.fullMargin)/2,away:(values.fullTotal-values.fullMargin)/2,total:values.fullTotal,baseTotal:baseline.fullTotal,correction:values.fullTotal-baseline.fullTotal},
    assessment:ready?{positiveExpectedNet:full.sides?.over?.expectedNet??null,negativeExpectedNet:full.sides?.under?.expectedNet??null}:null,
    openingAnalysis:{...values,baseline,through:features.at(-1).date,baselineThrough:baseline.through,trainingSamples:features.length,distributionSamples:observations.length,
      sourceSeasonYears:[...new Set(observations.map(r=>r.year))],validationYear:trainingData.validation.holdoutYear,acceptance:trainingData.acceptance,
      validation:trainingData.validation.holdout,archiveHash:trainingData.provenance.archiveHash,
      limitations:['跨季例行賽研究估計，未驗證實際下注勝率或獲利。','傷停、交易、確認先發、輪替與預計上場時間尚未納入。','歷史比分於賽後取得；不宣稱當時已持有完整賽前快照。']},
    quotes:Object.fromEntries(OPENING_MARKETS.map(k=>[k,quotes?.[k]??null])),marketAnalyses:markets,
    training:{seasonYear:game.season.year,seasonType:'regular',availableGames:observations.length,minimumResiduals:50,through:features.at(-1).date},
    issues:[...(!ready?[{code:'NBA_OPENING_NO_VALIDATED_QUOTE',message:'目前盤口尚無通過開季驗證的市場'}]:[]),{code:'NBA_OPENING_RESEARCH_ONLY',message:'跨季例行賽研究估計，保留較早球季驗證與逐日時間切分，未取得正式下注執行資格。'}]};
}
