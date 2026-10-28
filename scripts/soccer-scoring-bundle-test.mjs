import assert from 'node:assert/strict';
import { SOCCER_SCORING_BUNDLE_VERSION, soccerScoringBundleHash, resolveSoccerScoringBundle, revalidateSoccerScoringBundle } from '../lib/soccer/scoring-bundle.js';
import { acceptedSoccerArtifactRegistrations, acceptedSoccerRuntimeBundles } from '../lib/soccer/scoring-bundle-registry.js';
import { buildSoccerMarketDirections } from '../lib/soccer/market-directions.js';
import { fixtureScoringBundle, fixtureScoringBundleModule, fixtureScoringFactory } from './helpers/soccer-scoring-bundle-fixture.mjs';
import { fixtureCapture, sha, iso, observed } from './helpers/soccer-forward-fixture.mjs';

const capture=fixtureCapture(),game=capture.snapshot.evidence.game,now=observed;
const distribution={...capture.snapshot.prediction,league:game.league,gameId:game.id};
const reader={revision:sha('test-reader'),observationId:sha('test-reader-observation'),observedAt:iso(now),
  firstFetchedAt:iso(now),receivedAt:iso(now),persistedAt:iso(now),sourceHost:'www.tai888.in',pageUrl:'https://www.tai888.in/newapp/'};
const market={kind:'TOTAL',unit:'GOALS',period:'FT',line:'2.5',overWater:.95,underWater:.9,rawRows:['大 2.5 .95','小 .9'],
  periodEvidence:{sectionTitle:'英格蘭超級聯賽',tableHeaders:['全場'],marketHeader:'全場大小',period:'FT',status:'EXPLICIT'}};
const directions=buildSoccerMarketDirections({game,reader,now,matchedGames:[{officialGameId:game.id,league:'EPL',boardDate:game.date,prestart:true,matchStatus:'MATCHED',markets:[market]}]});
const quote=directions.find(row=>row.direction==='TOTAL_OVER'&&row.period==='FT').quotes[0],evidence=capture.snapshot.evidence;
const context={game,quote,distribution,evidence,now};
const source={provider:'EXPLICIT_SYNTHETIC_ENGINEERING_TEST_NOT_EMPIRICAL_APPROVAL',url:'https://fixture.invalid/scoring-evidence',contentHash:sha('test-source'),
  sourcePublishedAt:iso(now-3),fetchedAt:iso(now-2),availableAt:iso(now-1)};
const scenarios=[{id:'synthetic-scenario',weight:1,league:game.league,gameId:game.id,period:'FT',modelVersion:distribution.modelVersion,
  trainingHash:distribution.trainingHash,sources:[source],distribution}];
const uncertaintyBody={version:'SOCCER-EXPLICIT-SCENARIO-RETURNS-v1',league:game.league,period:'FT',modelVersion:distribution.modelVersion,
  trainingHash:distribution.trainingHash,aggregation:'WEIGHTED_Q10_AND_EMPIRICAL_ERROR',quantile:.10,createdAt:iso(now),trainedThrough:iso(now-1000),
  scenariosHash:soccerScoringBundleHash(scenarios),modelError:{value:.02,unit:'NET_PROFIT_PER_1_STAKE',validationArtifactHash:sha('test-validation'),validationSamples:20,source}};
const uncertainty={...uncertaintyBody,artifactHash:soccerScoringBundleHash(uncertaintyBody)};
const acceptance=Object.fromEntries(['model','calibration','uncertainty'].map(kind=>[kind,{status:'VERIFIED',league:game.league,period:'FT',
  modelVersion:distribution.modelVersion,trainingHash:distribution.trainingHash,artifactHash:kind==='uncertainty'?uncertainty.artifactHash:sha(`test-${kind}`),source}]));
