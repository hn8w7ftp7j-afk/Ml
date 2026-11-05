import { after } from 'next/server';
import { start } from 'workflow/api';
import { soccerReaderCaptureWorkflow } from '../../workflows/soccer-reader-capture.js';
import { soccerReaderContinuationScope } from './reader-analysis-continuation.js';
import { drainSoccerReaderAnalysis } from './reader-auto-analysis.js';

// start() acknowledges a persisted workflow run, never a completed prediction.
// A failed start cannot undo a saved Reader snapshot or its recoverable queue.
export async function launchSoccerReaderContinuation(input,{startRun=start,afterResponse=after,drain=drainSoccerReaderAnalysis}={}){
  const scope=soccerReaderContinuationScope(input);
  try{
    const run=await startRun(soccerReaderCaptureWorkflow,[scope]);
    if(typeof run?.runId!=='string'||!/^wrun_[0-7][0-9A-HJKMNP-TV-Z]{25}$/i.test(run.runId))throw Error('SOCCER_READER_WORKFLOW_RECEIPT_INVALID');
    return{status:'STARTED',runId:run.runId,durable:true,executable:false};
  }catch{
    try{
      afterResponse(async()=>{try{await drain(scope);}catch{}});
      return{status:'FALLBACK_ONLY',durable:false,executable:false};
    }catch{return{status:'UNAVAILABLE',durable:false,executable:false};}
  }
}
