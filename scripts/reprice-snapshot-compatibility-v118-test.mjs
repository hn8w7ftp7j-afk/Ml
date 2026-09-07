import assert from 'node:assert/strict';
import { register } from 'node:module';
import { assessRepriceSnapshotCompatibilityV1 } from '../lib/reprice-snapshot-compatibility-v1.js';
import { leagueAnalysisContract } from '../lib/league-provider.js';
import { DATA_VERSION } from '../lib/snapshot-v9.js';
import { signRepriceSnapshot, verifyRepriceSnapshot } from '../lib/market-integrity-v1.js';
import { createSessionToken } from '../lib/security.js';

register('./next-route-test-loader.mjs', import.meta.url);
const expectedFor = league => ({ modelVersion: leagueAnalysisContract(league).modelVersion, dataVersion: DATA_VERSION });
for (const league of ['MLB', 'NPB', 'KBO', 'CPBL']) {
  const expected = expectedFor(league);
  const current = { versions: expected, frozenContext: { modelVersion: expected.modelVersion } };
  const unchanged = JSON.stringify(current);
  assert.equal(assessRepriceSnapshotCompatibilityV1(current, expected).compatible, true);
  for (const field of ['modelVersion', 'dataVersion']) {
    const prior = { ...current, versions: { ...expected, [field]: `prior-${expected[field]}` } };
    assert.equal(assessRepriceSnapshotCompatibilityV1(prior, expected).compatible, false, `${league} stale ${field} must force full analysis`);
  }
  assert.equal(assessRepriceSnapshotCompatibilityV1({ frozenContext: current.frozenContext }, expected).compatible, false, 'missing signed versions cannot inherit current defaults');
  assert.equal(assessRepriceSnapshotCompatibilityV1({ ...current, frozenContext: { modelVersion: 'legacy-context' } }, expected).compatible, false, 'current envelope cannot mask an old model in the frozen context');
  assert.equal(JSON.stringify(current), unchanged, 'compatibility inspection must not migrate or mutate stored snapshots');
}
assert.equal(assessRepriceSnapshotCompatibilityV1({ versions: expectedFor('NPB') }, expectedFor('KBO')).compatible, false, 'model contracts remain isolated by league');

const saved = Object.fromEntries(['APP_PASSWORD', 'SESSION_SECRET', 'MARKET_INTEGRITY_SECRET', 'VERCEL_ENV', 'VERCEL', 'NODE_ENV'].map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
let fetchCount = 0;
try {
  process.env.APP_PASSWORD = 'compatibility-fixture-password';
  process.env.SESSION_SECRET = 'compatibility-fixture-session-secret';
  process.env.MARKET_INTEGRITY_SECRET = 'compatibility-fixture-market-secret';
  process.env.VERCEL_ENV = 'development';
  process.env.NODE_ENV = 'test';
  delete process.env.VERCEL;
  globalThis.fetch = async () => { fetchCount += 1; throw new Error('Version rejection must not fetch external data'); };
  const token = await createSessionToken();
  const route = await import('../app/api/reprice/route.js');
  const game = { leagueId: 'MLB', league: 'MLB', gamePk: 990701, gameDate: new Date(Date.now() + 6 * 60 * 60_000).toISOString(), awayTeamId: 111, homeTeamId: 141, away: 'Boston Red Sox', home: 'Toronto Blue Jays', status: 'Scheduled', statusCode: 'S' };
  const expected = expectedFor('MLB');
  const base = {
    frozenContext: { leagueId: 'MLB', game, fetchedAt: new Date().toISOString(), modelVersion: expected.modelVersion },
    inputHash: 'immutable-input', coreFingerprint: 'immutable-core', distributionId: 'immutable-distribution', distributionHash: 'immutable-hash',
    versions: expected,
  };
  const post = snapshot => route.POST(new Request('https://example.test/api/reprice', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.test', 'Sec-Fetch-Site': 'same-origin', Cookie: `mlb_session=${encodeURIComponent(token)}`, 'X-Forwarded-For': '198.51.100.73' },
    body: JSON.stringify({ league: 'MLB', snapshot, markets: [] }),
  }));
  for (const distributionSnapshot of [undefined, { distributionId: 'immutable-distribution', distributionHash: 'immutable-hash' }]) {
    const legacy = await signRepriceSnapshot('MLB', game, { ...base, versions: { ...expected, modelVersion: 'legacy-model' }, ...(distributionSnapshot ? { distributionSnapshot } : {}) });
    const frozen = JSON.stringify(legacy);
    assert.equal(await verifyRepriceSnapshot('MLB', game, legacy), true, 'old signed snapshots remain authentic');
    const response = await post(legacy);
    const payload = await response.json();
    assert.equal(response.status, 409);
    assert.equal(payload.code, 'CORE_REFRESH_REQUIRED');
    assert.ok(payload.snapshotCompatibility.reasons.includes('MODEL_VERSION_CHANGED'));
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(JSON.stringify(legacy), frozen, 'neither compact nor full archived distributions are rewritten');
    assert.equal(await verifyRepriceSnapshot('MLB', game, legacy), true);
  }
  const signed = await signRepriceSnapshot('MLB', game, base);
  const tampered = await post({ ...signed, versions: { ...expected, dataVersion: 'tampered-data' } });
  const tamperedPayload = await tampered.json();
  assert.equal(tampered.status, 409);
  assert.match(tamperedPayload.error, /簽章無效|已被修改/);
  assert.notEqual(tamperedPayload.code, 'CORE_REFRESH_REQUIRED', 'tampering must not be disguised as a routine version upgrade');

  const currentWithWrongHash = await signRepriceSnapshot('MLB', game, { ...base, distributionSnapshot: { distributionId: base.distributionId, distributionHash: 'wrong-hash' } });
  const currentResponse = await post(currentWithWrongHash);
  const currentPayload = await currentResponse.json();
  assert.equal(currentResponse.status, 409);
  assert.match(currentPayload.error, /比分分布識別不一致/, 'current versions still pass through independent distribution integrity validation');
  assert.notEqual(currentPayload.code, 'CORE_REFRESH_REQUIRED');
  assert.equal(fetchCount, 0);
  console.log(JSON.stringify({ ok: true, leagues: 4, staleCompactAndFullRejected: true, signedHistoryUnmodified: true, tamperingRejectedFirst: true, currentHashGuardPreserved: true }));
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(saved)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
}
