import assert from 'node:assert/strict';
import { soccerSqlFixture } from './helpers/soccer-sql-fixture.mjs';
import { soccerForwardHash as hash } from '../lib/soccer/forward-validation.js';
import { fitSoccerReturnErrorResearch, SOCCER_RETURN_ERROR_VERSION } from '../lib/soccer/return-error-model.js';
import { soccerDate } from '../lib/soccer/contracts.js';

// Synthetic statistical rows exercise prospective receipt timing, not empirical
// football quality. The shipped store runs against actual PostgreSQL JSONB and
// its database clock; no Production connection or record is used.
const fixture = await soccerSqlFixture(), { db } = fixture;
const old = process.env.DATABASE_URL, oldV2 = process.env.DATABASE_V2_URL;
process.env.DATABASE_URL = 'postgres://fixture.invalid/return-error-validation'; delete process.env.DATABASE_V2_URL;
const store = await import('../lib/soccer/return-error-validation-store.js');
const { runSoccerReturnErrorValidation } = await import('../lib/soccer/return-error-validation-service.js');
const { soccerReturnErrorValidationCommand } = await import('./soccer-return-error-validation.mjs');
const iso = value => new Date(value).toISOString(), seal = value => ({ ...value, contentHash: hash(value) });
try {
  await store.ensureSoccerReturnErrorValidationStore();
  const now = await store.soccerReturnErrorDatabaseNow(), trainingBefore = now + 1000, calibrationBefore = now + 2000, testBefore = now + 60000;
  const input = { league: 'epl', from: soccerDate(now-86400000), trainingBefore: iso(trainingBefore), calibrationBefore: iso(calibrationBefore), testBefore: iso(testBefore) };
  await assert.rejects(() => store.registerSoccerReturnErrorProtocol({ ...input, registeredAt: iso(now-10000) }), /SCOPE_INVALID/);
  await assert.rejects(() => store.registerSoccerReturnErrorProtocol({ ...input, miscoverage:'0.1' }), /DATES_INVALID/);
  const receipt = await store.registerSoccerReturnErrorProtocol(input), protocol = receipt.protocol;
  assert.equal(receipt.status, 'DATABASE_PROSPECTIVE_PROTOCOL'); assert.equal(receipt.accepted, false);
  assert.ok(Date.parse(receipt.registeredAt) < trainingBefore);
  assert.deepEqual(await store.registerSoccerReturnErrorProtocol(input), receipt, 'same plan has one original database registration time');
  await assert.rejects(() => store.registerSoccerReturnErrorProtocol({ ...input, trainingBefore: iso(now-10000), calibrationBefore: iso(now-5000) }), /REGISTRATION_TOO_LATE/);
  await assert.rejects(() => db.query('UPDATE sports_soccer_return_error_protocols_v1 SET registered_at=registered_at-interval \'1 day\' WHERE protocol_id=$1',[receipt.protocolId]), /immutable/i);
  const makeRow = (number,kickoff,checkedAt) => ({ observationId: hash(`synthetic-row-${number}`),
    league: 'epl', gameId: `soccer:epl:${900000000+number}`, period: 'FT', variant: 'BASELINE',
    modelHash: hash('synthetic-model'), settlementRuleFamilyHash: hash('synthetic-rule'), contractHash: hash(`exact-${number}`), kind: 'TOTAL', side: 'OVER',
    kickoff: iso(kickoff), predictionCapturedAt: iso(kickoff-1), checkedAt: iso(checkedAt),
    predictedNetReturn: .1, realizedNetReturn: number%2 ? .9 : -.99, predictionError: (number%2 ? .9 : -.99)-.1, actualScore: { home: number%2, away: 0 } });
  const observations = [makeRow(0,now-2000,now-1000),makeRow(1,now-1500,now-500),
    ...Array.from({length:9},(_,index)=>makeRow(index+2,trainingBefore+index*50,trainingBefore+index*50+1))];
  const dataset = rows => seal({ version: SOCCER_RETURN_ERROR_VERSION, type: 'VALIDATED_RETURN_ERROR_DATASET', selection: protocol.selection,
    observations: rows, boundedObservations: [], quarantinedGameKeys: [], excludedReasons: {}, coverage: { completeWithinRequestedScope: true } });
  const datasets = [dataset(observations)];
  const premature = fitSoccerReturnErrorResearch({ datasets, protocol, now: calibrationBefore+1 });
  await assert.rejects(() => store.freezeSoccerReturnErrorParameters(receipt.protocolId,premature), /FREEZE_WINDOW_INVALID/);
  const remaining = calibrationBefore-Date.now()+10; if (remaining>0) await new Promise(resolve=>setTimeout(resolve,remaining));
  const fitted = fitSoccerReturnErrorResearch({ datasets, protocol, now: await store.soccerReturnErrorDatabaseNow() });
  assert.equal(fitted.groups.length,1); assert.equal(fitted.groups[0].testUntouchedVerified,false);
  const saved = await store.freezeSoccerReturnErrorParameters(receipt.protocolId,fitted);
  assert.equal(saved.freezes.length,1); assert.equal(saved.freezes[0].accepted,false);
  const authority = await store.loadSoccerReturnErrorFreezeVerifier(receipt.protocolId), freeze = saved.freezes[0];
  assert.deepEqual(authority.freezes,saved.freezes);
  const before = iso(Number(BigInt(freeze.frozenEpochMicros)/1000n)-1);
  const after = iso(Number(BigInt(freeze.frozenEpochMicros)/1000n)+10);
  const verify = at => authority.verifyFrozenModelReceipt({ parameterHash: freeze.parameterHash, protocolHash: receipt.protocolHash, calibrationBefore: protocol.calibrationBefore, before: at });
  assert.equal(verify(before),false); assert.equal(verify(after),true);
  if (BigInt(freeze.frozenEpochMicros)%1000n) assert.equal(verify(freeze.frozenAt),false,'rounded JS milliseconds cannot backdate PostgreSQL microseconds');
  assert.equal(authority.verifyFrozenModelReceipt({ parameterHash: '0'.repeat(64), protocolHash: receipt.protocolHash, calibrationBefore: protocol.calibrationBefore, before: after }),false);
  authority.freezes[0].frozenEpochMicros='0'; authority.protocol.protocolHash='0'.repeat(64);
  assert.equal(verify(before),false,'mutating detached display receipts cannot backdate the private verifier');
  assert.equal(verify(after),true,'private verifier retains original database protocol/time binding');
  await assert.rejects(() => db.query('DELETE FROM sports_soccer_return_error_freezes_v1 WHERE freeze_id=$1',[freeze.freezeId]), /immutable/i);
  assert.deepEqual((await store.freezeSoccerReturnErrorParameters(receipt.protocolId,fitted)).freezes,saved.freezes);
  const test = makeRow(20,calibrationBefore+10000,calibrationBefore+11000); test.predictionCapturedAt=after;
  const validated = fitSoccerReturnErrorResearch({ datasets: [dataset([...observations,test])], protocol,
    now: calibrationBefore+12000, verifyFrozenModelReceipt: authority.verifyFrozenModelReceipt });
  assert.equal(validated.groups[0].testUntouchedVerified,true,'actual immutable DB receipt now satisfies the shipped fitter callback');
  assert.equal(validated.groups[0].parameterHash,freeze.parameterHash,'adding test outcomes cannot refit parameters');
  assert.equal(validated.groups[0].accepted,false); assert.equal(validated.groups[0].R,null);
  await assert.rejects(() => store.freezeSoccerReturnErrorParameters(receipt.protocolId,validated), /FREEZE_ARTIFACT_INVALID/,'test outcomes cannot be included in a new pretest freeze');
  const retuned = structuredClone(fitted), group = retuned.groups[0]; group.biasCorrection+=.01;
  const fitKeys=['groupHash','biasCorrection','realizedReturnBandRadius','calibrationRank','calibrationGames','trainingObservationHashes','calibrationObservationHashes','protocolHash'];
  group.parameterHash=hash(Object.fromEntries(fitKeys.map(key=>[key,group[key]]))); delete retuned.contentHash; retuned.contentHash=hash(retuned);
  await assert.rejects(() => store.freezeSoccerReturnErrorParameters(receipt.protocolId,retuned), /ALREADY_FROZEN_DIFFERENTLY/);
  const calls=[], service = await runSoccerReturnErrorValidation({ protocolId:receipt.protocolId,operation:'evaluate' }, {
    databaseNow: async()=>calibrationBefore+12000,
    scan: async(scope,options)=>{calls.push(scope); await options.onGameEvidence({}, { now:calibrationBefore+12000 }); return {report:{complete:true,scan:{nextCursor:null,processedGames:1}}};},
    buildDataset:async()=>dataset([...observations,test]),
  });
  assert.deepEqual(calls,[{league:'epl',from:input.from,through:soccerDate(calibrationBefore+11999)}]);
  assert.equal(service.artifact.groups[0].testUntouchedVerified,true);
  assert.equal(service.formalEligible,false); assert.equal(service.artifact.R,null);
  await assert.rejects(()=>runSoccerReturnErrorValidation({protocolId:receipt.protocolId},{maxDatasetBytes:1,
    databaseNow:async()=>calibrationBefore+12000,buildDataset:async()=>dataset(observations),
    scan:async(_scope,options)=>{await options.onGameEvidence({},{now:calibrationBefore+12000});throw Error('must not reach complete');}}),/DATASET_MEMORY_BUDGET/);
  await assert.rejects(()=>runSoccerReturnErrorValidation({protocolId:receipt.protocolId,operation:'accept'}),/OPERATION_INVALID/);
  let cliCalls=0;
  const cli=await soccerReturnErrorValidationCommand(['evaluate','--protocol-id',receipt.protocolId],{run:async options=>{cliCalls++;assert.deepEqual(options,{protocolId:receipt.protocolId,operation:'evaluate'});return service;}});
  assert.equal(cli.accepted,false);assert.equal(cli.formalEligible,false);assert.equal(cliCalls,1);
  await assert.rejects(()=>soccerReturnErrorValidationCommand(['evaluate','--protocol-id',receipt.protocolId,'--from',input.from],{run:async()=>{cliCalls++;}}),/COMMAND_INVALID/);
  assert.equal(cliCalls,1,'evaluation cannot narrow a preregistered scope after results are seen');
  console.log('PASS prospective return-error receipts: actual PostgreSQL clock and JSONB, no backdating, immutable plan/parameters, exact microsecond pretest checks, fixed scope replay, unsupported/retuned/test-bearing freeze rejection, shipped fitter receives genuine receipt verifier; no model acceptance or formal R');
} finally {
  if(old===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=old;
  if(oldV2===undefined)delete process.env.DATABASE_V2_URL;else process.env.DATABASE_V2_URL=oldV2;
  await fixture.close();
}
