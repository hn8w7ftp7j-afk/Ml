import assert from 'node:assert/strict';
import { enrichSoccerPrematchInputs, soccerCurrentAnalysisSourceAvailability } from '../lib/soccer/prematch-inputs.js';

const game = { id: 'soccer:epl:100', league: 'epl', date: '2026-11-21', startTime: '2026-11-21T12:30:00Z' };
const now = Date.parse('2026-11-09T01:00:00Z');
function evidence() { return { game, teams: { home: { minutes: { status: 'UNKNOWN' } }, away: { minutes: { status: 'UNKNOWN' } } } }; }
const calls = [];
const weather = { status: 'PROVIDER_REPORTED', value: { temperatureC: 12 }, source: { provider: 'OPEN_METEO' }, formalEligible: false };
const conditions = { travel: { status: 'PROVIDER_REPORTED', value: { observed: true }, formalEligible: false },
  uclContext: { status: 'NOT_APPLICABLE', value: null } };
const dependencies = {
  fetchSoccerWeather: async (target, options) => { assert.equal(target, game); assert.equal(options.now(), now); return structuredClone(weather); },
  fetchSoccerMatchConditionsEvidence: async (input, options) => { assert.equal(input.game, game); assert.equal(options.now(), now); return structuredClone(conditions); },
  attachSoccerPersonnelInputs: () => ({ status: 'UNAVAILABLE' }),
  archiveSoccerObservation: async (_value, options) => { calls.push(options.field); return { status: 'ARCHIVED', persisted: true }; },
};
const connected = await enrichSoccerPrematchInputs(evidence(), { game, now, dependencies });
assert.deepEqual(calls.sort(), ['travel', 'weather']);
assert.equal(connected.weather.observationArchive.persisted, true);
assert.equal(connected.travel.observationArchive.persisted, true);
assert.equal(connected.teams.home.minutes.status, 'UNKNOWN', 'unavailable minutes preserve the original summary field');
assert.equal(connected.prematchInputConnection.modelEffectApplied, false);
assert.equal(connected.prematchInputConnection.formalEligible, false);
assert.equal(soccerCurrentAnalysisSourceAvailability(connected.weather.source, { evidence: connected, game, field: 'weather', now }), null,
  'injected archive flags never mint a source capability');
const partial = await enrichSoccerPrematchInputs(evidence(), { game, now, dependencies: { ...dependencies,
  fetchSoccerWeather: async () => { throw Error('private source details'); },
  archiveSoccerObservation: async () => { throw Error('private database details'); } } });
assert.equal(partial.weather.status, 'UNKNOWN');
assert.equal(partial.travel.value.observed, true, 'one failed source does not erase another observation');
assert.equal(partial.travel.observationArchive.persisted, false);
assert.equal(JSON.stringify(partial).includes('private'), false);
console.log('PASS connected prematch acquisition: independent failures, original unknown fields, per-source archives and no invented authority');
