import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { buildSoccerModelFamilyConfidenceSet, soccerModelFamilyHash as hash } from '../lib/soccer/model-family-uncertainty.js';

// Synthetic model-family rows test actual PostgreSQL authority and JSONB,
// not football applicability, source coverage or predictive performance.
const fixture=await soccerSqlFixture(),{db}=fixture;
const old={DATABASE_URL:process.env.DATABASE_URL,DATABASE_V2_URL:process.env.DATABASE_V2_URL};
process.env.DATABASE_URL='postgres://fixture.invalid/model-family-store';delete process.env.DATABASE_V2_URL;
const store=await import('../lib/soccer/model-family-store.js');
const iso=value=>new Date(value).toISOString(),day=86400000;
try {
  const now=await store.soccerModelFamilyDatabaseNow(),start=now-10*day;
  const baseline={league:'epl',period:'FT',modelHash:hash('synthetic-fixed-model'),trainingHash:hash('synthetic-training'),
    sourceHashes:[hash('synthetic-source')],trainedThrough:iso(start-2*day),createdAt:iso(start-day)};
  const protocol={registeredAt:iso(start-1000),calibrationFrom:iso(start),calibrationBefore:iso(now-day),alpha:.1};
  const observations=Array.from({length:3},(_,i)=>({league:'epl',period:'FT',baselineModelHash:baseline.modelHash,
    gameId:`soccer:epl:${900000001+i}`,homeRate:1.5,awayRate:1.1,actualScore:{home:i,away:1},
    sourceHashes:[hash(`synthetic-result-${i}`)],kickoff:iso(start+i*day+3600000),
    predictedAt:iso(start+i*day+3500000),resultAvailableAt:iso(start+i*day+7200000)}));
  const artifact=buildSoccerModelFamilyConfidenceSet({baseline,protocol,observations,now:now-5});
  assert.equal(artifact.independentRealGames,3);
  const input={artifact,testFrom:iso(now+60000),testBefore:iso(now+120000)};
  await assert.rejects(()=>store.freezeSoccerModelFamilyArtifact({...input,frozenAt:iso(now-day)}),/INPUT_INVALID/,
    'callers cannot supply or backdate the database receipt clock');
  const corrupted=structuredClone(artifact);corrupted.marginals.home.goals++;
  await assert.rejects(()=>store.freezeSoccerModelFamilyArtifact({...input,artifact:corrupted}),/ARTIFACT_INVALID/);
  const nonfinite=structuredClone(artifact);nonfinite.marginals.home.multiplier.upper=null;delete nonfinite.contentHash;nonfinite.contentHash=hash(nonfinite);
  await assert.rejects(()=>store.freezeSoccerModelFamilyArtifact({...input,artifact:nonfinite}),/ARTIFACT_INVALID/,
    'resealing an unavailable or nonfinite numerical bound cannot produce a freeze');
  const frozen=await store.freezeSoccerModelFamilyArtifact(input);
  assert.equal(frozen.status,'DATABASE_FROZEN_FAMILY_RESEARCH');
  assert.equal(frozen.calibrationProspectiveVerified,false,'new receipt cannot backdate already-seen calibration choices');
  assert.equal(frozen.coverageAssumptionsVerified,false);assert.equal(frozen.formalEligible,false);
  assert.equal(frozen.R,null);assert.equal(frozen.S,null);
  assert.ok(BigInt(frozen.frozenEpochMicros)>0n);
  assert.deepEqual(await store.freezeSoccerModelFamilyArtifact(input),frozen,'same parameters retain their first original receipt');
  const later=structuredClone(artifact);later.generatedAt=iso(now-2);delete later.contentHash;later.contentHash=hash(later);
  assert.deepEqual(await store.freezeSoccerModelFamilyArtifact({...input,artifact:later}),frozen,
    'rerunning identical parameters at a new generatedAt does not rewrite a pretest freeze');
  const retuned=buildSoccerModelFamilyConfidenceSet({baseline,protocol,observations:observations.map((row,i)=>i?row:{...row,actualScore:{home:7,away:1}}),now:now-2});
  await assert.rejects(()=>store.freezeSoccerModelFamilyArtifact({...input,artifact:retuned}),/ALREADY_FROZEN_DIFFERENTLY/,
    'same declared protocol and test window cannot replace frozen parameters after viewing more outcomes');
  await assert.rejects(()=>db.query('UPDATE sports_soccer_model_family_freezes_v1 SET frozen_at=frozen_at-interval \'1 day\' WHERE freeze_id=$1',[frozen.freezeId]),/immutable/i);
  await assert.rejects(()=>db.query('DELETE FROM sports_soccer_model_family_freezes_v1 WHERE freeze_id=$1',[frozen.freezeId]),/immutable/i);
  await assert.rejects(()=>store.freezeSoccerModelFamilyArtifact({...input,testFrom:iso(now-1000)}),/WINDOW_CLOSED/);
  const identity={league:baseline.league,period:baseline.period,modelHash:baseline.modelHash,trainingHash:baseline.trainingHash};
  assert.deepEqual(await store.loadLatestSoccerModelFamilyFreeze(identity),frozen);
  assert.equal(await store.loadLatestSoccerModelFamilyFreeze({...identity,period:'HT'}),null);
  assert.equal(await store.loadLatestSoccerModelFamilyFreeze({...identity,league:'ucl'}),null);
  assert.equal(await store.loadLatestSoccerModelFamilyFreeze({...identity,trainingHash:hash('foreign-training')}),null);
  const authority=await store.loadSoccerModelFamilyFreezeVerifier(frozen.freezeId);
  const proof={...identity,protocolHash:frozen.protocolHash,parameterHash:frozen.parameterHash,before:input.testFrom};
  assert.equal(authority.verifyFrozenParameters(proof),true);
  assert.equal(authority.verifyFrozenParameters({...proof,before:frozen.frozenAt}),false,'equal or rounded DB receipt does not prove prior ordering');
  assert.equal(authority.verifyFrozenParameters({...proof,before:input.testBefore}),false,'closed test window is exclusive');
  for(const key of ['modelHash','trainingHash','protocolHash','parameterHash'])
    assert.equal(authority.verifyFrozenParameters({...proof,[key]:hash('forged')}),false);
  assert.equal(authority.verifyFrozenParameters({...proof,league:'ucl'}),false);
  assert.equal(authority.verifyFrozenParameters({...proof,period:'HT'}),false);
  authority.freeze.frozenEpochMicros='0';authority.freeze.parameterHash=hash('mutated-display-receipt');
  assert.equal(authority.verifyFrozenParameters(proof),true,'private verifier is detached from mutable displayed receipt');

  const scope={...identity,calibrationFrom:protocol.calibrationFrom,calibrationBefore:protocol.calibrationBefore},revision=hash('actual-server-source-watermark');
  assert.equal(await store.readSoccerModelFamilyReport({scope,revision}),null);
  const cached=await store.saveSoccerModelFamilyReport({scope,revision,artifact});
  assert.equal(cached.persisted,true);assert.equal(cached.formalEligible,false);
  assert.deepEqual((await store.readSoccerModelFamilyReport({scope,revision})).artifact,artifact);
  assert.equal(await store.readSoccerModelFamilyReport({scope,revision:hash('new-source-watermark')}),null,
    'new source revision cannot read old derived statistics');
  assert.equal(await store.readSoccerModelFamilyReport({scope:{...scope,period:'HT'},revision}),null);
  await assert.rejects(()=>store.saveSoccerModelFamilyReport({scope:{...scope,league:'ucl'},revision,artifact}),/SCOPE_INVALID/);
  const refreshed=await store.saveSoccerModelFamilyReport({scope,revision,artifact:later});
  assert.equal(refreshed.artifact.contentHash,later.contentHash,'only derived cache may refresh');
  assert.deepEqual(await store.loadLatestSoccerModelFamilyFreeze(identity),frozen,'cache refresh cannot rewrite immutable parameter authority');
  const advanced=structuredClone(artifact);advanced.generatedAt=iso(now+day);delete advanced.contentHash;advanced.contentHash=hash(advanced);
  await assert.rejects(()=>store.saveSoccerModelFamilyReport({scope,revision:hash('future'),artifact:advanced}),/WRITE_FAILED/);
  await assert.rejects(()=>store.saveSoccerModelFamilyReport({scope,revision,artifact:advanced}),/WRITE_CONFLICT/,
    'a rejected future-dated refresh cannot claim an old cached artifact is the newly saved result');
  const promoted=structuredClone(artifact);promoted.formalEligible=true;delete promoted.contentHash;promoted.contentHash=hash(promoted);
  await assert.rejects(()=>store.saveSoccerModelFamilyReport({scope,revision,artifact:promoted}),/ARTIFACT_INVALID/);
  await db.query(`UPDATE sports_soccer_model_family_reports_v1 SET written_at=written_at-interval '1 day'`);
  assert.equal(await store.readSoccerModelFamilyReport({scope,revision}),null,'expired derived cache is unavailable, never an empty statistical sample');
  await db.query(`UPDATE sports_soccer_model_family_reports_v1 SET written_at=clock_timestamp(),artifact_hash=$1`,[hash('corrupt')]);
  await assert.rejects(()=>store.readSoccerModelFamilyReport({scope,revision}),/READBACK_INVALID/);
  console.log('PASS model-family PostgreSQL authority: canonical JSONB/artifact/parameter hashes, original immutable DB freeze and microsecond pretest ordering, no retroactive calibration approval, exact model/league/period identity, source-revision cache isolation/expiry/readback and no formal promotion');
} finally {
  for(const key of Object.keys(old)){if(old[key]===undefined)delete process.env[key];else process.env[key]=old[key];}
  await fixture.close();
}
