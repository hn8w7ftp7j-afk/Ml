import { createHash } from 'node:crypto';
import { soccerLeague, soccerDate, validSoccerDate } from './contracts.js';
import { soccerExpectedMinutesArtifacts } from './expected-minutes-frozen.js';
import { buildSoccerExpectedMinutesResearch, soccerExpectedMinutesHash, SOCCER_EXPECTED_MINUTES_VERSION } from './expected-minutes-model.js';
import { soccerPlayerWorkloadArchiveProof, restoreSoccerPlayerWorkloadObservation } from './player-workload.js';

export const SOCCER_PERSONNEL_INPUTS_VERSION = 'SOCCER-BOUND-PREMATCH-PERSONNEL-INPUTS-v1';
const restrictions = { formalEligible: false, modelEffectApplied: false, pointInTimeAvailabilityVerified: false, executable: false };
const proofs = new WeakMap();
const clone = value => value === undefined ? undefined : structuredClone(value);
const id = value => typeof value === 'string' && /^\d{1,16}$/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
// Receipt metadata is attached after this bridge runs. Only this exact archive
// slot is excluded; player forecasts, model/source fields and all other input
// content remain covered by the process-local proof.
const minutesView = minutes => { const { observationArchive: _archive, ...view } = minutes; return view; };
const inputsView = inputs => ({ ...inputs, teams: Object.fromEntries(['home', 'away'].map(side => [side,
  { ...inputs.teams[side], minutes: minutesView(inputs.teams[side].minutes) }])) });
const seal = value => ({ ...value, contentHash: hash(value) });
const rawMinutes = evidence => ({ minutes: Object.fromEntries(['home', 'away'].map(side => [side, clone(evidence?.teams?.[side]?.minutes) ?? null])),
  present: Object.fromEntries(['home', 'away'].map(side => [side, Boolean(evidence?.teams?.[side] && Object.hasOwn(evidence.teams[side], 'minutes'))])) });
