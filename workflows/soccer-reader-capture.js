import { sleep, getWorkflowMetadata } from 'workflow';
import { runSoccerReaderContinuationPass, soccerReaderContinuationScope, SOCCER_READER_CONTINUATION_WINDOW_MS } from '../lib/soccer/reader-analysis-continuation.js';

async function initializeReaderRun(scope){
  'use step';
  soccerReaderContinuationScope(scope);
  const startedAt=Date.now();
  return{startedAt,deadlineAt:startedAt+SOCCER_READER_CONTINUATION_WINDOW_MS};
}

async function captureReaderPass(scope,state){
  'use step';
  const result=await runSoccerReaderContinuationPass(scope,state);
  console.info('SOCCER_READER_CONTINUATION_PASS',JSON.stringify({runId:getWorkflowMetadata().workflowRunId,league:result.league,date:result.date,status:result.status,
    stopped:result.stopped,delayMs:result.delayMs,checked:result.summary?.checked??0,captured:result.summary?.captured??0,
    reason:result.summary?.continuation?.reason??null}));
  return result;
}
captureReaderPass.maxRetries=2;

export async function soccerReaderCaptureWorkflow(scope){
  'use workflow';
  // Persist the clock separately so even a retry of the first capture step
  // cannot reset the original run window after partial database work.
  let state=await initializeReaderRun(scope);
  const totals={checked:0,captured:0,duplicate:0,retryable:0,deferred:0};
  for(let batch=0;batch<32;batch++){
    const result=await captureReaderPass(scope,state);
    for(const key of ['checked','captured','duplicate','retryable','deferred'])totals[key]+=result.summary?.[key]||0;
    if(result.stopped)return{league:result.league,date:result.date,status:result.status,batches:batch+1,
      ...totals,executable:false,formalScoringEnabled:false};
    state={startedAt:result.startedAt,deadlineAt:result.deadlineAt};
    // Capacity exhaustion is immediately due. Provider failures and live leases
    // use durable sleep; there is no timer or dependency on another upload.
    if(result.delayMs>0)await sleep(`${result.delayMs}ms`);
  }
  return{league:scope.league,date:scope.date,status:'BATCH_BOUND_REACHED',batches:32,...totals,
    executable:false,formalScoringEnabled:false};
}
