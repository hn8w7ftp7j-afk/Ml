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
assert.equal(result.settlementCapabilities.find(row => row.league === 'NPB').declaredFullGameReady, false);
assert.equal(result.settlementCapabilities.find(row => row.league === 'CPBL').declaredFirst5Ready, false);
assert.equal(result.settlementCapabilities.find(row => row.league === 'MLB').declaredFullGameReady, null, 'no inferred verification for undeclared capability');
const released = operationalReadiness({ configuredReady: true, formalScoringEnabled: true });
assert.equal(released.ready, false);
assert.equal(released.checks.formalModelRelease.status, 'NOT_VERIFIED');
assert.equal(operationalReadiness().configurationReady, false);
console.log('PASS configuration and operational readiness remain distinct');
