// Bounded retrospective diagnostics. These functions do not establish that the
// archived inputs, quoted period, or quote capture times were available pregame.
const ordered=(a,b)=>a.date.localeCompare(b.date)||a.gameId.localeCompare(b.gameId);
const daysBetween=(current,past)=>(Date.parse(current)-Date.parse(past))/86400000;
const sum=(values)=>values.reduce((a,b)=>a+b,0);

function solve(matrix,vector){
 const augmented=matrix.map((row,index)=>[...row,vector[index]]),n=vector.length;
 for(let column=0;column<n;column++){
  let pivot=column;
  for(let row=column+1;row<n;row++)if(Math.abs(augmented[row][column])>Math.abs(augmented[pivot][column]))pivot=row;
  if(Math.abs(augmented[pivot][column])<1e-12)throw Error('SINGULAR_TOTAL_CORRECTION');
  [augmented[column],augmented[pivot]]=[augmented[pivot],augmented[column]];
  const divisor=augmented[column][column];
  for(let index=column;index<=n;index++)augmented[column][index]/=divisor;
  for(let row=0;row<n;row++)if(row!==column){const multiplier=augmented[row][column];for(let index=column;index<=n;index++)augmented[row][index]-=multiplier*augmented[column][index];}
 }
 return augmented.map(row=>row[n]);
}

export function totalCalibrationFeatures(game,quantity,history,study,method){
 const side=id=>{
  const previous=history.filter(past=>past.year===game.year&&past.date<game.date&&(past.homeId===id||past.awayId===id)).sort(ordered).at(-1);
  const gapDays=previous?daysBetween(game.date,previous.date):null;
  return{priorDate:previous?.date??null,priorGameId:previous?.gameId??null,gapDays,backToBack:gapDays===1,completeOfficialSchedule:false,dateBasis:'saved_Taipei_calendar_dates',seasonTypeFilter:'any'};
 };
 const restProxy={home:side(game.homeId),away:side(game.awayId),certifiedTrueOffDays:false,scope:'saved_schedule_calendar_gap_proxy_may_miss_games'};
 if(method==='mean_bias')return{features:[1],restProxy};
 if(method==='level_bias')return{features:[1,(quantity-study.forecastCenter)/study.forecastScale],restProxy};
 if(method==='rest_gap'){
  if(restProxy.home.gapDays===null||restProxy.away.gapDays===null)throw Error('REST_GAP_PRIOR_DATE_MISSING');
  return{features:[1,Number(restProxy.home.backToBack)+Number(restProxy.away.backToBack),(Math.min(restProxy.home.gapDays,study.restGapCapDays)+Math.min(restProxy.away.gapDays,study.restGapCapDays))/2-study.restGapCenterDays],restProxy};
 }
 throw Error('UNKNOWN_TOTAL_CALIBRATION_METHOD');
}

export function fitTotalCorrection(game,quantity,features,observations,study){
 if(!Number.isFinite(quantity)||features.some(value=>!Number.isFinite(value)))throw Error('INVALID_TOTAL_CORRECTION_INPUT');
 const past=observations.filter(row=>row.year===game.year&&row.seasonType===game.seasonType&&row.date<game.date).sort(ordered),n=features.length;
 const matrix=Array.from({length:n},(_,row)=>Array.from({length:n},(_,column)=>row===column?study.ridgeZeroPrior:0)),vector=Array(n).fill(0);
 let weightSum=0,squaredWeightSum=0;
 for(const row of past){
  if(row.features.length!==n)throw Error('TOTAL_CORRECTION_FEATURE_DIMENSION');
  const weight=2**(-daysBetween(game.date,row.date)/study.halfLifeDays);
  weightSum+=weight;squaredWeightSum+=weight*weight;
  for(let i=0;i<n;i++){vector[i]+=weight*row.features[i]*row.rawError;for(let j=0;j<n;j++)matrix[i][j]+=weight*row.features[i]*row.features[j];}
 }
 const coefficients=solve(matrix,vector),correction=sum(coefficients.map((coefficient,index)=>coefficient*features[index]));
 return{correction,coefficients,calibrationSamples:past.length,calibrationThrough:past.at(-1)?.date??null,calibrationWeightSum:weightSum,calibrationEffectiveN:weightSum?weightSum*weightSum/squaredWeightSum:0};
}

export function prequentialTotalCalibration(history,predictions,study,method,{featureBuilder=totalCalibrationFeatures}={}){
 const observations=[],byId=new Map();
 for(const game of [...history].sort(ordered)){
  const prediction=predictions.get(game.gameId);
  if(prediction?.status!=='ready')continue;
  const quantity=prediction.calibratedHome+prediction.calibratedAway,{features,restProxy,paceProxy}=featureBuilder(game,quantity,history,study,method);
  const fit=fitTotalCorrection(game,quantity,features,observations,study),calibratedQuantity=quantity+fit.correction;
  const result={gameId:game.gameId,date:game.date,year:game.year,seasonType:game.seasonType,quantity,calibratedQuantity,features,restProxy,...(paceProxy?{paceProxy}:{}),...fit};
  // Fit and freeze this prediction before recording its outcome. Same-date
  // observations are excluded by every later fit and valuation as well.
  byId.set(game.gameId,result);
  observations.push({...result,rawError:game.homeScore+game.awayScore-quantity,error:game.homeScore+game.awayScore-calibratedQuantity});
 }
 return{byId,observations};
}
