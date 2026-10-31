import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildSoccerCalibrationRows, fitSoccerCalibrationResearch, predictSoccerCalibrationResearch,
  buildSoccerCalibrationValidationPlan, evaluateSoccerCalibrationProspectiveValidation, soccerCalibrationHash } from '../lib/soccer/calibration-research.js';
import { buildSoccerCalibrationArtifact, writeSoccerCalibrationShadowRuntime } from './soccer-calibration-build.mjs';
import { soccerCalibrationShadowArtifacts } from '../lib/soccer/calibration-frozen.js';

const directory = 'research/soccer/calibration-v1';
const documents = JSON.parse(gunzipSync(await fs.readFile(`${directory}/retained-documents.json.gz`)));
const models = JSON.parse(await fs.readFile(`${directory}/frozen-base-models.json`, 'utf8'));
const manifest = JSON.parse(await fs.readFile(`${directory}/manifest.json`, 'utf8'));
const clone = value => structuredClone(value);
const seal = value => { const { contentHash, ...body } = value; return { ...body, contentHash: soccerCalibrationHash(body) }; };
const refresh = document => { document.source.contentHash = createHash('sha256').update(JSON.stringify(document.data)).digest('hex'); return document; };
const candidates = {}, datasets = {};
for (const league of ['epl', 'ucl']) {
  datasets[league] = buildSoccerCalibrationRows({ ...documents[league], league, from: manifest.from, through: manifest.through, now: Date.parse(manifest.createdAt) });
  candidates[league] = fitSoccerCalibrationResearch({ dataset: datasets[league], ...models[league], createdAt: manifest.createdAt });
  assert.equal(candidates[league].status, 'DEVELOPMENT_FIT_AVAILABLE');
  assert.equal(candidates[league].totals.games, league === 'epl' ? 17 : 18);
  assert.equal(candidates[league].diagnostic.before.FT.games, candidates[league].diagnostic.after.FT.games);
  assert.equal(candidates[league].diagnostic.before.HT.games, candidates[league].diagnostic.after.HT.games);
  assert.equal(candidates[league].diagnostic.before.HT.probabilityAudit.modelHash, candidates[league].jointHalfTimeModelHash);
  assert.equal(candidates[league].improvementEstablished, false);
  assert.equal(candidates[league].prospectiveValidation.untouchedVerifiedGames, 0);
  assert.equal(datasets[league].normalizedDocumentHashRecomputed, true);
  assert.equal(datasets[league].rawSourceHashRecomputed, false);
  for (const field of ['accepted', 'formalEligible', 'promotionEligible', 'executable']) assert.equal(candidates[league][field], false);
  for (const field of ['W', 'R', 'S', 'empiricalErrorMargin']) assert.equal(candidates[league][field], null);
}
const context = { ...models.epl, createdAt: manifest.createdAt }, candidate = candidates.epl;
const badDocument = clone(documents.epl); badDocument.scoreboard.data.events[0].name += ' tampered';
assert.throws(() => buildSoccerCalibrationRows({ ...badDocument, league: 'epl', from: manifest.from, through: manifest.through, now: Date.parse(manifest.createdAt) }), /SOURCE_DOCUMENT_INVALID/);
const foreignDocument = clone(documents.epl); foreignDocument.scoreboard.source.url = foreignDocument.scoreboard.source.url.replace('/eng.1/', '/uefa.champions/');
assert.throws(() => buildSoccerCalibrationRows({ ...foreignDocument, league: 'epl', from: manifest.from, through: manifest.through, now: Date.parse(manifest.createdAt) }), /SOURCE_DOCUMENT_INVALID/);
const foreignSummary = clone(documents.epl); foreignSummary.summaries[0].data.header.league = { id: '775', slug: 'uefa.champions' }; refresh(foreignSummary.summaries[0]);
assert.throws(() => buildSoccerCalibrationRows({ ...foreignSummary, league: 'epl', from: manifest.from, through: manifest.through, now: Date.parse(manifest.createdAt) }), /SUMMARY_DOCUMENT_INVALID/);
assert.throws(() => fitSoccerCalibrationResearch({ ...context, dataset: datasets.ucl }), /FIT_CONTEXT_INVALID/);
assert.throws(() => fitSoccerCalibrationResearch({ ...context, dataset: datasets.epl, validationThrough: manifest.createdAt }), /VALIDATION_MUST_BE_FUTURE/);
const duplicated = seal({ ...datasets.epl, rows: [...datasets.epl.rows, datasets.epl.rows[0]] });
assert.throws(() => fitSoccerCalibrationResearch({ ...context, dataset: duplicated }), /DUPLICATE_GAME/);
const tooEarly = clone(datasets.epl); tooEarly.rows = [clone(tooEarly.rows[0])]; tooEarly.rows[0].startTime = '2026-10-18T12:00:00.000Z';
assert.equal(fitSoccerCalibrationResearch({ ...context, dataset: seal(tooEarly) }).status, 'MISSING_DEVELOPMENT_GAMES');
const zeroHalf = clone(datasets.epl); zeroHalf.rows = zeroHalf.rows.slice(0, 2).map(row => ({ ...row, homeGoals: 2, awayGoals: 2, halfTime: { ...row.halfTime, home: 0, away: 2 } }));
const boundary = fitSoccerCalibrationResearch({ ...context, dataset: seal(zeroHalf) });
assert.equal(boundary.status, 'DEVELOPMENT_FIT_AVAILABLE');
assert.deepEqual(boundary.parameters.halfTimeGoalShares, { home: 0, away: 1 });
assert.ok(Number.isFinite(boundary.diagnostic.after.HT.scoreLogLoss));
const noHomeGoals = clone(zeroHalf); noHomeGoals.rows = noHomeGoals.rows.map(row => ({ ...row, homeGoals: 0 }));
const noFinite = fitSoccerCalibrationResearch({ ...context, dataset: seal(noHomeGoals) });
assert.equal(noFinite.status, 'NO_FINITE_POSITIVE_RATE_SCALE'); assert.equal(noFinite.parameters, null);
const offsetTimes = clone(zeroHalf); offsetTimes.rows[0].source.fetchedAt = '2026-10-31T20:30:00-01:00'; offsetTimes.rows[0].halfTime.source.fetchedAt = '2026-10-31T21:00:00Z';
offsetTimes.rows[0].calibrationResultSources = [offsetTimes.rows[0].halfTime.source];
assert.equal(fitSoccerCalibrationResearch({ ...context, dataset: seal(offsetTimes) }).observations[0].resultAvailableAt, '2026-10-31T21:30:00.000Z');
console.log('PASS real 35-game complete parsed-source replay, exact FT/HT model groups, no historical PIT fabrication, one game one weight, source tampering and zero/one HT-share/no-positive-FT-exposure boundaries');

