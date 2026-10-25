import { NextResponse } from 'next/server';
import { requireApiAuth,validateSameOrigin,originErrorResponse,checkRateLimit,rateLimitResponse,readJsonBody } from '../../../../lib/security.js';
import { validSoccerAnalysisQuery } from '../../../../lib/soccer/analysis-service.js';
import { loadSoccerAnalysisRevision } from '../../../../lib/soccer/analysis-store.js';
import { validSoccerSimulationInput,simulateSoccerManualQuote } from '../../../../lib/soccer/manual-simulation.js';
export const dynamic='force-dynamic';
export const runtime='nodejs';
const reply=(body,status=200)=>NextResponse.json(body,{status,headers:{'Cache-Control':'no-store'}});
export async function POST(request){
  const denied=await requireApiAuth(request);if(denied)return denied;
  if(!validateSameOrigin(request))return originErrorResponse();
  const rate=checkRateLimit(request,{id:'soccer-manual-simulation',limit:60,windowMs:60000});if(!rate.allowed)return rateLimitResponse(rate);
  try{
    const input=await readJsonBody(request,2048);
    if(!validSoccerSimulationInput(input)||!validSoccerAnalysisQuery({league:input.league,date:input.date,eventId:input.eventId}))
      return reply({ok:false,reason:'SIMULATION_INPUT_INVALID'},400);
    const snapshot=await loadSoccerAnalysisRevision(input.league,`soccer:${input.league}:${input.eventId}`,input.date,input.revision);
    const result=simulateSoccerManualQuote({input,snapshot});
    return reply(result,result.ok?200:422);
  }catch(error){return reply({ok:false,reason:[400,413].includes(error.status)?'SIMULATION_INPUT_INVALID':'SIMULATION_SOURCE_UNAVAILABLE'},[400,413].includes(error.status)?error.status:503);}
}
