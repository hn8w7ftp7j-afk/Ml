import assert from 'node:assert/strict';
import { operationalReadiness } from '../lib/operational-readiness.js';
import { publicLeagueRegistry } from '../lib/leagues.js';

const result = operationalReadiness({ configuredReady: true, formalScoringEnabled: false, leagues: publicLeagueRegistry() });
assert.equal(result.configurationReady, true);
assert.equal(result.ready, false, 'configured secrets must not claim end-to-end success');
assert.equal(result.status, 'NOT_VERIFIED');
assert.equal(result.checks.formalModelRelease.status, 'BLOCK');
assert.equal(result.checks.ledgerReadback.status, 'NOT_VERIFIED');
assert.equal(result.settlementCapabilities.length, 4);
for (const league of ['NPB', 'KBO', 'CPBL']) {
  const capability = result.settlementCapabilities.find(row => row.league === league);
  assert.equal(capability.declaredFullGameReady, true);
  assert.equal(capability.declaredFirst5Ready, true);
  assert.equal(capability.verificationStatus, 'NOT_VERIFIED', 'a connected feed must not claim live end-to-end verification');
}
assert.equal(result.settlementCapabilities.find(row => row.league === 'MLB').declaredFullGameReady, null, 'no inferred verification for undeclared capability');
const released = operationalReadiness({ configuredReady: true, formalScoringEnabled: true });
assert.equal(released.ready, false);
assert.equal(released.checks.formalModelRelease.status, 'NOT_VERIFIED');
assert.equal(operationalReadiness().configurationReady, false);
console.log('PASS configuration and operational readiness remain distinct');
