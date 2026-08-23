import assert from 'node:assert/strict';
import { buildInjuryRunValueV2 } from '../lib/mlb-injury-run-value-v2.js';

const result = buildInjuryRunValueV2({
  observedAt: '2026-08-23T06:00:00.000Z',
  leagueOps: 0.720,
  teamOps: 0.700,
  lineup: { official: false, players: Array.from({ length: 9 }, (_, index) => ({ id: index + 1 })) },
  injuredRoster: {
    available: true,
    roster: [{ person: { id: 99, fullName: 'Impact Bat', stats: [{ splits: [{ stat: { plateAppearances: 400, ops: 0.900 } }] }] } }],
  },
});
assert.equal(result.status, 'PROJECTED');
assert.equal(result.validationStatus, 'PENDING');
assert.equal(result.absentPlayers.length, 1);
assert.ok(result.regressedValue.absentRunsPerGame > 0);
assert.equal(result.appliedValue.absentRunsPerGame, 0, 'unvalidated injury input must remain neutral');
assert.equal(buildInjuryRunValueV2({ injuredRoster: { available: false } }).status, 'MISSING');
console.log('MLB injury replacement run-value input PASS');

