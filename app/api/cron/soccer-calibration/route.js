import { NextResponse } from 'next/server';
import { evaluateSoccerCalibrationShadow } from '../../../../lib/soccer/calibration-shadow-validation.js';
import { collectSoccerCalibrationPredictions } from '../../../../lib/soccer/calibration-collection.js';
import { runSoccerReturnErrorLifecycle } from '../../../../lib/soccer/return-error-lifecycle.js';
import { bootstrapSoccerReturnErrorProtocol } from '../../../../lib/soccer/return-error-bootstrap.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 180;

// Keep calibration checks outside the existing settlement cron's 278 s budget.
// All predictions, source URLs and results are recovered from server records.
export async function GET(request) {
  const secret = String(process.env.CRON_SECRET || '').trim();
  const respond = (body, status = 200) => NextResponse.json(body, {
    status, headers: { 'Cache-Control': 'no-store' },
  });
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`)
    return respond({ ok: false, error: 'Unauthorized' }, 401);

  const summaries = [], collection = [], returnErrorBootstrap = [], returnErrorLifecycle = [], leagues=['epl','ucl'];
  const deadline=Date.now()+160000,remaining=()=>Math.max(0,deadline-Date.now());
  const deferred=league=>({league,status:'BUDGET_DEFERRED',persisted:true,formalEligible:false,executable:false});
  const bootstrapUnavailable=(league,reason)=>({league,status:'NOT_VERIFIED',configured:false,persisted:false,
    protocolId:null,registeredAt:null,manifestHash:null,planHash:null,accepted:false,formalEligible:false,
    executable:false,W:null,R:null,S:null,reason});
  // Each stage gives both leagues a share before advancing. Reserve 20 s of
  // platform time and shrink later budgets after slow DB/source operations.
  for (const [index,league] of leagues.entries()) {
    const timeBudgetMs=Math.min(1500,Math.floor(remaining()/(leagues.length-index)));
    if(timeBudgetMs<1000){returnErrorBootstrap.push(bootstrapUnavailable(league,'RETURN_ERROR_BOOTSTRAP_BUDGET_DEFERRED'));continue;}
    try { returnErrorBootstrap.push(await bootstrapSoccerReturnErrorProtocol({league,timeBudgetMs})); }
    catch { returnErrorBootstrap.push(bootstrapUnavailable(league,'RETURN_ERROR_BOOTSTRAP_UNAVAILABLE')); }
  }
  for (const [index,league] of leagues.entries()) {
    const timeBudgetMs=Math.min(9000,Math.floor(remaining()/(leagues.length-index)));
    if(timeBudgetMs<1000){returnErrorLifecycle.push(deferred(league));continue;}
    try { returnErrorLifecycle.push(await runSoccerReturnErrorLifecycle({league,limit:1,timeBudgetMs})); }
    catch { returnErrorLifecycle.push({league,status:'STORAGE_UNAVAILABLE',persisted:false,formalEligible:false,executable:false}); }
  }
  for (const [index,league] of leagues.entries()) {
    const timeBudgetMs=Math.min(50000,Math.floor(Math.max(0,remaining()-36000)/(leagues.length-index)));
    if(timeBudgetMs<1000){collection.push(deferred(league));continue;}
    try { collection.push(await collectSoccerCalibrationPredictions({ league, limit: 2, timeBudgetMs })); }
    catch { collection.push({ league, status: 'STORAGE_UNAVAILABLE', persisted: false, formalEligible: false, executable: false }); }
  }
  for (const [index,league] of leagues.entries()) {
    const timeBudgetMs=Math.min(18000,Math.floor(remaining()/(leagues.length-index)));
    if(timeBudgetMs<1000){summaries.push(deferred(league));continue;}
    try {
      const { summary } = await evaluateSoccerCalibrationShadow({ league, limit: 3, timeBudgetMs });
      summaries.push(summary);
    } catch {
      // One league's source or storage failure must not stop the other league.
      summaries.push({ league, status: 'STORAGE_UNAVAILABLE', persisted: false,
        accepted: false, formalEligible: false, executable: false });
    }
  }
  const ok = returnErrorBootstrap.every(summary=>summary.configured===true && summary.persisted===true)
    && returnErrorLifecycle.every(summary=>summary.persisted===true && !['RETRYABLE','STORAGE_UNAVAILABLE','PARTIAL_SOURCE','BUDGET_DEFERRED'].includes(summary.status))
    && collection.every(summary => summary.persisted === true && !['PARTIAL','BUDGET_DEFERRED'].includes(summary.status))
    && summaries.every(summary => summary.persisted === true
      && ['NO_PENDING_CAPTURES', 'EVALUATED', 'PENDING'].includes(summary.status));
  return respond({ ok, summaries, collection, returnErrorBootstrap, returnErrorLifecycle, formalEligible: false, executable: false }, ok ? 200 : 503);
}
