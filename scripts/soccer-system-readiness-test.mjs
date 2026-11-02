import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transform } from 'next/dist/build/swc/index.js';
import { soccerSystemScoringReadiness } from '../lib/soccer/system-readiness.js';
import { acceptedSoccerArtifactRegistrations, acceptedSoccerRuntimeBundles } from '../lib/soccer/scoring-bundle-registry.js';
import { soccerVerifiedSettlementContract } from '../lib/soccer/settlement-contract.js';
import { GET } from '../app/api/soccer/route.js';
import { createSessionToken } from '../lib/security.js';

const now = Date.parse('2026-11-01T00:00:00Z');
const expected = ['SETTLEMENT_CONTRACT', 'RUNTIME_INPUTS', 'MODEL_ACCEPTANCE', 'CALIBRATION_ACCEPTANCE', 'UNCERTAINTY_ACCEPTANCE'];
assert.ok(Object.isFrozen(acceptedSoccerArtifactRegistrations));
assert.ok(Object.isFrozen(acceptedSoccerRuntimeBundles));
for (const league of ['epl', 'ucl']) {
  const actual = soccerSystemScoringReadiness(league, now);
  assert.equal(actual.league, league);
  assert.equal(actual.status, 'BLOCKED');
  assert.equal(actual.scope, 'SERVER_CONFIGURATION_ONLY');
  assert.deepEqual(actual.blockers.map(row => row.code), expected);
  assert.equal(actual.formalScoringEnabled, false);
  assert.equal(actual.executable, false);
  for (const row of actual.dependencies) {
    assert.equal(row.owner, 'SYSTEM');
    assert.equal(row.status, 'MISSING_REGISTRATION');
    assert.deepEqual(row.registrations, { FT: 0, HT: 0 });
    assert.deepEqual(row.missingPeriods, ['FT', 'HT']);
  }
  assert.equal(actual.runtimeEvidenceRequired.some(label => label.includes('跨聯賽')), league === 'ucl');
  // Returned diagnostic objects are detached; caller changes cannot approve
  // either a registry, future diagnostic read or a settlement contract.
  actual.blockers[0].registrations.FT = 99;
  actual.blockers.splice(0);
  assert.deepEqual(soccerSystemScoringReadiness(league, now).blockers.map(row => row.code), expected);
  assert.equal(soccerVerifiedSettlementContract({ league, period: 'FT', kind: 'TOTAL', line: '3平' }), null);
}
for (const [league, time] of [['nba', now], ['epl', NaN], ['ucl', Infinity]])
  assert.throws(() => soccerSystemScoringReadiness(league, time), /SOCCER_SYSTEM_READINESS_SCOPE_INVALID/);

// Render the shipped panel before any game/quote/analysis exists. Its only
// authority is the same server payload returned by the board/status endpoint.
const source = fs.readFileSync('app/soccer/main-workspace.js', 'utf8')
  .replace(/^import .*?;\n/gm, '').replace('export default function', 'function');
const compiled = await transform(source, { filename: 'soccer-system-readiness.jsx', jsc: {
  parser: { syntax: 'ecmascript', jsx: true }, transform: { react: { runtime: 'classic' } },
} });
const context = vm.createContext({ React, Date });
vm.runInContext(compiled.code, context);
for (const league of ['epl', 'ucl']) {
  const value = soccerSystemScoringReadiness(league, now);
  const html = renderToStaticMarkup(context.SoccerSystemReadiness({ value, league }));
  assert.match(html, /正式評分尚缺系統依據/);
  assert.match(html, /原盤派彩規則尚未登錄/);
  assert.match(html, /正式評分輸入尚未接入/);
  assert.match(html, /重新同步盤口不會補齊/);
  assert.doesNotMatch(html, /SETTLEMENT_CONTRACT|RUNTIME_INPUTS|manifestHash|undefined|NaN/);
  for (const invalid of [null, { ...value, league: league === 'epl' ? 'ucl' : 'epl' },
    { ...value, formalScoringEnabled: true }, { ...value, checkedAt: 'invalid' }]) {
    const rejected = renderToStaticMarkup(context.SoccerSystemReadiness({ value: invalid, league }));
    assert.match(rejected, /評分系統狀態尚未核對/);
    assert.doesNotMatch(rejected, /正式評分尚缺系統依據/);
  }
}

const originalFetch = globalThis.fetch;
const authNames = ['APP_PASSWORD', 'SITE_ACCESS_PASSWORD', 'SESSION_SECRET'];
const originalEnv = Object.fromEntries(authNames.map(key => [key, process.env[key]]));
process.env.APP_PASSWORD = 'soccer-system-readiness-local-fixture';
process.env.SESSION_SECRET = 'soccer-system-readiness-local-fixture-secret';
try {
  const headers = { cookie: `mlb_session=${await createSessionToken()}` };
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; return new Response('', { status: 503 }); };
  for (const league of ['epl', 'ucl']) {
    const response = await GET(new Request(`https://fixture.invalid/api/soccer?league=${league}&view=status`, { headers }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.equal(body.league, league);
    assert.equal(body.scoringSystemReadiness.league, league);
    assert.deepEqual(body.scoringSystemReadiness.blockers.map(row => row.code),
      soccerSystemScoringReadiness(league).blockers.map(row=>row.code));
    assert.equal(body.capabilities.model, false);
  }
  assert.equal(fetches, 0, 'status must expose real registry blockers without needing games, Reader or a provider request');
  const failed = await GET(new Request('https://fixture.invalid/api/soccer?league=epl&date=2026-11-01', { headers }));
  assert.equal(failed.status, 503);
  const body = await failed.json();
  assert.equal(body.ok, false);
  assert.equal(body.scoringSystemReadiness.status, 'BLOCKED', 'provider outage must not erase independent configuration diagnosis');
  assert.equal(body.scoringSystemReadiness.league, 'epl');
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
console.log('PASS actual server registries → status/board API → visible pre-analysis blockers; no quote or fixture can fabricate scoring authority');
