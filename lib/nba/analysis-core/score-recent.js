import {mean,predictConservative} from './score-conservative.js';
// Bounded retrospective candidate study. Market lines never enter the score fit.
export function predictAdditive(game,history,plan){
 const p=predictConservative(game,history,plan);if(p.status!=='ready')return p;
 const past=history.filter(g=>g.year===game.year&&g.seasonType===game.seasonType&&g.date<game.date),league=mean(past.flatMap(g=>[g.homeScore,g.awayScore]));
 const advantage=game.neutralSite?0:(mean(past.filter(g=>!g.neutralSite).map(g=>g.homeScore-g.awayScore))??0)/2;
 return{...p,predictedHome:2*(p.predictedHome-advantage)-league+advantage,predictedAway:2*(p.predictedAway+advantage)-league-advantage,method:'additive'};
}
function solve(matrix,vector){
 const a=matrix.map((r,i)=>[...r,vector[i]]),n=a.length;
 for(let col=0;col<n;col++){
  let pivot=col;for(let row=col+1;row<n;row++)if(Math.abs(a[row][col])>Math.abs(a[pivot][col]))pivot=row;
  if(Math.abs(a[pivot][col])<1e-10)throw Error('SINGULAR_RESEARCH_FIT');[a[col],a[pivot]]=[a[pivot],a[col]];
  const divisor=a[col][col];for(let k=col;k<=n;k++)a[col][k]/=divisor;
  for(let row=0;row<n;row++)if(row!==col){const f=a[row][col];for(let k=col;k<=n;k++)a[row][k]-=f*a[col][k];}
 }
 return a.map(r=>r[n]);
}
export function createScorePredictor(candidate,study){
 if(candidate.method==='additive')return predictAdditive;
 const cache=new Map();
 return(game,history,plan)=>{
  const fallback=predictAdditive(game,history,plan);if(fallback.status!=='ready')return fallback;
  const past=history.filter(g=>g.year===game.year&&g.seasonType===game.seasonType&&g.date<game.date);
  if(past.length<study.minimumLeagueGamesForRidge)return{...fallback,method:'additive_fallback'};
  const key=JSON.stringify([game.year,game.seasonType,game.date]);let fit=cache.get(key);
  if(!fit){
   const ids=[...new Set(past.flatMap(g=>[g.homeId,g.awayId]))].sort(),index=new Map(ids.map((id,i)=>[id,i])),n=2*ids.length+2,homeIndex=n-1;
   const gram=Array.from({length:n},()=>Array(n).fill(0)),vector=Array(n).fill(0);
   for(const g of past){
    const weight=candidate.halfLifeDays?2**(-(Date.parse(game.date)-Date.parse(g.date))/86400000/candidate.halfLifeDays):1;
    for(const home of [true,false]){
     const own=home?g.homeId:g.awayId,opponent=home?g.awayId:g.homeId,y=home?g.homeScore:g.awayScore;
     const x=[[0,1],[1+index.get(own),1],[1+ids.length+index.get(opponent),1],[homeIndex,g.neutralSite?0:home?1:-1]];
     for(const [i,v] of x){vector[i]+=weight*v*y;for(const [j,w] of x)gram[i][j]+=weight*v*w;}
    }
   }
   for(let i=1;i<n;i++)gram[i][i]+=candidate.ridgePenalty;
   fit={ids,index,homeIndex,coefficients:solve(gram,vector)};cache.set(key,fit);
  }
  const {index,coefficients:c,ids,homeIndex}=fit;
  if(!index.has(game.homeId)||!index.has(game.awayId))return{...fallback,method:'additive_identity_fallback'};
  const homeAdjustment=game.neutralSite?0:c[homeIndex];
  const predictedHome=c[0]+c[1+index.get(game.homeId)]+c[1+ids.length+index.get(game.awayId)]+homeAdjustment,predictedAway=c[0]+c[1+index.get(game.awayId)]+c[1+ids.length+index.get(game.homeId)]-homeAdjustment;
  if(!Number.isFinite(predictedHome)||!Number.isFinite(predictedAway))throw Error('NONFINITE_RESEARCH_SCORE');
  return{...fallback,predictedHome,predictedAway,method:'joint_offense_defense_ridge',ridgePenalty:candidate.ridgePenalty,halfLifeDays:candidate.halfLifeDays};
 };
}