function inputFingerprint(evidence) {
  const game = evidence?.game;
  return hash({ ok: evidence?.ok, phase: evidence?.phase, game: game && { id: game.id, sourceId: game.sourceId,
    league: game.league, date: game.date, startTime: game.startTime, status: game.status,
    home: game.home?.sourceId, away: game.away?.sourceId }, source: evidence?.source, rawSource: evidence?.rawSource,
    teams: Object.fromEntries(['home', 'away'].map(side => [side, Object.fromEntries(['id', 'sourceId', 'lineup', 'injuries', 'suspensions']
      .map(field => [field, evidence?.teams?.[side]?.[field] ?? null]))])), workload: evidence?.workload ?? null });
}
function scopeValid(evidence, game, now) {
  const league = soccerLeague(game?.league), source = evidence?.source;
  return finite(now) && evidence?.ok === true && evidence.phase === 'PREMATCH_OBSERVATION' && league
    && id(game?.sourceId) && game.id === `soccer:${league.id}:${game.sourceId}` && validSoccerDate(game.date)
    && Number.isFinite(instant(game.startTime)) && instant(game.startTime) > now && soccerDate(game.startTime) === game.date
    && game.status === 'scheduled' && ['home', 'away'].every(side => id(game[side]?.sourceId))
    && game.home.sourceId !== game.away.sourceId && evidence.game?.id === game.id
    && ['sourceId', 'league', 'date', 'startTime', 'status'].every(field => evidence.game[field] === game[field])
    && ['home', 'away'].every(side => evidence.game[side]?.sourceId === game[side].sourceId
      && evidence.teams?.[side]?.sourceId === game[side].sourceId)
    && source?.provider === 'ESPN' && source.url === `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`
    && sha(source.contentHash) && Number.isFinite(instant(source.fetchedAt)) && instant(source.fetchedAt) <= now
    && now - instant(source.fetchedAt) <= 180000 && instant(source.fetchedAt) < instant(game.startTime);
}
function rosterFor(evidence, side, game, now) {
  const lineup = evidence.teams[side].lineup, source = lineup?.source, league = soccerLeague(game.league);
  if (!lineup || !Array.isArray(lineup.starters) || !Array.isArray(lineup.bench)) return { status: 'NOT_AVAILABLE', reason: 'CURRENT_ROSTER_NOT_PROVIDED', players: [] };
  const players = [...lineup.starters, ...lineup.bench], seen = new Set();
  if (players.length > 40 || players.some(player => !id(player?.id) || seen.has(player.id) || (seen.add(player.id), false)))
    return { status: 'INVALID', reason: 'CURRENT_ROSTER_PLAYER_IDENTITY_CONFLICT', players: [] };
  if (!source || source.provider !== 'ESPN' || source.url !== `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`
    || !sha(source.contentHash) || !Number.isFinite(instant(source.fetchedAt)) || instant(source.fetchedAt) > now
    || now - instant(source.fetchedAt) > 180000 || source.contentHash !== evidence.source.contentHash
    || source.scope && (source.scope.gameId !== game.id || source.scope.league !== game.league || source.scope.field !== `teams.${side}.lineup`))
    return { status: 'INVALID', reason: 'CURRENT_ROSTER_SOURCE_OR_TIME_UNVERIFIED', players: [] };
  const announced = lineup.status === 'PROVIDER_REPORTED_XI' && lineup.starters.length === 11
    && lineup.starters.every(player => player.starter === true) && lineup.bench.every(player => player.starter === false);
  if (lineup.status === 'PROVIDER_REPORTED_XI' && !announced) return { status: 'INVALID', reason: 'CURRENT_STARTING_XI_INCONSISTENT', players: [] };
  if (!['PROVIDER_REPORTED_XI', 'NOT_PUBLISHED'].includes(lineup.status))
    return { status: 'NOT_AVAILABLE', reason: lineup.reason || 'CURRENT_ROSTER_NOT_CONFIRMED', players: [] };
  return { status: announced ? 'ANNOUNCED_XI' : players.length ? 'UNANNOUNCED_ROSTER' : 'NOT_AVAILABLE',
    reason: announced ? null : 'CURRENT_XI_NOT_ANNOUNCED', players, source: clone(source), announced };
}
const forecastValid = player => id(player?.id) && ['startProbability', 'substituteProbability', 'noAppearanceProbability', 'appearanceProbability']
  .every(field => finite(player[field]) && player[field] >= 0 && player[field] <= 1)
  && Math.abs(player.startProbability + player.substituteProbability + player.noAppearanceProbability - 1) < 1e-10
  && finite(player.expectedMinutes) && player.expectedMinutes >= 0 && player.expectedMinutes <= 90;
function validationFor(artifacts, league) {
  const value = artifacts?.leagues?.[league]?.validation;
  return { status: 'NOT_ACCEPTED', testUntouchedVerified: value?.testUntouchedVerified === true,
    interpretation: value?.holdoutInterpretation ?? null, sourceAvailability: value?.sourceAvailability ?? null,
    trainingGames: value?.trainingGames ?? null, developmentGames: value?.developmentGames ?? null,
    diagnosticModelHash: value?.diagnosticModelHash ?? null, holdout: clone(value?.holdout ?? null), ...restrictions };
}
function availabilityFor(team) {
  return Object.fromEntries(['injuries', 'suspensions'].map(field => {
    const observation = team?.[field], values = Array.isArray(observation?.value) ? observation.value : [];
    return [field, { status: observation?.status ?? 'UNKNOWN', reason: observation?.reason ?? null,
      reportedPlayerIds: values.filter(player => id(player?.id)).map(player => player.id),
      source: clone(observation?.source ?? null), coverage: observation?.coverage ?? 'NOT_VERIFIED',
      completenessVerified: false, modelEffectApplied: false }];
  }));
}
function unavailableMinutes(reason, sourceProjection) {
  return { status: 'UNAVAILABLE', reason, players: [], expectedTeamMinutes: null, unboundPriorCandidates: [],
    coverage: { complete: false, eligibleRosterVerified: false, announcedXI: false, currentRosterPlayers: null,
      playersWithForecast: 0, playersWithoutForecast: null }, sourceProjection, ...restrictions };
}

