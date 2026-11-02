import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { registerSoccerReturnErrorProtocol } from '../lib/soccer/return-error-validation-store.js';
import { runSoccerReturnErrorValidation } from '../lib/soccer/return-error-validation-service.js';

const help = `Prospective football return-error research (no model acceptance or formal R).
Register explicit future boundaries before training closes:
  node scripts/soccer-return-error-validation.mjs register --league epl|ucl --from YYYY-MM-DD --training-before ISO --calibration-before ISO --test-before ISO [--miscoverage 0.1]
After calibration closes, replay the registered complete database scope and freeze supported parameters:
  node scripts/soccer-return-error-validation.mjs freeze --protocol-id HASH [--output /private/artifact.json]
Later, replay the same registered scope and verify the immutable pretest receipt:
  node scripts/soccer-return-error-validation.mjs evaluate --protocol-id HASH [--output /private/artifact.json]
Dates are never chosen or backdated automatically. A freeze proves existence/time, not model or source acceptance.`;
export async function soccerReturnErrorValidationCommand(args = process.argv.slice(2), deps = {}) {
  if (!args.length || args[0] === '--help') return { help };
  const operation = args[0], values = {};
  if (!['register','freeze','evaluate'].includes(operation)) throw Error('RETURN_ERROR_COMMAND_INVALID');
  for (let index=1;index<args.length;index+=2) {
    const key=args[index], value=args[index+1];
    if (!['--league','--from','--training-before','--calibration-before','--test-before','--miscoverage','--protocol-id','--output'].includes(key)
      || value===undefined || value.startsWith('--') || Object.hasOwn(values,key)) throw Error('RETURN_ERROR_COMMAND_INVALID');
    values[key]=value;
  }
  let result;
  if (operation==='register') {
    if (Object.keys(values).some(key=>!['--league','--from','--training-before','--calibration-before','--test-before','--miscoverage','--output'].includes(key)))
      throw Error('RETURN_ERROR_COMMAND_INVALID');
    result=await (deps.register||registerSoccerReturnErrorProtocol)({league:values['--league'],from:values['--from'],
      trainingBefore:values['--training-before'],calibrationBefore:values['--calibration-before'],testBefore:values['--test-before'],
      ...(values['--miscoverage']!==undefined?{miscoverage:Number(values['--miscoverage'])}:{})});
  } else {
    if (!values['--protocol-id'] || Object.keys(values).some(key=>!['--protocol-id','--output'].includes(key))) throw Error('RETURN_ERROR_COMMAND_INVALID');
    result=await (deps.run||runSoccerReturnErrorValidation)({protocolId:values['--protocol-id'],operation});
  }
  if (values['--output']) {
    const target=path.resolve(values['--output']); await fs.mkdir(path.dirname(target),{recursive:true});
    const handle=await fs.open(target,'w',0o600);
    try { await handle.chmod(0o600); await handle.writeFile(`${JSON.stringify(result,null,2)}\n`); } finally { await handle.close(); }
  }
  return { operation, protocolId:result.protocolId||result.protocolReceipt?.protocolId,
    status:result.status||result.artifact?.status, frozenGroups:result.freezes?.length||0,
    observedGames:result.artifact?.observedGames??null, accepted:false, formalEligible:false, executable:false };
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try { const result=await soccerReturnErrorValidationCommand(); process.stdout.write(result.help?`${result.help}\n`:`${JSON.stringify(result)}\n`); }
  catch(error) { process.stderr.write(`${/^RETURN_ERROR_[A-Z0-9_]+$/.test(error?.message||'')?error.message:'RETURN_ERROR_VALIDATION_STORAGE_OR_SOURCE_UNAVAILABLE'}\n`); process.exitCode=1; }
}