const row = datasets.epl.rows[0], game = { league: 'epl', eventId: '999999991', homeId: row.homeId, awayId: row.awayId,
  neutralSite: row.neutralSite, startTime: '2026-11-02T19:00:00.000Z' };
const capturedAt = '2026-11-01T12:00:00.000Z';
const future = predictSoccerCalibrationResearch({ candidate, ...models.epl, game, now: Date.parse(capturedAt) });
assert.ok(future.fullTime.tailMass >= 0 && future.fullTime.tailMass <= future.fullTime.tolerance * 1.1);
assert.ok(Math.abs(future.fullTime.retainedMass + future.fullTime.tailMass - 1) < 1e-10);
assert.ok(future.halfTime.homeRate <= future.fullTime.homeRate && future.halfTime.awayRate <= future.fullTime.awayRate);
assert.equal(future.halfTime.jointContract.fullTimeMarginalPreserved, true);
assert.equal(future.fullTime.trainingHash === models.epl.model.trainingHash, false);
assert.equal(future.accepted, false); assert.equal(future.R, null);
const boundaryFuture = predictSoccerCalibrationResearch({ candidate: boundary, ...models.epl, game, now: Date.parse(capturedAt) });
assert.equal(boundaryFuture.halfTime.homeRate, 0); assert.equal(boundaryFuture.halfTime.awayRate, boundaryFuture.fullTime.awayRate);
assert.throws(() => predictSoccerCalibrationResearch({ candidate, ...models.epl, game: { ...game, sourceId: row.eventId, eventId: undefined }, now: Date.parse(capturedAt) }), /CONTEXT_INVALID/);
for (const changedGame of [{ ...game, id: 'soccer:epl:111' }, { ...game, home: { sourceId: '123456' } }, { ...game, sourceId: '111' }, { ...game, eventId: undefined }])
  assert.throws(() => predictSoccerCalibrationResearch({ candidate, ...models.epl, game: changedGame, now: Date.parse(capturedAt) }), /CONTEXT_INVALID/);
