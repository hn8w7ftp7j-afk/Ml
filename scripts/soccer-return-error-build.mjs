import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSoccerReturnErrorDataset, buildSoccerReturnErrorDatasetHydrated, fitSoccerReturnErrorResearch, SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL } from '../lib/soccer/return-error-model.js';

export async function buildSoccerReturnErrorArtifact(args=process.argv.slice(2),deps={}) {
  const options={};
  for(let index=0;index<args.length;index++){
    const key=args[index];
    if(['--database','--include-dataset','--help'].includes(key)){options[key.slice(2)]=true;continue;}
    if(!['--input','--output','--protocol','--league','--from','--through','--as-of'].includes(key)||!args[index+1]||args[index+1].startsWith('--'))throw Error('Invalid or incomplete argument');
    options[key.slice(2)]=args[++index];
  }
  if(options.help)return{help:'node scripts/soccer-return-error-build.mjs (--input evidence.json | --database --from YYYY-MM-DD --through YYYY-MM-DD [--league epl|ucl]) [--protocol candidate.json] [--as-of ISO] [--include-dataset] [--output artifact.json]\nRead-only research. Without reviewed split boundaries or observed source-verified returns, the artifact reports missing data and null estimates. No acceptance or formal R is created.'};
  if(Boolean(options.input)===Boolean(options.database))throw Error('Choose exactly one source: --input or --database');
  const now=options['as-of']?Date.parse(options['as-of']):Date.now();
  if(!Number.isFinite(now))throw Error('Invalid --as-of timestamp');
  const protocol=options.protocol?JSON.parse(await fs.readFile(options.protocol,'utf8')):SOCCER_RETURN_ERROR_CANDIDATE_PROTOCOL;
  let datasets=[],complete=true;
  if(options.input)datasets=[buildSoccerReturnErrorDataset(JSON.parse(await fs.readFile(options.input,'utf8')),{now})];
  else{
    if(!options.from||!options.through)throw Error('Database reads require explicit --from and --through dates');
    const scope={league:options.league||null,from:options.from,through:options.through};
    const scan=deps.scan||(await import('../lib/soccer/forward-validation-scan.js')).continueSoccerForwardScan;
    let cursor=null,processed=-1,result;
    do{
      result=await scan(scope,{cursor,purpose:'read',onGameEvidence:async(evidence,context)=>{
        datasets.push(await buildSoccerReturnErrorDatasetHydrated(evidence,{...context,now:Math.min(context.now,now)}));
      }});
      cursor=result.report.scan.nextCursor;
      if(cursor&&result.report.scan.processedGames<=processed)throw Error('Database scan did not advance');
      processed=result.report.scan.processedGames;
    }while(cursor);
    complete=result.report.complete===true;
  }
  const artifact=fitSoccerReturnErrorResearch({datasets,protocol,now,requestedScopeComplete:complete});
  const result=options['include-dataset']?{artifact,datasets}:artifact;
  if(options.output){
    await fs.mkdir(path.dirname(path.resolve(options.output)),{recursive:true});
    const handle=await fs.open(options.output,'w',0o600);
    try{await handle.chmod(0o600);await handle.writeFile(`${JSON.stringify(result,null,2)}\n`);}finally{await handle.close();}
  }
  return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const result=await buildSoccerReturnErrorArtifact();
    if(result.help)process.stdout.write(`${result.help}\n`);
    else if(process.argv.includes('--output'))process.stdout.write(`${JSON.stringify({status:result.artifact?.status||result.status,accepted:false,observedQuoteReturns:result.artifact?.observedQuoteReturns??result.observedQuoteReturns})}\n`);
    else process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  }catch(error){process.stderr.write(`${error.message==='Invalid or incomplete argument'||error.message.startsWith('Choose exactly')||error.message.startsWith('Database reads')||error.message==='Invalid --as-of timestamp'?error.message:'Return-error research build failed; no artifact was accepted.'}\n`);process.exitCode=1;}
}
