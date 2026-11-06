// Client-safe inventory of existing normalized provider observations. This
// validates their saved scope and time metadata; it does not accept a model,
// establish historical publication, or independently verify the provider.
const slugs = { epl: 'eng.1', ucl: 'uefa.champions' };
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const id = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[<>\u0000-\u001f]/.test(value);
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

export function soccerMatchContextObservations(evidence, game = evidence?.game) {
  const empty = { venue: null, uclPhase: null, poststart: false };
  if (evidence?.ok !== true || !game || !Object.hasOwn(slugs, game.league) || !id(game.sourceId)
    || game.id !== `soccer:${game.league}:${game.sourceId}` || evidence.league !== game.league
    || evidence.game?.id !== game.id || evidence.game?.startTime !== game.startTime
    || evidence.game?.date !== game.date || !Number.isFinite(instant(game.startTime))
    || !['home', 'away'].every(side => id(game[side]?.sourceId) && evidence.game?.[side]?.sourceId === game[side].sourceId)
    || game.home.sourceId === game.away.sourceId || !['PREMATCH_OBSERVATION', 'POSTSTART_AUDIT'].includes(evidence.phase)) return empty;
  const source = evidence.source, observed = instant(evidence.observedAt), fetched = instant(source?.fetchedAt);
  const expectedUrl = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slugs[game.league]}/summary?event=${game.sourceId}`;
  const flags = (proof, field) => proof?.version === 'SOCCER-FIELD-SOURCE-TIMES-v1' && proof.field === field
    && proof.sourceScopeVerified === true && proof.contentHashVerified === true && proof.fetchTimeVerified === true
    && proof.observedAvailabilityVerified === true && proof.independentlyConfirmed === false
    && proof.historicalAvailabilityVerified === false;
  if (source?.provider !== 'ESPN' || source.url !== expectedUrl || !sha(source.contentHash)
    || source.scope?.league !== game.league || source.scope?.gameId !== game.id || source.scope?.field !== 'document'
    || !Number.isFinite(observed) || !Number.isFinite(fetched) || fetched !== observed
    || !flags(evidence.sourceEvidence, 'document')) return empty;
  const poststart = evidence.phase === 'POSTSTART_AUDIT';
  if (!poststart && (game.status !== 'scheduled' || observed >= instant(game.startTime))) return empty;
  const bound = (observation, field) => {
    const s = observation?.source, p = observation?.sourceEvidence, available = instant(s?.availableAt);
    return observation?.status === (poststart ? 'POSTSTART_OBSERVATION' : 'PROVIDER_REPORTED')
      && observation.independentlyConfirmed === false && observation.formalEligible === false && observation.modelEffectApplied === false
      && s?.provider === source.provider && s.url === source.url && s.contentHash === source.contentHash && s.fetchedAt === source.fetchedAt
      && s.scope?.league === game.league && s.scope?.gameId === game.id && s.scope?.field === field
      && flags(p, field) && Number.isFinite(available) && available >= fetched && available <= observed
      && p.observedAvailableAt === s.availableAt;
  };
  const venue = evidence.venueObservation?.value;
  const validVenue = bound(evidence.venueObservation, 'venueObservation') && id(venue?.id) && text(venue?.name)
    && ['city', 'country'].every(field => venue[field] === null || text(venue[field]))
    && (venue.guid === null || typeof venue.guid === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(venue.guid));
  const phase = evidence.uclPhaseObservation?.value, kickoff = instant(game.startTime);
  const validPhase = game.league === 'ucl' && bound(evidence.uclPhaseObservation, 'uclPhaseObservation')
    && phase?.phase === 'LEAGUE_PHASE' && phase.providerSeasonYear === 2026 && phase.providerSeasonType === 14534
    && phase.providerSeasonName === '2026-27 UEFA Champions League, League Phase'
    && kickoff >= Date.parse('2026-07-01T00:00:00Z') && kickoff < Date.parse('2027-07-01T00:00:00Z');
  return { venue: validVenue ? venue : null, uclPhase: validPhase ? phase : null, poststart };
}
