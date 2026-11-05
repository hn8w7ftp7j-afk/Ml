#!/usr/bin/env node
// Read-only operator diagnostic. Export DATABASE_V2_URL (or DATABASE_URL) and
// any existing server-side period binding before running. Never pass secrets as
// arguments. The output is research-only and contains no raw device identifiers.
import { pathToFileURL } from 'node:url';
import { readSoccerRetrospectivePairDiagnostic } from '../lib/soccer/retrospective-pair-service.js';
import { listSoccerRetrospectiveGames } from '../lib/soccer/retrospective-game-inventory.js';

export async function runSoccerRetrospectivePairDiagnostic(args, options = {}) {
  const usage='Usage: node scripts/soccer-retrospective-pair-diagnostic.mjs --league epl|ucl --date YYYY-MM-DD [--game-id soccer:ucl:123 | --list-games]';
  if(![4,5,6].includes(args.length)||args[0]!=='--league'||args[2]!=='--date'
    ||args.length===5&&args[4]!=='--list-games'||args.length===6&&args[4]!=='--game-id')throw Error(usage);
  try {
    if(args.length===5)return await (options.listGames||listSoccerRetrospectiveGames)(args[1],args[3]);
    return await readSoccerRetrospectivePairDiagnostic({league:args[1],date:args[3],...(args.length===6?{gameId:args[5]}:{})},options);
  } catch(error) { if(error?.status===400)throw Error(usage); throw error; }
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try { const report=await runSoccerRetrospectivePairDiagnostic(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(report,null,2)}\n`); }
  catch(error) { process.stderr.write(`Retrospective diagnosis unavailable: ${error?.message === 'SOCCER_FORWARD_PROTOCOL_CONFLICT' ? 'forward protocol unavailable or inconsistent' : 'invalid scope or database read failed'}\n`); process.exitCode=1; }
}
