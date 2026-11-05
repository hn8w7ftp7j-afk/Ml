import { soccerLeague, validSoccerDate } from './contracts.js';
import { drainSoccerReaderAnalysis } from './reader-auto-analysis.js';

export const SOCCER_READER_CONTINUATION_WINDOW_MS = 180000;
export function soccerReaderContinuationScope(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['league','date'].includes(key))
    ||!soccerLeague(input.league)||soccerLeague(input.league).id!==input.league||!validSoccerDate(input.date))
    throw Error('SOCCER_READER_CONTINUATION_SCOPE_INVALID');
  return{league:input.league,date:input.date};
}

// Each durable step re-reads server data and wall time. This run deadline never
// replaces the original per-quote freshness check in the normal analysis path.
export async function runSoccerReaderContinuationPass(input,state=null,{now=Date.now,drain=drainSoccerReaderAnalysis}={}){
  const scope=soccerReaderContinuationScope(input),at=now();
  const startedAt=state===null?at:state.startedAt,deadlineAt=startedAt+SOCCER_READER_CONTINUATION_WINDOW_MS;
  if(!Number.isFinite(at)||!Number.isFinite(startedAt)||startedAt>at||state!==null&&state.deadlineAt!==deadlineAt)
    throw Error('SOCCER_READER_CONTINUATION_CLOCK_INVALID');
  const base={...scope,startedAt,deadlineAt,executable:false,formalScoringEnabled:false};
  if(at>=deadlineAt)return{...base,status:'RUN_WINDOW_EXPIRED',stopped:true,delayMs:0,summary:null};
  const summary=await drain({...scope,timeBudgetMs:Math.min(40000,deadlineAt-at),maxGames:4});
  const next=summary?.continuation;
  if(!next||typeof next.needed!=='boolean'||!Number.isSafeInteger(next.delayMs)||next.delayMs<0
    ||next.league!==undefined&&(next.league!==scope.league||next.date!==scope.date))
    throw Error('SOCCER_READER_CONTINUATION_RECEIPT_INVALID');
  if(!next.needed)return{...base,status:next.reason==='NO_FRESH_ELIGIBLE_QUOTES'?next.reason:'SCOPE_COMPLETE',stopped:true,delayMs:0,summary};
  const remaining=deadlineAt-now();
  if(remaining<=0)return{...base,status:'RUN_WINDOW_EXPIRED',stopped:true,delayMs:0,summary};
  return{...base,status:'MORE_PENDING',stopped:false,delayMs:Math.min(next.delayMs,20000,remaining),summary};
}