/** Bind the existing frozen prior-participation forecast to the observed
 * current roster. Observed XI membership and model probabilities stay distinct:
 * this does not condition/refit the model after observing a current XI. */
export function buildSoccerPersonnelInputs({ evidence, game = evidence?.game, now = Date.now(), artifacts = soccerExpectedMinutesArtifacts() } = {}) {
  const projection = rawMinutes(evidence), base = { version: SOCCER_PERSONNEL_INPUTS_VERSION, gameId: game?.id ?? null,
    league: game?.league ?? null, generatedAt: finite(now) ? new Date(now).toISOString() : null,
    sourceProjection: projection, ...restrictions };
  const failure = reason => seal({ ...base, status: 'UNAVAILABLE', reason, model: null,
    validation: validationFor(artifacts, game?.league), teams: Object.fromEntries(['home', 'away'].map(side => [side,
      { sourceId: game?.[side]?.sourceId ?? null, minutes: unavailableMinutes(reason, projection.minutes[side]) }])) });
  if (!scopeValid(evidence, game, now)) return failure('PERSONNEL_CURRENT_GAME_OR_SOURCE_UNVERIFIED');
  const model = artifacts?.leagues?.[game.league]?.model, { contentHash, ...body } = artifacts || {};
  if (artifacts?.version !== SOCCER_EXPECTED_MINUTES_VERSION || !sha(contentHash) || soccerExpectedMinutesHash(body) !== contentHash
    || model?.version !== SOCCER_EXPECTED_MINUTES_VERSION || model.league !== game.league || !sha(model.trainingRowsHash)
    || !Number.isFinite(instant(artifacts.createdAt)) || instant(artifacts.createdAt) > now
    || !Number.isFinite(instant(model.trainingBefore)) || instant(model.trainingBefore) >= instant(artifacts.createdAt))
    return failure('PERSONNEL_MINUTES_MODEL_SCOPE_OR_AVAILABILITY_INVALID');
  const rosters = Object.fromEntries(['home', 'away'].map(side => [side, rosterFor(evidence, side, game, now)]));
  if (Object.values(rosters).some(roster => roster.status === 'INVALID'))
    return failure(Object.values(rosters).find(roster => roster.status === 'INVALID').reason);
  const ids = new Set();
  for (const roster of Object.values(rosters)) for (const player of roster.players) {
    if (ids.has(player.id)) return failure('PERSONNEL_CROSS_TEAM_PLAYER_IDENTITY_CONFLICT'); ids.add(player.id);
  }
  const research = buildSoccerExpectedMinutesResearch({ evidence, game, now, artifacts });
  const modelBinding = { version: model.version, artifactHash: contentHash, modelHash: hash(model),
    trainingHash: model.trainingRowsHash, trainingHashMeaning: 'CANONICAL_TRAINING_ROWS_SHA256',
    createdAt: artifacts.createdAt, trainingBefore: model.trainingBefore, trainingGames: model.trainingGames,
    trainingPlayerTargets: model.trainingRows, candidateSelection: artifacts.protocol.candidateSelection,
    clockBasis: 'PROVIDER_REGULATION_MINUTES_EXCLUDES_ADDED_TIME', accepted: false };
  const teams = Object.fromEntries(['home', 'away'].map(side => {
    const team = evidence.teams[side], roster = rosters[side], forecast = research.teams?.[side], availability = availabilityFor(team);
    if (forecast?.status !== 'RESEARCH_FORECAST_AVAILABLE' || !Array.isArray(forecast.players) || !forecast.players.every(forecastValid))
      return [side, { sourceId: game[side].sourceId, availability, minutes: { ...unavailableMinutes(forecast?.reason || 'PRIOR_MINUTES_FORECAST_UNAVAILABLE', projection.minutes[side]),
        rosterStatus: roster.status, model: modelBinding, validation: validationFor(artifacts, game.league) } }];
    const predictions = new Map(forecast.players.map(player => [player.id, player])), currentIds = new Set(roster.players.map(player => player.id));
    const selected = roster.players.length ? roster.players : forecast.players;
    const history = evidence.workload.teams[side].playerWorkload.matches;
    const players = selected.map(observed => {
      const estimate = predictions.get(observed.id), matchIds = estimate?.sourceMatchIds || [];
      const historySources = history.filter(match => matchIds.includes(match.eventId)).map(match => clone(match.source));
      return { id: observed.id, name: observed.name || observed.id, position: observed.position || null,
        observedStarter: roster.announced ? observed.starter === true : null,
        rosterRole: roster.announced ? observed.starter ? 'ANNOUNCED_STARTER' : 'ANNOUNCED_BENCH' : 'UNCONFIRMED_CANDIDATE',
        forecastStatus: estimate ? 'PRIOR_PARTICIPATION_FORECAST' : 'MISSING_PRIOR_CANDIDATE',
        missingReason: estimate ? null : 'CURRENT_PLAYER_NOT_IN_VERIFIED_PRIOR_SQUADS',
        expectedMinutes: estimate?.expectedMinutes ?? null, startProbability: estimate?.startProbability ?? null,
        substituteProbability: estimate?.substituteProbability ?? null, noAppearanceProbability: estimate?.noAppearanceProbability ?? null,
        appearanceProbability: estimate?.appearanceProbability ?? null, conditionalStarterMinutes: estimate?.conditionalStarterMinutes ?? null,
        conditionalSubstituteMinutes: estimate?.conditionalSubstituteMinutes ?? null, cellTrainingRows: estimate?.cellTrainingRows ?? null,
        priorMatchCount: estimate?.priorMatchCount ?? null, sourceMatchIds: [...matchIds], historySources,
        reportedInjury: availability.injuries.reportedPlayerIds.includes(observed.id),
        reportedSuspension: availability.suspensions.reportedPlayerIds.includes(observed.id),
        currentRosterSource: roster.players.length ? roster.source ?? null : null,
        replacementId: null, replacementCandidates: [], ...restrictions };
    });
    for (const player of players) if (player.observedStarter && player.position) player.replacementCandidates = players
      .filter(candidate => candidate.observedStarter === false && candidate.position === player.position)
      .map(candidate => ({ id: candidate.id, name: candidate.name, position: candidate.position,
        expectedMinutes: candidate.expectedMinutes, reportedInjury: candidate.reportedInjury, reportedSuspension: candidate.reportedSuspension }));
    const matched = players.filter(player => player.forecastStatus === 'PRIOR_PARTICIPATION_FORECAST');
    const sourceHashes = [...new Set([contentHash, evidence.source.contentHash, ...matched.flatMap(player => player.historySources.map(source => source.contentHash))])];
    const missingReasons = ['FORMAL_MINUTES_MODEL_NOT_ACCEPTED', ...(!roster.announced ? ['CURRENT_XI_NOT_ANNOUNCED'] : []),
      ...(matched.length !== players.length ? ['CURRENT_ROSTER_HAS_UNMODELED_PLAYERS'] : []),
      ...(availability.injuries.status !== 'VERIFIED' ? ['INJURY_COVERAGE_NOT_VERIFIED'] : []),
      ...(availability.suspensions.status !== 'VERIFIED' ? ['COMPETITION_ELIGIBILITY_NOT_VERIFIED'] : [])];
    const minutes = { status: 'RESEARCH_FORECAST_AVAILABLE', reason: 'FORMAL_MINUTES_MODEL_NOT_ACCEPTED', players,
      expectedTeamMinutes: matched.reduce((sum, player) => sum + player.expectedMinutes, 0),
      expectedTeamMinutesScope: roster.players.length ? 'SUM_OF_MODELED_CURRENT_SOURCE_ROSTER_ONLY' : 'PRIOR_CANDIDATE_SET_ONLY',
      forecastProbabilityBasis: 'UNCHANGED_PRIOR_PARTICIPATION_MODEL_NOT_CONDITIONED_ON_CURRENT_XI',
      replacementCandidateMeaning: 'SAME_PROVIDER_REPORTED_POSITION_ONLY_NOT_A_SUBSTITUTION_PROBABILITY',
      unboundPriorCandidates: forecast.players.filter(player => roster.players.length && !currentIds.has(player.id)).map(player => ({ ...clone(player), reason: 'CURRENT_ROSTER_MEMBERSHIP_UNVERIFIED' })),
      coverage: { ...clone(forecast.coverage), complete: false, eligibleRosterVerified: false, announcedXI: roster.announced === true,
        currentRosterPlayers: roster.players.length || null, playersWithForecast: matched.length,
        playersWithoutForecast: roster.players.length ? players.length - matched.length : null },
      rosterStatus: roster.status, model: modelBinding, validation: validationFor(artifacts, game.league),
      sourceHashes, availability, missingReasons, sourceProjection: projection.minutes[side], ...restrictions };
    return [side, { sourceId: game[side].sourceId, availability, minutes }];
  }));
  return seal({ ...base, status: Object.values(teams).some(team => team.minutes.status === 'RESEARCH_FORECAST_AVAILABLE') ? 'PERSONNEL_RESEARCH_INPUTS_CONNECTED' : 'UNAVAILABLE',
    model: modelBinding, validation: validationFor(artifacts, game.league), teams, research,
    interpretation: 'OBSERVED_CURRENT_ROSTER_BOUND_TO_FROZEN_PRIOR_PARTICIPATION_FORECAST_WITHOUT_FORMAL_RATE_EFFECT' });
}