assert.throws(() => predictSoccerCalibrationResearch({ candidate, ...models.epl, game, now: Date.parse(candidate.createdAt) - 1 }), /CONTEXT_INVALID/);
console.log('PASS isolated future-only research predictions preserve complete FT→HT distribution and explicit tail; used-game, alias/team/event, model and time scope cannot be bypassed');

// These mutated documents are isolated counterexamples, never written into the
// retained real source package or represented as observed Production samples.
function futureDocuments({ homeScore = null, neutralSite = null } = {}) {
  const scoreboard = clone(documents.epl.scoreboard), summary = clone(documents.epl.summaries.find(document => document.data.header.id === row.eventId));
  const event = clone(scoreboard.data.events.find(event => event.id === row.eventId));
  event.id = game.eventId; event.uid = `s:600~l:700~e:${game.eventId}`; event.date = game.startTime;
  event.competitions[0].id = game.eventId; event.competitions[0].uid = `${event.uid}~c:${game.eventId}`;
  event.competitions[0].date = game.startTime; event.competitions[0].startDate = game.startTime;
  summary.data.header.id = game.eventId; summary.data.header.uid = event.uid;
  summary.data.header.competitions[0].id = game.eventId; summary.data.header.competitions[0].uid = event.competitions[0].uid;
  summary.data.header.competitions[0].date = game.startTime;
  if (neutralSite !== null) { event.competitions[0].neutralSite = neutralSite; summary.data.header.competitions[0].neutralSite = neutralSite; }
  if (homeScore !== null) {
    const h = event.competitions[0].competitors.find(team => team.homeAway === 'home'); h.score = String(homeScore);
    const hs = summary.data.header.competitions[0].competitors.find(team => team.homeAway === 'home'); hs.score = String(homeScore);
    hs.linescores = [{ period: 1, value: 1 }, { period: 2, value: homeScore - 1 }];
    const as = summary.data.header.competitions[0].competitors.find(team => team.homeAway === 'away');
    as.linescores = [{ period: 1, value: 1 }, { period: 2, value: Number(as.score) - 1 }];
  }
  scoreboard.data.events = [event]; summary.source.url = `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/summary?event=${game.eventId}`;
  for (const document of [scoreboard, summary]) { document.source.fetchedAt = '2026-11-03T12:00:00.000Z'; document.source.requestedAt = document.source.fetchedAt; refresh(document); }
  return { scoreboard, summaries: [summary] };
}
const plan = buildSoccerCalibrationValidationPlan(candidate);
const prediction = { game, candidateHash: candidate.contentHash, capturedAt, fullTime: future.fullTime, halfTime: future.halfTime };
const record = { prediction, captureReceipt: { fixtureOnly: true }, resultDocuments: futureDocuments() };
const validationContext = { candidate, plan, ...models.epl, freezeReceipt: { frozenAt: '2026-10-31T23:00:00.000Z', fixtureOnly: true },
  records: [record], now: Date.parse('2026-11-04T00:00:00.000Z') };
