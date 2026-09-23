import assert from 'node:assert/strict';
import { buildGameContextV13, parseHomePlateUmpireV13 } from '../lib/mlb-context-v13.js';
import { buildJointScoreSnapshotV13 } from '../lib/joint-score-v13.js';

const official = (id, name, officialType = 'Home Plate') => ({ officialType, official: { id, fullName: name } });
const feed = officials => ({ liveData: { boxscore: { officials } } });
const reported = official(12345, 'Synthetic Umpire');
assert.equal(parseHomePlateUmpireV13(null).status, 'MISSING');
assert.equal(parseHomePlateUmpireV13(feed({})).status, 'MISSING');
assert.equal(parseHomePlateUmpireV13(feed([official(12345, 'Synthetic Umpire', 'First Base')])).status, 'MISSING');
assert.equal(parseHomePlateUmpireV13(feed([reported])).status, 'CONFIRMED');
assert.equal(parseHomePlateUmpireV13(feed([reported, structuredClone(reported)])).id, 12345, 'identical duplicate transport rows do not create ambiguity');
for (const id of [null, '', 0, -1, 1.5, Infinity, true, {}, 'not-an-id']) {
  assert.equal(parseHomePlateUmpireV13(feed([official(id, 'Synthetic Umpire')])).status, 'MISSING', `invalid ID ${String(id)} cannot confirm an assignment`);
}
for (const name of [null, '', '  ', {}]) {
  assert.equal(parseHomePlateUmpireV13(feed([official(12345, name)])).status, 'MISSING');
}
for (const conflict of [official(12346, 'Second Umpire'), official(12345, 'Conflicting Name'), official(null, '')]) {
  const parsed = parseHomePlateUmpireV13(feed([reported, conflict]));
  assert.equal(parsed.status, 'MISSING', 'conflicts must not be resolved by source order');
  assert.equal(parsed.id, null);
  assert.deepEqual(parseHomePlateUmpireV13(feed([conflict, reported])), parsed);
}

const game = { leagueId: 'MLB', gamePk: 800002, awayTeamId: 1, homeTeamId: 2,
  gameDate: '2099-09-22T18:00:00.000Z', officialDate: '2099-09-22', scheduledInnings: 9 };
const contextFor = officials => buildGameContextV13(game, {
  timeoutMs: 100,
  fetchImpl: async input => {
    const url = new URL(input);
    if (url.pathname.includes('/feed/live')) return Response.json({
      ...feed(officials), gamePk: game.gamePk,
      gameData: { datetime: { dateTime: game.gameDate, officialDate: game.officialDate }, teams: { away: { id: 1 }, home: { id: 2 } }, players: {} },
    });
    if (url.pathname.endsWith('/schedule')) return Response.json({ dates: [] });
    if (url.pathname.endsWith('/roster')) return Response.json({ roster: [] });
    return Response.json({ stats: [{ splits: [] }] });
  },
});
const missing = await contextFor([]);
const confirmed = await contextFor([reported]);
assert.equal(missing.umpire.status, 'MISSING');
assert.equal(confirmed.umpire.identityStatus, 'CONFIRMED');
assert.equal(confirmed.sourceStatuses.umpire, 'CONFIRMED');
assert.equal(confirmed.sourceStatuses.umpireIdentity, 'CONFIRMED');
assert.equal(confirmed.sourceStatuses.umpireEffect, 'NEUTRAL_UNVALIDATED');
assert.equal(confirmed.umpire.publishedAt, null, 'a fetch receipt cannot become an official publication timestamp');
const provenance = confirmed.featureProvenance.find(row => row.featureName === 'umpireIdentity');
assert.equal(provenance.status, 'CONFIRMED');
assert.equal(provenance.value.id, 12345);
assert.equal(provenance.asOf, null, 'the previous statistical day does not date a current assignment');
assert.equal(provenance.publishedAt, null);
assert.ok(provenance.fetchedAt && provenance.rawPayloadHash);
assert.ok(provenance.dependencyReceipts.every(row => row.sourceRecord.endsWith(`/${game.gamePk}/feed/live`)), 'identity provenance must not borrow unrelated Savant receipts');
assert.equal(confirmed.dataGateV10.rows.find(row => row.name === 'umpire').status, 'MISSING', 'legacy effect-validation gate is unchanged');
assert.deepEqual(confirmed.dataGateV10, missing.dataGateV10);
assert.equal(confirmed.dataQualityV10, missing.dataQualityV10);
assert.equal(confirmed.modelErrorMarginEV, missing.modelErrorMarginEV);
for (const side of ['away', 'home']) assert.equal(confirmed[side].advanced.umpireZone.appliedValue.runsPerGame, 0);
assert.ok(confirmed.warnings.some(row => row.includes('未取得完整已確認的當場打線')));
assert.ok(!confirmed.warnings.some(row => row.includes('正式打線尚未完整公布')));

// Identity metadata must not promote an effect or alter the scored distribution.
// Provenance/hash IDs intentionally differ; the 27 weighted scenarios do not.
const snapshotFor = context => buildJointScoreSnapshotV13({ context, modelVersion: 'test', rulesVersion: 'test' });
const missingSnapshot = snapshotFor(missing);
const confirmedSnapshot = snapshotFor(confirmed);
assert.deepEqual(confirmedSnapshot.scenarios, missingSnapshot.scenarios);
for (const key of ['baseline', 'first5', 'middle3', 'ninth', 'full', 'uncertainty', 'dispersion']) {
  assert.deepEqual(confirmedSnapshot.profile[key], missingSnapshot.profile[key], `${key} remains unchanged by identity metadata`);
}
assert.deepEqual(confirmedSnapshot.profile.dataUsage.find(row => row.key === 'umpire'), {
  key: 'umpire', usedInMean: false, usedInUncertainty: false, reason: 'IDENTITY_ONLY_NO_VALIDATED_CATCHER_NEUTRAL_RESIDUAL',
});
console.log('MLB umpire identity evidence: PASS; legacy gate, error margin and 27 scenarios unchanged');
