import { OPENING_VARIABLES } from './opening-core.js';
const average=xs=>xs.reduce((s,x)=>s+x,0)/xs.length;
// Reference thresholds are knowable from pregame inputs, NOT recovered market
// quotes. These diagnostics cannot be reported as historical betting returns.
export function openingValidation(training,year) {
  const rows=training.observations.filter(r=>r.year===year),early=rows.filter(r=>r.currentGames.home<10&&r.currentGames.away<10);
  const metrics={};
  for(const key of OPENING_VARIABLES){
    const outcomes=[];
    for(const r of rows){
      const previous=training.observations.filter(p=>p.date<r.date&&p.year<r.year&&p.year>=r.year-3);
      if(previous.length<50)continue;
      const threshold=key.endsWith('Margin')?.5:Math.floor(r.baseline[key])+.5;
      const probability=kind=>{
        let sum=0,wins=0;
        for(const p of previous){
          const w=2**(-(Date.parse(r.date)-Date.parse(p.date))/86400000/365);
          const error=kind==='model'?p.errors[key]:p.actual[key]-p.baseline[key];
          sum+=w;wins+=w*Number(Math.round(r[kind==='model'?'prediction':'baseline'][key]+error)>threshold);
        }
        return wins/sum;
      };
      outcomes.push({p:probability('model'),baselineP:probability('baseline'),y:Number(r.actual[key]>threshold)});
    }
    const reliability=Array.from({length:10},(_,i)=>{
      const bin=outcomes.filter(r=>Math.min(9,Math.floor(r.p*10))===i);
      return{bin:i,samples:bin.length,p:bin.length?average(bin.map(r=>r.p)):null,observed:bin.length?average(bin.map(r=>r.y)):null};
    });
    const logLoss=kind=>{
      const values=outcomes.map(r=>r.y?-Math.log(r[kind]):-Math.log1p(-r[kind]));
      return values.every(Number.isFinite)?average(values):null;
    };
    metrics[key]={samples:rows.length,earlySamples:early.length,probabilitySamples:outcomes.length,
      modelMAE:average(rows.map(r=>Math.abs(r.errors[key]))),baselineMAE:average(rows.map(r=>Math.abs(r.actual[key]-r.baseline[key]))),
      earlyModelMAE:average(early.map(r=>Math.abs(r.errors[key]))),earlyBaselineMAE:average(early.map(r=>Math.abs(r.actual[key]-r.baseline[key]))),
      modelBrier:average(outcomes.map(r=>(r.p-r.y)**2)),baselineBrier:average(outcomes.map(r=>(r.baselineP-r.y)**2)),
      modelLogLoss:logLoss('p'),baselineLogLoss:logLoss('baselineP'),
      ece:reliability.reduce((s,r)=>s+r.samples*Math.abs((r.p??0)-(r.observed??0)),0)/outcomes.length,reliability};
  }
  return{seasonYear:year,samples:rows.length,earlyDefinition:'both_teams_fewer_than_ten_prior_regular_games',metrics,
    strictlyEarlierDates:rows.every(r=>r.trainedThrough<r.date),historicalBettingWinRate:null,
    probabilityValidationBasis:'pregame_reference_thresholds_no_historical_market_quote_claim',strictPointInTime:false};
}
