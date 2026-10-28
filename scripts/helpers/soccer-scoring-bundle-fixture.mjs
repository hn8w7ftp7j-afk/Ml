import fs from 'node:fs';
import { SOCCER_SCORING_BUNDLE_VERSION, SOCCER_SCORING_FACTORY_VERSION, soccerScoringBundleContext, soccerScoringBundleHash } from '../../lib/soccer/scoring-bundle.js';

// Engineering fixtures only. No helper writes to the production registry.
export function fixtureScoringBundle(context, inputs, patch = {}) {
  const now = context.now, body = { version: SOCCER_SCORING_BUNDLE_VERSION, bundleId: 'SYNTHETIC-TEST-ONLY-NOT-PRODUCTION',
    ...soccerScoringBundleContext(context), createdAt: new Date(now).toISOString(), availableAt: new Date(now).toISOString(),
    validFrom: new Date(now).toISOString(), expiresAt: new Date(now + 180000).toISOString(),
    inputs, inputsHash: soccerScoringBundleHash(inputs), ...patch };
  return { ...body, bundleHash: soccerScoringBundleHash(body) };
}
export async function fixtureScoringBundleModule(bundles,{transformSource=null}={}) {
  const moduleUrl = new URL('../../lib/soccer/scoring-bundle.js', import.meta.url);
  const registrations=bundles.map(bundle=>{
    if(typeof bundle.generateInputs!=='function')return JSON.stringify(bundle);
    const data=JSON.stringify(Object.fromEntries(Object.entries(bundle).filter(([key])=>key!=='generateInputs')));
    return `{...${data},generateInputs:(${String(bundle.generateInputs)})}`;
  }).join(',');
  let code = fs.readFileSync(moduleUrl, 'utf8').replace("import { acceptedSoccerRuntimeBundles as registeredScoringBundles } from './scoring-bundle-registry.js';",
    `const registeredScoringBundles = Object.freeze([${registrations}]);`);
  code = code.replace(/(\bfrom\s*|\bimport\s*)(['"])(\.[^'"]+)\2/g, (_match, prefix, separator, specifier) => `${prefix}${separator}${new URL(specifier, moduleUrl).href}${separator}`);
  if(transformSource)code=await transformSource(code);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`;
  return { url, module: await import(url) };
}

export function fixtureScoringFactory(context, inputs, patch={}) {
  const generateInputs=new Function('context',`const inputs=${JSON.stringify(inputs)};
    inputs.scenarios=inputs.scenarios.map(scenario=>({...scenario,league:context.game.league,gameId:context.game.id,period:context.quote.period,
      modelVersion:context.distribution.modelVersion,trainingHash:context.distribution.trainingHash,distribution:context.distribution}));
    inputs.uncertainty.createdAt=new Date(context.now).toISOString();
    inputs.uncertainty.scenariosHash=soccerScoringBundleHash(inputs.scenarios);
    delete inputs.uncertainty.artifactHash;inputs.uncertainty.artifactHash=soccerScoringBundleHash(inputs.uncertainty);
    inputs.acceptance.uncertainty.artifactHash=inputs.uncertainty.artifactHash;
    return inputs;`);
  const at=new Date(context.now).toISOString(),body={version:SOCCER_SCORING_FACTORY_VERSION,factoryId:'SYNTHETIC-REVIEWED-FACTORY-TEST-ONLY',factoryVersion:'1',
    league:context.game.league,period:context.quote.period,modelVersion:context.distribution.modelVersion,trainingHash:context.distribution.trainingHash,
    createdAt:at,availableAt:at,validFrom:at,expiresAt:new Date(context.now+3600000).toISOString(),
    generatorVersion:'SYNTHETIC-GENERATOR-v1',generatorSourceHash:soccerScoringBundleHash('explicit-synthetic-reviewed-source-artifact-not-production-code-approval'),
    artifactRefs:{modelArtifactHash:inputs.acceptance.model.artifactHash,calibrationArtifactHash:inputs.acceptance.calibration.artifactHash,
      uncertaintyValidationArtifactHash:inputs.uncertainty.modelError.validationArtifactHash,scenarioProtocolHash:soccerScoringBundleHash('synthetic-scenario-protocol')},
    reviewReceipt:{status:'REVIEWED',evidenceRef:'synthetic://engineering-fixture-not-real-review',reviewedAt:at,
      manifestHashes:{model:soccerScoringBundleHash(inputs.acceptance.model),calibration:soccerScoringBundleHash(inputs.acceptance.calibration),
        uncertaintyTemplate:soccerScoringBundleHash(Object.fromEntries(Object.entries(inputs.acceptance.uncertainty).filter(([key])=>key!=='artifactHash')))}},...patch};
  return {...body,generateInputs,registrationHash:soccerScoringBundleHash(body)};
}