export function attachSoccerPersonnelInputs(evidence, options = {}) {
  const previous = proofs.get(evidence), previousValid = previous && soccerPersonnelInputSourceProjection(evidence);
  if (previous && !previousValid || !previous && Object.hasOwn(evidence, 'personnelInputs'))
    throw Error('PERSONNEL_INPUT_ATTACHMENT_PROOF_CHANGED');
  const basis = previousValid ? { ...evidence, teams: Object.fromEntries(['home', 'away'].map(side => [side,
    { ...evidence.teams[side], minutes: previous.projection.minutes[side] }])) } : evidence;
  const cutoff = options.now ?? Date.now();
  const inputs = buildSoccerPersonnelInputs({ ...options, now: cutoff, evidence: basis });
  const fingerprint = inputFingerprint(evidence), projection = clone(inputs.sourceProjection);
  evidence.personnelInputs = inputs;
  for (const side of ['home', 'away']) if (evidence.teams?.[side]
    && inputs.teams[side].minutes.status === 'RESEARCH_FORECAST_AVAILABLE') evidence.teams[side].minutes = inputs.teams[side].minutes;
  const minuteRefs = Object.fromEntries(['home', 'away'].map(side => [side, evidence.teams?.[side]?.minutes]));
  proofs.set(evidence, { inputs, hash: hash(inputsView(inputs)), fingerprint, projection, cutoff, minuteRefs,
    minuteHashes: Object.fromEntries(['home', 'away'].map(side => [side, hash(minuteRefs[side] ?? null)])) });
  return inputs;
}

