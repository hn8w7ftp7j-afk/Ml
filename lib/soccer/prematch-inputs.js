import { fetchSoccerWeather } from './weather.js';
import { fetchSoccerMatchConditionsEvidence } from './match-conditions-evidence.js';
import { attachSoccerPersonnelInputs } from './personnel-inputs.js';
import { archiveSoccerObservation, unavailableSoccerObservationArchive, soccerCurrentObservationAvailability,
  restoreSoccerObservationAvailability } from './observation-store.js';
import { soccerCurrentSourceAvailability } from './source-document-store.js';

export const SOCCER_PREMATCH_INPUTS_VERSION = 'SOCCER-CONNECTED-PREMATCH-INPUTS-v1';
const fields = ['weather', 'travel', 'uclContext', 'teams.home.minutes', 'teams.away.minutes'];
const at = (value, field) => field.split('.').reduce((node, key) => node?.[key], value);
const missing = reason => ({ status: 'UNKNOWN', value: null, reason, source: null,
  modelEffectApplied: false, formalEligible: false, executable: false });

// Acquire independent observations concurrently. A provider failure is local to
// its field and cannot erase the original summary, quotes, or other observations.
// Every successful observation must archive its producer's private raw proof.
export async function enrichSoccerPrematchInputs(evidence, { game = evidence?.game, workload = evidence?.workload,
  now = Date.now, timeoutMs = 25000, dependencies = {} } = {}) {
  const deps = { fetchSoccerWeather, fetchSoccerMatchConditionsEvidence, attachSoccerPersonnelInputs,
    archiveSoccerObservation, ...dependencies };
  const clock = typeof now === 'function' ? now : () => now;
  const [weather, conditions] = await Promise.allSettled([
    deps.fetchSoccerWeather(game, { evidence, now: clock, timeoutMs }),
    deps.fetchSoccerMatchConditionsEvidence({ game, evidence, workload }, { now: clock, timeoutMs }),
  ]);
  evidence.weather = weather.status === 'fulfilled' && weather.value
    ? weather.value : missing('WEATHER_SOURCE_UNAVAILABLE');
  for (const field of ['travel', 'uclContext']) evidence[field] = conditions.status === 'fulfilled' && conditions.value?.[field]
    ? conditions.value[field] : missing('MATCH_CONDITIONS_SOURCE_UNAVAILABLE');
  let personnelStatus = 'UNAVAILABLE';
  try { personnelStatus = deps.attachSoccerPersonnelInputs(evidence, { now: clock() }).status; }
  catch { /* The unchanged normalized summary remains available on failure. */ }
  const archives = await Promise.all(fields.map(async field => {
    const observation = at(evidence, field);
    if (!observation || ['UNKNOWN', 'UNAVAILABLE', 'NOT_APPLICABLE'].includes(observation.status))
      return { field, status: 'NOT_AVAILABLE', reason: observation?.reason || observation?.status || 'OBSERVATION_MISSING' };
    try { observation.observationArchive = await deps.archiveSoccerObservation(observation, { game, field, evidence }); }
    catch { observation.observationArchive = unavailableSoccerObservationArchive(); }
    return { field, status: observation.observationArchive.status, persisted: observation.observationArchive.persisted === true,
      reason: observation.observationArchive.reason || null };
  }));
  evidence.prematchInputConnection = { version: SOCCER_PREMATCH_INPUTS_VERSION, gameId: game?.id || null,
    league: game?.league || null, observedAt: new Date(clock()).toISOString(), personnelStatus, archives,
    formalEligible: false, modelEffectApplied: false, executable: false };
  return evidence;
}

export function soccerCurrentAnalysisSourceAvailability(source, context) {
  return soccerCurrentSourceAvailability(source, context) || soccerCurrentObservationAvailability(source, context);
}

export async function restoreSoccerPrematchInputAvailability(evidence, now = Date.now()) {
  return Promise.all(fields.map(field => restoreSoccerObservationAvailability(evidence, { field, now })));
}