assert.equal(evaluateSoccerCalibrationProspectiveValidation(validationContext).untouchedVerifiedGames, 0);
const trustedFixtureContext = { ...validationContext, verifyFreezeReceipt: () => true, verifyCaptureReceipt: () => true };
const validated = evaluateSoccerCalibrationProspectiveValidation(trustedFixtureContext);
assert.equal(validated.untouchedVerifiedGames, 1, JSON.stringify(validated.exclusions));
assert.equal(validated.accepted, false); assert.equal(validated.improvementEstablished, false);
assert.equal(validated.before.FT.games, validated.after.FT.games); assert.equal(validated.before.HT.games, validated.after.HT.games);
assert.equal(validated.completeWithinRequestedScope, false);
assert.equal(evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [record, record] }).untouchedVerifiedGames, 1);
const alteredPrediction = clone(record); alteredPrediction.prediction.fullTime.homeRate += .01;
assert.equal(evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [alteredPrediction] }).untouchedVerifiedGames, 0);
const conflicting = { ...record, resultDocuments: futureDocuments({ homeScore: 2 }) };
const quarantined = evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [record, conflicting] });
assert.equal(quarantined.untouchedVerifiedGames, 0); assert.equal(quarantined.quarantinedGames, 1);
const internallyConflicting = clone(record); internallyConflicting.resultDocuments.summaries.push(futureDocuments({ homeScore: 2 }).summaries[0]);
const quarantineInside = evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [record, internallyConflicting] });
assert.equal(quarantineInside.untouchedVerifiedGames, 0); assert.equal(quarantineInside.quarantinedGames, 1);
const metadataOnly = clone(record); const updatedMetadata = clone(metadataOnly.resultDocuments.summaries[0]);
updatedMetadata.data.unrelatedNewsMetadata = { headline: 'metadata only' }; refresh(updatedMetadata); metadataOnly.resultDocuments.summaries.push(updatedMetadata);
assert.equal(evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [metadataOnly] }).untouchedVerifiedGames, 1);
for (const change of [
  document => { document.data.header.competitions[0].status.period = 3; },
  document => { document.data.header.status = { period: 3, type: { name: 'STATUS_FULL_TIME' } }; },
  document => { document.data.header.competitions[0].status.type.name = 'STATUS_FULL_TIME_AET'; },
  document => { document.data.header.competitions[0].status.type.name = 'STATUS_FULL_TIME_PENALTIES'; },
  document => { document.data.header.competitions[0].status.type.name = 'STATUS_FINAL_PEN'; },
  document => { document.data.header.competitions[0].status.type.name = 'STATUS_FINAL_PENS'; },
  document => { document.data.header.competitions[0].status.type.name = 'STATUS_FINAL_PSO'; },
  document => { (document.data.keyEvents ||= []).push({ period: { number: 3 } }); },
  document => { const team = document.data.header.competitions[0].competitors[0]; (team.linescores ||= []).push({ period: 3, value: 0 }); },
]) {
  const extraPeriod = clone(record), extraSummary = clone(extraPeriod.resultDocuments.summaries[0]);
  change(extraSummary); refresh(extraSummary); extraPeriod.resultDocuments.summaries.push(extraSummary);
  const rebuilt = buildSoccerCalibrationRows({ ...extraPeriod.resultDocuments, league: 'epl', from: game.startTime.slice(0, 10),
    through: game.startTime.slice(0, 10), now: trustedFixtureContext.now });
  assert.equal(rebuilt.rows.length, 0, 'one normal-time summary cannot override same-game extra-period evidence');
  assert.ok(rebuilt.excluded.some(value => value.eventId === game.eventId && value.reason === 'CALIBRATION_RESULT_DOCUMENT_CONFLICT'));
  const replayed = evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [record, extraPeriod] });
  assert.equal(replayed.untouchedVerifiedGames, 0, 'later extra-period evidence revokes an older accepted normal-time result');
  assert.equal(replayed.quarantinedGames, 1);
}
for (const change of [
  event => { event.status.period = 3; event.competitions[0].status.period = 3; },
  event => { event.competitions[0].competitors[0].linescores = [{ period: 1, value: 1 }, { period: 2, value: 0 }, { period: 3, value: 0 }]; },
]) {
  const extraBoard = clone(record); change(extraBoard.resultDocuments.scoreboard.data.events[0]); refresh(extraBoard.resultDocuments.scoreboard);
  const replayed = evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [record, extraBoard] });
  assert.equal(replayed.untouchedVerifiedGames, 0, 'explicit scoreboard extra periods quarantine the game even if its summary still reports normal time');
  assert.equal(replayed.quarantinedGames, 1);
}
assert.equal(evaluateSoccerCalibrationProspectiveValidation({ ...trustedFixtureContext, records: [{ ...record, resultDocuments: futureDocuments({ neutralSite: !game.neutralSite }) }] }).untouchedVerifiedGames, 0);
console.log('PASS future validation requires trusted durable freeze AND original pregame DB receipt, recomputes saved score distribution and complete result JSON; duplicates do not inflate games and cross/within-record score or extra-period conflicts quarantine the whole game');
assert.equal((await buildSoccerCalibrationArtifact(['--retained-only', '--output-dir', directory])).status, 'REPRODUCED_EXACTLY');
console.log('PASS retained document bytes, frozen models, candidate fits and future validation plans reproduce exactly without fetching or changing Production baseline/W/R/S');
const loaded = soccerCalibrationShadowArtifacts('epl');
assert.equal(loaded.candidate.contentHash, candidate.contentHash);
assert.equal(loaded.registryHash, soccerCalibrationShadowArtifacts('ucl').registryHash);
loaded.candidate.parameters.fullTimeRateScales.home = 999;
assert.equal(soccerCalibrationShadowArtifacts('epl').candidate.parameters.fullTimeRateScales.home, candidate.parameters.fullTimeRateScales.home);
assert.throws(() => soccerCalibrationShadowArtifacts('nba'), /ARTIFACT_INVALID/);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'soccer-calibration-runtime-'));
try {
  const generatedPath = path.join(temporary, 'generated.mjs');
  const generated = await writeSoccerCalibrationShadowRuntime({ directory, outputFile: generatedPath });
  assert.equal(generated.registryHash, loaded.registryHash);
  const actualSource = await fs.readFile('lib/soccer/calibration-frozen.js', 'utf8'), generatedSource = await fs.readFile(generatedPath, 'utf8');
  assert.equal(generatedSource, actualSource);
  const rawData = JSON.parse(generatedSource.match(/const data = (.*);\nconst validSeal/)[1]);
  rawData.candidates.epl.parameters.fullTimeRateScales.home += .01;
  const { contentHash: ignored, ...tamperedBody } = rawData; rawData.contentHash = soccerCalibrationHash(tamperedBody);
  const invalidSource = generatedSource.replace(/const data = (.*);\nconst validSeal/, `const data = ${JSON.stringify(rawData)};\nconst validSeal`)
    .replace("'./calibration-research.js'", JSON.stringify(pathToFileURL(path.resolve('lib/soccer/calibration-research.js')).href));
  await fs.writeFile(generatedPath, invalidSource);
  const invalidRuntime = await import(pathToFileURL(generatedPath).href);
  assert.throws(() => invalidRuntime.soccerCalibrationShadowArtifacts('epl'), /ARTIFACT_INVALID/);
} finally { await fs.rm(temporary, { recursive: true, force: true }); }
console.log('PASS fixed server runtime loader reproduces byte-for-byte, detaches caller mutations, checks candidate/plan/exact-model hashes, and rejects changed calibration parameters even if the outer registry seal is recomputed');