/** Projection capability for the original summary archive. Cached/HTTP flags
 * and cloned observations never obtain this process-local proof. */
export function soccerPersonnelInputSourceProjection(evidence) {
  try {
    const proof = proofs.get(evidence);
    if (!proof || evidence.personnelInputs !== proof.inputs || hash(inputsView(proof.inputs)) !== proof.hash
      || inputFingerprint(evidence) !== proof.fingerprint
      || ['home', 'away'].some(side => evidence.teams?.[side]?.minutes !== proof.minuteRefs[side]
        || proof.inputs.teams[side].minutes.status !== 'RESEARCH_FORECAST_AVAILABLE'
          && hash(evidence.teams?.[side]?.minutes ?? null) !== proof.minuteHashes[side])) return null;
    return clone(proof.projection);
  } catch { return null; }
}

export function getSoccerPersonnelInputArchiveProof(evidence, { field } = {}) {
  const side = /^teams\.(home|away)\.minutes$/.exec(field || '')?.[1], proof = proofs.get(evidence);
  if (!side || !proof || !soccerPersonnelInputSourceProjection(evidence)
    || proof.inputs.teams[side].minutes.status !== 'RESEARCH_FORECAST_AVAILABLE'
    || proof.inputs.model?.artifactHash !== soccerExpectedMinutesArtifacts().contentHash) return null;
  const workloadProofs = Object.fromEntries(['home', 'away'].map(key => [key,
    soccerPlayerWorkloadArchiveProof(evidence.workload?.teams?.[key]?.playerWorkload)]));
  // A rendered model forecast is not enough to reconstruct original history.
  if (!workloadProofs[side] || !sha(evidence.sourceDocumentArchive?.receiptId)) return null;
  return { version: SOCCER_PERSONNEL_INPUTS_VERSION, kind: 'PERSONNEL_RESEARCH', field,
    binding: { league: evidence.game.league, gameId: evidence.game.id, date: evidence.game.date,
      startTime: evidence.game.startTime, phase: evidence.phase, field },
    documents: Object.values(workloadProofs).flatMap(value => value?.documents || []),
    reconstructionInputs: { sourceDocumentReceiptId: evidence.sourceDocumentArchive.receiptId,
      rawSource: clone(evidence.rawSource), cutoff: proof.cutoff, workload: clone(evidence.workload), workloadProofs, sourceProjection: clone(proof.projection) },
    observation: clone(minutesView(proof.inputs.teams[side].minutes)), inputsHash: proof.inputs.contentHash,
    interpretation: 'DERIVED_RESEARCH_FORECAST_FROM_ARCHIVED_NORMALIZED_SUMMARY_AND_RAW_PRIOR_MATCHES', ...restrictions };
}

