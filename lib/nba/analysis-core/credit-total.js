const daysBetween=(current,past)=>(Date.parse(current)-Date.parse(past))/86400000;
export function parseCreditLine(value,market,{rejectInvalidTotals=true}={}){
 if(typeof value!=='string')return null;
 const s=value.trim().replace(/平$/,'');if(s==='PK')return market==='spread'?{base:0,tail:0,coordinate:0}:null;
 const m=s.match(/^(\d+(?:\.5)?)(?:([+-])(\d+(?:\.\d+)?))?$/);if(!m)return null;
 const base=Number(m[1]),tail=m[2]?(m[2]==='+'?1:-1)*Number(m[3])/100:0;
 if(Math.abs(tail)>1||(tail&&!Number.isInteger(base)))return null;
 const coordinate=base-tail/2;if(market==='total'&&rejectInvalidTotals&&(base<=0||coordinate<=0))return null;
 return{base,tail,coordinate};
}

export function fractionFor(actual,line,positive){
 const f=actual===line.base?line.tail:actual>line.base?1:-1;return positive?f:-f;
}

// Weights belong to complete paired home/away errors. They are not separately
// sampled or filtered by the current side, outcome, month, or effective N.
export function evaluateWeightedContract(quantity,residuals,line,waters,date,halfLifeDays=30,rebate=.015){
 if(!residuals.length)throw Error('NO_EARLIER_RESIDUALS');
 let weightSum=0,squaredWeightSum=0,positiveMass=0,negativeMass=0,positiveWins=0,negativeWins=0,pushes=0;
 for(const residual of residuals){
  if(!(residual.date<date))throw Error('WEIGHTED_RESIDUAL_NOT_STRICTLY_EARLIER');
  const weight=2**(-daysBetween(date,residual.date)/halfLifeDays),fraction=fractionFor(Math.round(quantity+residual.error),line,true);
  if(!Number.isFinite(weight)||weight<=0)throw Error('INVALID_RESIDUAL_WEIGHT');
  weightSum+=weight;squaredWeightSum+=weight*weight;
  positiveMass+=weight*Math.max(fraction,0);negativeMass+=weight*Math.max(-fraction,0);
  positiveWins+=weight*Number(fraction>0);negativeWins+=weight*Number(fraction<0);pushes+=weight*Number(fraction===0);
 }
 positiveMass/=weightSum;negativeMass/=weightSum;
 const positiveWinProbability=positiveWins/weightSum,negativeWinProbability=negativeWins/weightSum,pushProbability=pushes/weightSum;
 return{samples:residuals.length,weightSum,effectiveN:weightSum*weightSum/squaredWeightSum,positiveMass,negativeMass,
  positive:{winProbability:positiveWinProbability,lossProbability:negativeWinProbability,pushProbability,expectedNet:100*(waters.positive*positiveMass-negativeMass+rebate*(positiveMass+negativeMass))},
  negative:{winProbability:negativeWinProbability,lossProbability:positiveWinProbability,pushProbability,expectedNet:100*(waters.negative*negativeMass-positiveMass+rebate*(positiveMass+negativeMass))}};
}