const inputs={scenarios,uncertainty,acceptance},bundle=fixtureScoringBundle(context,inputs);
assert.equal(bundle.version,SOCCER_SCORING_BUNDLE_VERSION);
assert.ok(Object.isFrozen(acceptedSoccerArtifactRegistrations));assert.ok(Object.isFrozen(acceptedSoccerRuntimeBundles));
assert.equal(acceptedSoccerArtifactRegistrations.length,0);assert.equal(acceptedSoccerRuntimeBundles.length,0);
assert.equal(resolveSoccerScoringBundle({...context,inputs,bundle,registeredScoringBundles:[bundle]}).code,'SOCCER_SCORING_BUNDLE_MISSING','caller-supplied bundles/manifests cannot populate server authority');
const trusted=await fixtureScoringBundleModule([bundle]),resolved=trusted.module.resolveSoccerScoringBundle(context);
assert.equal(resolved.status,'AVAILABLE');assert.deepEqual(resolved.inputs,inputs);
assert.equal(resolved.receipt.inputsHash,soccerScoringBundleHash(inputs));
const saved={inputBundle:resolved.receipt,calculationInputs:resolved.inputs};
assert.equal(trusted.module.revalidateSoccerScoringBundle({...context,saved}).ok,true);
assert.equal(revalidateSoccerScoringBundle({...context,saved}).ok,false,'the real empty registry cannot accept test-only saved VERIFIED fields');
const alteredInputs=structuredClone(saved);alteredInputs.calculationInputs.uncertainty.modelError.value=0;
assert.equal(trusted.module.revalidateSoccerScoringBundle({...context,saved:alteredInputs}).ok,false);
const alteredReceipt=structuredClone(saved);alteredReceipt.inputBundle.expiresAt=iso(now+3600000);
assert.equal(trusted.module.revalidateSoccerScoringBundle({...context,saved:alteredReceipt}).ok,false);
for(const changed of [
  {game:{...game,away:{...game.away,sourceId:'999'}}},
  {quote:{...quote,water:1.2}},
  {distribution:{...distribution,homeRate:10}},
  {evidence:{...evidence,weather:{status:'VERIFIED'}}},
])assert.equal(trusted.module.resolveSoccerScoringBundle({...context,...changed}).code,'SOCCER_SCORING_BUNDLE_CONTEXT_MISMATCH');
assert.equal(trusted.module.resolveSoccerScoringBundle({...context,game:{...game,id:'soccer:epl:999',sourceId:'999'},distribution:{...distribution,gameId:'soccer:epl:999'}}).status,'MISSING');
assert.equal(trusted.module.resolveSoccerScoringBundle({...context,now:now+180000}).code,'SOCCER_SCORING_BUNDLE_EXPIRED');
assert.equal(trusted.module.revalidateSoccerScoringBundle({...context,saved,now:now+180000}).ok,false);
const tampered=structuredClone(bundle);tampered.inputs.uncertainty.modelError.value=.01;
assert.equal((await fixtureScoringBundleModule([tampered])).module.resolveSoccerScoringBundle(context).code,'SOCCER_SCORING_BUNDLE_HASH_MISMATCH');
const late=fixtureScoringBundle(context,inputs,{createdAt:iso(now+1),availableAt:iso(now+1)});
assert.equal((await fixtureScoringBundleModule([late])).module.resolveSoccerScoringBundle(context).code,'SOCCER_SCORING_BUNDLE_UNAVAILABLE_AT_CUTOFF');
const stale=fixtureScoringBundle(context,inputs,{validFrom:iso(now-100),expiresAt:iso(now)});
assert.equal((await fixtureScoringBundleModule([stale])).module.resolveSoccerScoringBundle(context).code,'SOCCER_SCORING_BUNDLE_EXPIRED');
const duplicate=await fixtureScoringBundleModule([bundle,bundle]);
assert.equal(duplicate.module.resolveSoccerScoringBundle(context).code,'SOCCER_SCORING_BUNDLE_AMBIGUOUS');
const badSource=structuredClone(inputs);badSource.scenarios[0].sources[0].availableAt=iso(now+1);
const badSourceBundle=fixtureScoringBundle(context,badSource);
assert.equal((await fixtureScoringBundleModule([badSourceBundle])).module.resolveSoccerScoringBundle(context).code,'SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID');
const noError=structuredClone(inputs);delete noError.uncertainty.modelError;
assert.equal((await fixtureScoringBundleModule([fixtureScoringBundle(context,noError)])).module.resolveSoccerScoringBundle(context).code,'SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID');
resolved.inputs.scenarios[0].weight=.1;
assert.equal(trusted.module.resolveSoccerScoringBundle(context).inputs.scenarios[0].weight,1,'resolved data are detached, registry entries stay immutable');
const factory=fixtureScoringFactory(context,inputs),factoryModule=await fixtureScoringBundleModule([factory]);
const firstFactory=factoryModule.module.resolveSoccerScoringBundle(context);
assert.equal(firstFactory.status,'AVAILABLE',JSON.stringify(firstFactory));
const secondQuote=directions.find(row=>row.direction==='TOTAL_UNDER'&&row.period==='FT').quotes[0];
assert.notEqual(secondQuote.key,quote.key,'both contexts are original quotes generated by the actual Reader adapter');
const secondFactory=factoryModule.module.resolveSoccerScoringBundle({...context,quote:secondQuote});
assert.equal(secondFactory.status,'AVAILABLE');assert.equal(secondFactory.receipt.factoryId,firstFactory.receipt.factoryId);
assert.notEqual(secondFactory.receipt.bundleHash,firstFactory.receipt.bundleHash);
assert.notEqual(secondFactory.receipt.quoteHash,firstFactory.receipt.quoteHash);
assert.equal(secondFactory.receipt.sourceQuoteKey,secondQuote.key);
const factorySaved={inputBundle:firstFactory.receipt,calculationInputs:firstFactory.inputs};
assert.equal(factoryModule.module.revalidateSoccerScoringBundle({...context,now:now+1000,saved:factorySaved}).ok,true,'publication replays the exact original generation cutoff against current factory authority');
assert.equal(revalidateSoccerScoringBundle({...context,saved:factorySaved}).ok,false,'revoked/unregistered factory does not inherit saved approval');
const changedFactory=await fixtureScoringBundleModule([fixtureScoringFactory(context,inputs,{factoryVersion:'2'})]);
assert.equal(changedFactory.module.revalidateSoccerScoringBundle({...context,saved:factorySaved}).ok,false,'changed reviewed factory version cannot silently authorize an old receipt');
const expiredFactory=await fixtureScoringBundleModule([fixtureScoringFactory(context,inputs,{expiresAt:iso(now+500)})]);
assert.equal(expiredFactory.module.revalidateSoccerScoringBundle({...context,now:now+1000,saved:factorySaved}).ok,false);
assert.equal(factoryModule.module.resolveSoccerScoringBundle({...context,asOf:now-1}).code,'SOCCER_SCORING_BUNDLE_UNAVAILABLE_AT_CUTOFF','original source receipts cannot be backdated to an earlier input cutoff');
const changedGenerator={...factory,generateInputs:()=>({})};
assert.equal((await fixtureScoringBundleModule([changedGenerator])).module.resolveSoccerScoringBundle(context).code,'SOCCER_SCORING_BUNDLE_ARTIFACT_INVALID');
const {transform}=await import('next/dist/build/swc/index.js');
const compiledFactory=await fixtureScoringBundleModule([factory],{transformSource:async code=>(await transform(code,{
  filename:'soccer-registered-factory.js',minify:true,jsc:{target:'es2022',parser:{syntax:'ecmascript'}},module:{type:'es6'},
})).code});
assert.equal(compiledFactory.module.resolveSoccerScoringBundle(context).status,'AVAILABLE','reviewed generator provenance survives actual Next/SWC minification');
assert.equal(compiledFactory.module.revalidateSoccerScoringBundle({...context,now:now+1000,saved:factorySaved}).ok,true,'compiled runtime replays the same approved inputs/hash as source runtime');
console.log('PASS trusted soccer scoring bundles: server-owned shared registry, exact game/quote/model/evidence hashes, explicit artifact/source/cutoff/expiry binding, missing/error/ambiguity fail closed, detached inputs, exact saved-input revalidation and revocation; synthetic fixtures never register production approval');