/** The archive store loads/authenticates the original current summary before
 * calling this function. Each historical workload is replayed from raw JSON. */
export function restoreSoccerPersonnelInputObservation(evidence, proof) {
  if (proof?.version !== SOCCER_PERSONNEL_INPUTS_VERSION || proof.kind !== 'PERSONNEL_RESEARCH'
    || !/^teams\.(home|away)\.minutes$/.test(proof.field || '')
    || proof.binding?.gameId !== evidence?.game?.id || proof.binding?.league !== evidence.game.league
    || proof.binding?.date !== evidence.game.date || proof.binding?.startTime !== evidence.game.startTime
    || proof.binding?.phase !== evidence.phase || proof.binding?.field !== proof.field) throw Error('PERSONNEL_INPUT_ARCHIVE_SCOPE_INVALID');
  const data = proof.reconstructionInputs, workload = clone(data?.workload);
  if (!workload || !finite(data?.cutoff) || data.sourceDocumentReceiptId !== evidence.sourceDocumentArchive?.receiptId)
    throw Error('PERSONNEL_INPUT_ARCHIVE_RECONSTRUCTION_INVALID');
  for (const side of ['home', 'away']) {
    if (!data.workloadProofs?.[side]) {
      if (side === proof.field.split('.')[1]) throw Error('PERSONNEL_INPUT_ARCHIVE_WORKLOAD_MISMATCH');
      continue;
    }
    const reconstructed = restoreSoccerPlayerWorkloadObservation(data.workloadProofs?.[side]);
    if (hash(reconstructed) !== hash(workload.teams?.[side]?.playerWorkload)) throw Error('PERSONNEL_INPUT_ARCHIVE_WORKLOAD_MISMATCH');
    workload.teams[side].playerWorkload = reconstructed;
  }
  const basis = { ...evidence, workload, teams: Object.fromEntries(['home', 'away'].map(side => [side,
    { ...evidence.teams[side], minutes: clone(data.sourceProjection?.minutes?.[side]) }])) };
  const rebuilt = buildSoccerPersonnelInputs({ evidence: basis, now: data.cutoff });
  const side = proof.field.split('.')[1], observation = rebuilt.teams[side].minutes;
  if (rebuilt.contentHash !== proof.inputsHash || hash(observation) !== hash(proof.observation)) throw Error('PERSONNEL_INPUT_ARCHIVE_REPLAY_MISMATCH');
  return observation;
}
