#!/usr/bin/env node
// Read-only operator diagnostic. Export DATABASE_V2_URL (or DATABASE_URL) and
// any existing server-side period binding before running. Never pass secrets as
// arguments. The output is research-only and contains no raw device identifiers.
import { pathToFileURL } from 'node:url';
import { readSoccerRetrospectivePairDiagnostic } from '../lib/soccer/retrospective-pair-service.js';

export async function runSoccerRetrospectivePairDiagnostic(args, options = {}) {
  if(args.length!==4||args[0]!=='--league'||args[2]!=='--date')
    throw Error('Usage: node scripts/soccer-retrospective-pair-diagnostic.mjs --league epl|ucl --date YYYY-MM-DD');
  try { return await readSoccerRetrospectivePairDiagnostic({league:args[1],date:args[3]},options); }
  catch(error) { if(error?.status===400)throw Error('Usage: node scripts/soccer-retrospective-pair-diagnostic.mjs --league epl|ucl --date YYYY-MM-DD'); throw error; }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try { const report=await runSoccerRetrospectivePairDiagnostic(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(report,null,2)}\n`); }
  catch(error) { process.stderr.write(`Retrospective diagnosis unavailable: ${error?.message === 'SOCCER_FORWARD_PROTOCOL_CONFLICT' ? 'forward protocol unavailable or inconsistent' : 'invalid scope or database read failed'}\n`); process.exitCode=1; }
}
