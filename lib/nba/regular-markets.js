import {analyzeNbaModel} from './analysis-model.js';
import {defaultTraining} from './analysis-training.js';
import {quarterTraining} from './quarter-training.js';
import {createScorePredictor} from './analysis-core/score-recent.js';
import {mean} from './analysis-core/score-conservative.js';
import {parseCreditLine,evaluateWeightedContract} from './analysis-core/credit-total.js';
export const NBA_REGULAR_VERSION='nba-regular-four-market-v1';
const keys=['fullTotal','fullRunline','firstHalfTotal','firstHalfRunline'];
const earlier=(rows,g)=>rows.filter(r=>r.year===g.year&&r.seasonType===g.seasonType&&r.date<g.date).sort((a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId));
export function marginInnovations(paired){return paired.map(r=>{const prior=earlier(paired,r);return {...r,error:r.rawHome-r.rawAway-(prior.length>=20?mean(prior.map(p=>p.rawHome-p.rawAway)):0)};});}
export function regularMarket(key,quote,quantity,residuals,date){
 if(!quote)return {status:'unavailable',reason:'此盤口尚未開盤'};
 const total=key.endsWith('Total'),line=parseCreditLine(String(quote.line),total?'total':'spread'),sign=total||quote.lineSide==='home'?1:-1;
 const waters=total?{positive:quote.overWater,negative:quote.underWater}:{positive:quote[`${quote.lineSide}Water`],negative:quote[`${quote.lineSide==='home'?'away':'home'}Water`]};
 if(!line||!total&&!['home','away'].includes(quote.lineSide)||!Object.values(waters).every(x=>Number.isFinite(x)&&x>0&&x<=3))return {status:'blocked',reason:'盤口格式、讓分方或雙邊水位未核對'};
 if(!Number.isFinite(quantity)||residuals.length<50)return {status:'insufficient',reason:`此賽季較早誤差 ${residuals.length} 筆（需 50）；不借用其他球季或全場比分推算上半場。`};
 const rows=residuals.map(r=>({...r,error:sign*r.error}));
 const valuation=evaluateWeightedContract(sign*quantity,rows,line,waters,date,30,.015);
 // Three fixed calendar blocks ending strictly before target date. No overlapping samples.
 const target=Date.parse(date+'T00:00:00Z'),blocks=[3,2,1].map(i=>{const start=new Date(target-i*30*86400000).toISOString().slice(0,10),end=new Date(target-(i-1)*30*86400000).toISOString().slice(0,10);const part=rows.filter(r=>r.date>=start&&r.date<end);return part.length>=30?{start,end,samples:part.length,value:evaluateWeightedContract(sign*quantity,part,line,waters,date,30,.015)}:null;}).filter(Boolean);
 for(const side of ['positive','negative']){const evidence=blocks.map(b=>({start:b.start,end:b.end,samples:b.samples,expectedNet:b.value[side].expectedNet}));valuation[side].robustExpectedNet=evidence.length===3?Math.min(valuation[side].expectedNet,...evidence.map(b=>b.expectedNet)):null;valuation[side].scoreEvidence={version:'nba-regular-calendar-stress-v1',basis:'minimum_three_prior_nonoverlapping_30_day_blocks',targetDate:date,blocks:evidence};}
 return {status:'ready',quote:{...quote},quantity,sides:total?{over:valuation.positive,under:valuation.negative}:{[quote.lineSide]:valuation.positive,[quote.lineSide==='home'?'away':'home']:valuation.negative},samples:rows.length,effectiveN:valuation.effectiveN,through:rows.at(-1).date,unitStake:100,rebateRate:.015,probabilityBasis:'strictly_earlier_same_season_prequential_errors_not_certified_EV',validatedBettingWinRate:null};
}
export function analyzeNbaRegularMarkets(normalized,quotes,{trainingData=defaultTraining,halfTraining=quarterTraining}={}){
 const result=analyzeNbaModel(normalized,null,{trainingData,scoreOnly:true});
 const base={...result,modelVersion:NBA_REGULAR_VERSION,quotes:Object.fromEntries(keys.map(k=>[k,quotes?.[k]??null])),marketAnalyses:{},regularAnalysis:null};
 if(result.status!=='ready')return base;
 const g={gameId:normalized.id,date:normalized.taipeiDate,year:normalized.season.year,seasonType:normalized.seasonType,homeId:normalized.home.id,awayId:normalized.away.id,neutralSite:normalized.neutralSite};
 const paired=earlier(trainingData.pairedResiduals,g),totalRows=earlier(trainingData.observations,g),marginRows=marginInnovations(paired);
 const prediction={fullTotal:result.prediction.total,fullMargin:result.prediction.home-result.prediction.away,halfTotal:null,halfMargin:null};let halfRows=[];let halfReason='上半場分節資料未通過核對';
 if(halfTraining?.kind==='NBA_QUARTER_SCORE_FIXED_TRAINING'&&halfTraining.provenance?.sourceArchiveSha256===trainingData.provenance?.sourceArchiveSha256&&Array.isArray(halfTraining.history)&&Array.isArray(halfTraining.pairedResiduals)&&Array.isArray(halfTraining.observations)){
  const history=earlier(halfTraining.history,g),hp=earlier(halfTraining.pairedResiduals,g);
  const rawHalfRows=earlier(halfTraining.observations,g);
  const valid=rawHalfRows.every(r=>[r.total,r.margin].every(Number.isFinite)) && history.every(r=>[r.homeScore,r.awayScore].every(n=>Number.isInteger(n)&&n>=0)&&r.homeScore===r.homeHalf&&r.awayScore===r.awayHalf&&/^[a-f0-9]{64}$/.test(r.checkpointSha256||''))&&hp.every(r=>[r.rawHome,r.rawAway].every(Number.isFinite));
  if(valid){const p=createScorePredictor(trainingData.scoreStudy.candidates.find(r=>r.id==='recent'),trainingData.scoreStudy)(g,history,trainingData.scorePlan);if(p.status==='ready'){const home=p.predictedHome+(hp.length>=20?mean(hp.map(r=>r.rawHome)):0),away=p.predictedAway+(hp.length>=20?mean(hp.map(r=>r.rawAway)):0);prediction.halfTotal=home+away;prediction.halfMargin=home-away;halfRows=rawHalfRows;}halfReason='此賽季的上半场歷史或較早誤差不足';}
 }
 const inputs={fullTotal:[prediction.fullTotal,totalRows],fullRunline:[prediction.fullMargin,marginRows],firstHalfTotal:[prediction.halfTotal,halfRows.map(r=>({...r,error:r.total}))],firstHalfRunline:[prediction.halfMargin,halfRows.map(r=>({...r,error:r.margin}))]};
 for(const key of keys){base.marketAnalyses[key]=regularMarket(key,quotes?.[key],...inputs[key],g.date);if(key.startsWith('firstHalf')&&base.marketAnalyses[key].status==='insufficient')base.marketAnalyses[key].reason=halfReason;}
 base.regularAnalysis={...prediction,through:result.training.through,fullSamples:totalRows.length,halfSamples:halfRows.length,halfBasis:'verified_first_two_periods_separately_fitted_not_full_game_divided_by_two',stressBasis:'three_fixed_nonoverlapping_prior_30_day_blocks_minimum_30_each',limitations:['傷停、確認先發、輪替與預計上場時間尚未納入。','單季賽後封存資料；尚無獨立前瞻下注勝率驗證。','R 為歷史區塊壓力估計，不是信賴下界；三區塊不足則不產生 R／S。']};
 base.assessment=analyzeNbaModel(normalized,quotes?.fullTotal,{trainingData}).assessment;
 base.status=Object.values(base.marketAnalyses).some(m=>m.status==='ready')?'ready':'insufficient';
 return base;
}
