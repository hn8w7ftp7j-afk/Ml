import { createHash } from 'node:crypto';
import { soccerLeague } from './contracts.js';
import { fetchSoccerJson, normalizeSoccerSchedule } from './data.js';
import { normalizeSoccerTeamWorkload, soccerWorkloadSourceDocuments } from './workload.js';
import { retainSoccerProviderDocument, soccerProviderDocumentHashValid } from './provider-document.js';
import { soccerObservationSources } from './source-evidence.js';
import { soccerSourceDocumentProof } from './source-document-store.js';
import { fetchSoccerVenueGeography, normalizeSoccerVenueGeography, soccerVenueGeographyDocumentProof } from './venue-geography.js';
import { soccerWeatherDocumentValid } from './weather-source.js';

export const SOCCER_MATCH_CONDITIONS_EVIDENCE_VERSION = 'SOCCER-SOURCE-BOUND-MATCH-CONDITIONS-v1';
const proofs = new WeakMap();
const restrictions = { modelEffectApplied: false, formalEligible: false, executable: false,
  independentlyConfirmed: false, historicalAvailabilityVerified: false };
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) ? Date.parse(value) : NaN;
const id = value => /^\d{1,16}$/.test(String(value ?? '')) ? String(value) : null;
const clean = value => typeof value === 'string' && value.length && value.length <= 160 && !/[<>\u0000-\u001f]/.test(value) ? value : null;
const hash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');
const observationView = value => Object.fromEntries(Object.entries(value)
  .filter(([key]) => !['sourceDocumentArchive', 'observationArchive', 'archiveReceipt'].includes(key)));
const missing = (reason, extra = {}) => ({ status: 'UNKNOWN', value: null, reason, source: null, sources: [], ...restrictions, ...extra });
const scopeOf = game => ({ league: game.league, gameId: game.id, date: game.date, startTime: game.startTime,
  home: { sourceId: game.home.sourceId }, away: { sourceId: game.away.sourceId } });
const validGame = game => Boolean(soccerLeague(game?.league) && id(game.sourceId) && game.id === `soccer:${game.league}:${game.sourceId}`
  && Number.isFinite(instant(game.startTime)) && id(game.home?.sourceId) && id(game.away?.sourceId)
  && game.home.sourceId !== game.away.sourceId);

function validDocument(document, now) {
  const source = document?.source, at = instant(source?.fetchedAt), available = source?.availableAt == null ? at : instant(source.availableAt);
  const requested = source?.requestedAt == null ? at : instant(source.requestedAt);
  return document?.ok === true && source?.provider === 'ESPN' && soccerProviderDocumentHashValid(document)
    && [at, available, requested].every(Number.isFinite) && requested <= at && at <= available && available <= now;
}
function urlFor(document) {
  try { const url = new URL(document.source.url); return url.protocol === 'https:' && url.hostname === 'site.api.espn.com'
    && !url.username && !url.password && !url.port && !url.hash ? url : null; } catch { return null; }
}
function sourceList(documents) {
  return [...new Map(documents.map(document => [hash([document.source.url, document.source.contentHash, document.source.fetchedAt]), { ...document.source }])).values()];
}
function validSummary(game, document, now) {
  const url = document && validDocument(document, now) && urlFor(document), league = soccerLeague(game.league);
  if (!url || url.pathname !== `/apis/site/v2/sports/soccer/${league.espnSlug}/summary`
    || [...url.searchParams.keys()].some(key => key !== 'event') || url.searchParams.getAll('event').length !== 1
    || url.searchParams.get('event') !== game.sourceId || String(document.data?.header?.id) !== game.sourceId
    || document.data.header.competitions?.length !== 1) return null;
  const header = document.data.header, competition = header.competitions[0];
  const board = normalizeSoccerSchedule({ leagues: [header.league], events: [{ ...header, date: competition.date, status: competition.status }] }, game.league, document.source);
  const observed = board.ok && board.games.find(value => value.id === game.id);
  if (!observed || observed.startTime !== new Date(game.startTime).toISOString() || observed.date !== game.date
    || ['home', 'away'].some(side => observed[side].sourceId !== game[side].sourceId)
    || observed.neutralSite !== game.neutralSite || observed.status !== game.status) return null;
  return { header, competition, observed };
}

// Coordinates are accepted only when explicitly present on the provider's
// exact venue. A city name, club name or home/away flag is never a coordinate.
function venueFact(node) {
  if (!node || !clean(node.fullName) || node.id != null && !id(node.id)) return null;
  const candidates = [node, node.location].filter(value => value && (Object.hasOwn(value, 'latitude') || Object.hasOwn(value, 'longitude')));
  const points = candidates.map(value => ({ latitude: value.latitude, longitude: value.longitude }));
  const valid = points.length && points.every(point => typeof point.latitude === 'number' && Number.isFinite(point.latitude)
    && Math.abs(point.latitude) <= 90 && typeof point.longitude === 'number' && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180)
    && points.every(point => point.latitude === points[0].latitude && point.longitude === points[0].longitude);
  return { venueId: node.id == null ? null : String(node.id), name: node.fullName, city: clean(node.address?.city), country: clean(node.address?.country),
    coordinates: valid ? points[0] : null, coordinateStatus: valid ? 'PROVIDER_REPORTED' : candidates.length ? 'CONFLICTING_OR_INVALID' : 'NOT_PROVIDED' };
}
function summaryVenue(document, competition) {
  const direct = venueFact(document.data.gameInfo?.venue), other = venueFact(competition.venue);
  if (direct && other && (direct.venueId !== other.venueId || direct.name !== other.name
    || ['city', 'country'].some(key => direct[key] && other[key] && direct[key] !== other[key])
    || direct.coordinates && other.coordinates && hash(direct.coordinates) !== hash(other.coordinates))) return null;
  return direct || other;
}
export function soccerVenueGreatCircleKilometres(left, right) {
  const valid = point => point && typeof point.latitude === 'number' && Number.isFinite(point.latitude) && Math.abs(point.latitude) <= 90
    && typeof point.longitude === 'number' && Number.isFinite(point.longitude) && Math.abs(point.longitude) <= 180;
  if (!valid(left) || !valid(right)) return null;
  const radians = degrees => degrees * Math.PI / 180, p1 = radians(left.latitude), p2 = radians(right.latitude);
  const d1 = p2 - p1, d2 = radians(right.longitude - left.longitude);
  const a = Math.sin(d1 / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(d2 / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(Math.max(0, Math.min(1, a))), Math.sqrt(Math.max(0, 1 - a)));
}

function scheduleInputs(game, documents, now) {
  const inputs = { home: [], away: [] }, venues = { home: new Map(), away: new Map() }, excluded = [], acceptedDocuments = [];
  for (const document of documents) {
    const url = validDocument(document, now) && urlFor(document), match = url?.pathname.match(/^\/apis\/site\/v2\/sports\/soccer\/all\/teams\/(\d{1,16})\/schedule$/);
    const side = match && ['home', 'away'].find(value => game[value].sourceId === match[1]);
    if (!side || [...url.searchParams.keys()].some(key => !['season', 'fixture'].includes(key))
      || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)
      || url.searchParams.has('fixture') && (url.searchParams.get('fixture') !== 'true' || url.searchParams.has('season'))
      || !url.searchParams.has('fixture') && !/^20\d{2}$/.test(url.searchParams.get('season') || '')) { excluded.push('SCHEDULE_DOCUMENT_SCOPE_OR_PROOF_INVALID'); continue; }
    const observation = { data: document.data, source: document.source,
      kind: url.searchParams.has('fixture') ? 'fixtures' : 'results', season: url.searchParams.has('season') ? Number(url.searchParams.get('season')) : null };
    const checked = normalizeSoccerTeamWorkload([observation], game[side], game, now);
    if (!checked.ok) { excluded.push(checked.code); continue; }
    inputs[side].push(observation);
    acceptedDocuments.push(document);
    for (const event of document.data.events) {
      const fact = venueFact(event.competitions[0].venue), eventId = String(event.id);
      if (!fact) continue;
      const old = venues[side].get(eventId);
      if (old && hash(old) !== hash(fact)) venues[side].set(eventId, { conflict: true });
      else venues[side].set(eventId, fact);
    }
  }
  return { inputs, venues, excluded, acceptedDocuments };
}
const venueScope = (venue, game, eventId) => venue && !venue.venueId
  ? { ...venue, scopeKey: `soccer:${game.league}:event:${eventId}:venue` } : venue;
const geographyVenue = venue => ({ venueId: venue.venueId, ...(venue.scopeKey ? { scopeKey: venue.scopeKey } : {}),
  name: venue.name, city: venue.city, country: venue.country });
function withVenueGeography(venue, role, geographyInputs, now, usedDocuments) {
  if (!venue || venue.coordinates) return venue;
  const candidates = geographyInputs.filter(input => input?.role === role);
  if (candidates.length !== 1 || hash(candidates[0].venue) !== hash(geographyVenue(venue))) return venue;
  let geo;
  try { geo = normalizeSoccerVenueGeography({ venue: candidates[0].venue, documents: candidates[0].documents, now }); }
  catch { return venue; }
  if (!geo.ok) return venue;
  usedDocuments.push(...candidates[0].documents);
  return { ...venue, coordinates: { latitude: geo.value.latitude, longitude: geo.value.longitude },
    coordinateStatus: 'PROVIDER_REPORTED', coordinateSource: geo.source, coordinateProviderEntityId: geo.value.entityId ?? geo.value.providerEntityId ?? null };
}
function travelObservation(game, summaryDocument, summary, documents, geographyInputs, now) {
  const parsed = scheduleInputs(game, documents, now), usedGeographyDocuments = [];
  const targetVenue = withVenueGeography(venueScope(summary ? summaryVenue(summaryDocument, summary.competition) : null, game, game.sourceId),
    'target', geographyInputs, now, usedGeographyDocuments);
  const teams = Object.fromEntries(['home', 'away'].map(side => {
    const observed = parsed.inputs[side].length ? normalizeSoccerTeamWorkload(parsed.inputs[side], game[side], game, now) : null;
    if (!observed?.ok) return [side, { sourceId: game[side].sourceId, status: 'UNKNOWN', reason: observed?.code || 'MATCH_CONDITIONS_TEAM_SCHEDULE_UNAVAILABLE',
      actualRestHours: null, venueDistanceKm: null }];
    const last = observed.lastKnownCompleted, priorVenue = last && parsed.venues[side].get(last.eventId);
    const usableVenue = withVenueGeography(venueScope(priorVenue && !priorVenue.conflict ? priorVenue : null, game, last?.eventId),
      `${side}Previous`, geographyInputs, now, usedGeographyDocuments);
    return [side, { sourceId: game[side].sourceId, status: 'PROVIDER_REPORTED_PARTIAL',
      lastKnownCompleted: last, kickoffGapHoursFromLastCompleted: observed.kickoffGapHoursFromLastCompleted,
      elapsedHoursSinceLastCompletedKickoff: observed.elapsedHoursSinceLastCompletedKickoff,
      observedCompletedMatchesLast7Days: observed.completedMatchesLast7Days,
      observedCompletedMatchesLast14Days: observed.completedMatchesLast14Days,
      scheduledBeforeTarget: observed.scheduledBeforeTarget,
      distinctObservedCompetitions: observed.coverage.distinctCompetitions,
      previousVenue: usableVenue, actualRestHours: null, actualTravelDistanceKm: null,
      venueDistanceKm: soccerVenueGreatCircleKilometres(usableVenue?.coordinates, targetVenue?.coordinates),
      venueDistanceReason: usableVenue?.coordinates && targetVenue?.coordinates ? null : priorVenue?.conflict
        ? 'PREVIOUS_VENUE_IDENTITY_OR_COORDINATES_CONFLICT' : 'PREVIOUS_OR_TARGET_VENUE_COORDINATES_UNAVAILABLE',
      coverage: observed.coverage }];
  }));
  if (['home', 'away'].every(side => teams[side].status === 'UNKNOWN')) return missing('MATCH_CONDITIONS_TEAM_SCHEDULE_UNAVAILABLE', { target: scopeOf(game), excludedReasons: parsed.excluded });
  const sources = sourceList([...parsed.acceptedDocuments, ...usedGeographyDocuments]);
  const rawSource = summaryDocument?.source || sources.at(-1) || null;
  const source = rawSource ? { ...rawSource, availableAt: new Date(now).toISOString(), sourcePublishedAt: null, sourceUpdatedAt: null,
    scope: { league: game.league, gameId: game.id, field: 'travel' }, availabilityBasis: 'DERIVED_FROM_RETAINED_PROVIDER_DOCUMENTS' } : null;
  return { status: 'PROVIDER_REPORTED_PARTIAL', reason: 'OBSERVED_SCHEDULES_NOT_COMPLETE_PHYSICAL_WORKLOAD',
    target: scopeOf(game), value: { targetVenue, teams }, source, sources,
    sourceScope: source === null ? null : summaryDocument?.source ? 'TARGET_EVENT_DOCUMENT_ONLY_OTHER_INPUTS_IN_SOURCES' : 'OBSERVED_TEAM_SCHEDULE_DOCUMENT',
    sourcePublishedAt: source?.sourcePublishedAt ?? null, observedAt: new Date(now).toISOString(),
    coverage: { allCompetitionsRequested: true, complete: false, independentlyVerified: false,
      sourceDocuments: parsed.inputs.home.length + parsed.inputs.away.length, internationalDutyCoverageVerified: false,
      actualTravelItineraryVerified: false, actualMatchEndTimesVerified: false },
    excludedReasons: parsed.excluded, ...restrictions,
    limitations: ['KICKOFF_GAPS_ARE_NOT_ACTUAL_RECOVERY_HOURS', 'FUTURE_FIXTURES_ARE_PUBLISHED_PLANS_NOT_COMPLETED_WORKLOAD',
      'VENUE_GREAT_CIRCLE_DISTANCE_IS_AN_ESTIMATE_NOT_AN_OBSERVED_ITINERARY', 'ALL_COMPETITION_AND_INTERNATIONAL_DUTY_COVERAGE_REMAINS_UNVERIFIED'] };
}

function uclObservation(game, document, summary, now) {
  if (game.league !== 'ucl') return { status: 'NOT_APPLICABLE', value: null, reason: 'NOT_UCL', sources: [], ...restrictions };
  if (!summary) return missing('UCL_CONTEXT_SOURCE_SCOPE_OR_PROOF_UNAVAILABLE');
  const season = summary.header.season, name = typeof season?.name === 'string' ? season.name : '';
  const match = /^(20\d{2})-(\d{2}) UEFA Champions League, (League Phase|Knockout Round Play-offs|Knockout Phase Play-offs|Round of 16|Quarterfinals|Quarter-finals|Semifinals|Semi-finals|Final)$/.exec(name);
  const year = match && Number(match[1]), kickoff = instant(game.startTime);
  if (!match || season.year !== year || Number(match[2]) !== (year + 1) % 100 || !Number.isSafeInteger(season.type) || season.type <= 0
    || kickoff < Date.parse(`${year}-07-01T00:00:00Z`) || kickoff >= Date.parse(`${year + 1}-07-01T00:00:00Z`))
    return missing('UCL_PHASE_NOT_EXPLICITLY_IDENTIFIED', { target: scopeOf(game) });
  const phase = match[3] === 'League Phase' ? 'LEAGUE_PHASE' : match[3] === 'Final' && summary.competition.isFinal === true ? 'FINAL' : 'KNOCKOUT';
  if (match[3] === 'Final' && phase !== 'FINAL' || phase === 'LEAGUE_PHASE' && summary.competition.isFinal === true)
    return missing('UCL_PHASE_CONFLICT', { target: scopeOf(game) });
  const bound = soccerObservationSources({ node: document.data, payload: document.data, game: summary.observed, source: document.source, now }).forField(season, 'uclContext');
  const notAggregate = phase === 'LEAGUE_PHASE' || phase === 'FINAL';
  return { status: 'PROVIDER_REPORTED_PARTIAL', target: scopeOf(game),
    value: { phase, stageLabel: match[3], providerSeasonYear: season.year, providerSeasonType: season.type, providerSeasonName: name,
      tieFormat: phase === 'LEAGUE_PHASE' ? 'LEAGUE_FIXTURE' : phase === 'FINAL' ? 'SINGLE_MATCH_FINAL' : 'NOT_CONFIRMED_FOR_THIS_TIE',
      aggregate: { status: notAggregate ? 'NOT_APPLICABLE' : 'UNKNOWN', home: null, away: null,
        reason: notAggregate ? 'NO_TWO_LEG_AGGREGATE_IN_THIS_PHASE' : 'PER_TIE_LEG_AND_AGGREGATE_NOT_VERIFIED' },
      leg: null, domesticStrengthAdjustment: null, domesticStrengthModelVerified: false },
    source: bound.source, sourceEvidence: bound.evidence, sourcePublishedAt: bound.source.sourcePublishedAt,
    sources: [{ ...document.source }], observedAt: new Date(now).toISOString(),
    reason: 'UCL_DOMESTIC_STRENGTH_AND_PHASE_EFFECTS_UNVERIFIED', ...restrictions,
    limitations: ['OBSERVED_PHASE_DOES_NOT_ESTIMATE_DOMESTIC_LEAGUE_STRENGTH',
      'KNOCKOUT_LABEL_ALONE_DOES_NOT_PROVE_TWO_LEGS_OR_AN_AGGREGATE_SCORE'] };
}

export function buildSoccerMatchConditionsEvidence({ game, summaryDocument = null, workloadDocuments = [], geographyInputs = [], now = Date.now() } = {}) {
  if (!validGame(game) || !Number.isFinite(now) || !Array.isArray(workloadDocuments) || !Array.isArray(geographyInputs)) return { ok: false, version: SOCCER_MATCH_CONDITIONS_EVIDENCE_VERSION,
    code: 'MATCH_CONDITIONS_GAME_SCOPE_INVALID', travel: missing('MATCH_CONDITIONS_GAME_SCOPE_INVALID'), uclContext: missing('MATCH_CONDITIONS_GAME_SCOPE_INVALID'), ...restrictions };
  const summary = summaryDocument && validSummary(game, summaryDocument, now), prestart = game.status === 'scheduled' && instant(game.startTime) > now;
  if (!summary) return { ok: false, version: SOCCER_MATCH_CONDITIONS_EVIDENCE_VERSION, gameId: game.id, league: game.league,
    code: 'MATCH_CONDITIONS_SUMMARY_SCOPE_OR_PROOF_INVALID', travel: missing('MATCH_CONDITIONS_SUMMARY_SCOPE_OR_PROOF_INVALID'),
    uclContext: game.league === 'ucl' ? missing('UCL_CONTEXT_SOURCE_SCOPE_OR_PROOF_UNAVAILABLE')
      : { status: 'NOT_APPLICABLE', value: null, reason: 'NOT_UCL', sources: [], ...restrictions }, ...restrictions };
  const documents = workloadDocuments.filter(document => validDocument(document, now));
  const travel = travelObservation(game, summary ? summaryDocument : null, summary, documents, geographyInputs, now), uclContext = uclObservation(game, summaryDocument, summary, now);
  for (const observation of [travel, uclContext]) if (observation.value !== null) {
    observation.phase = prestart ? 'PREMATCH_OBSERVATION' : 'POSTSTART_AUDIT';
    if (!prestart && observation.status !== 'NOT_APPLICABLE') observation.status = 'POSTSTART_OBSERVATION';
  }
  return { ok: travel.value !== null || uclContext.value !== null, version: SOCCER_MATCH_CONDITIONS_EVIDENCE_VERSION,
    gameId: game.id, league: game.league, observedAt: new Date(now).toISOString(), travel, uclContext, ...restrictions };
}

// Return originals only for this process's successful server factory result.
// A clone, saved flag, caller-supplied hash or HTTP body cannot recreate it.
export function soccerMatchConditionsDocumentProof(observation) {
  try {
    const proof = proofs.get(observation);
    if (!proof || proof.observationHash !== hash(observationView(observation)) || proof.documents.some(document => document.source?.provider === 'ESPN'
      ? !soccerProviderDocumentHashValid(document) : !soccerWeatherDocumentValid(document, 'WIKIDATA', proof.reconstructionInputs.now))) return null;
    return { ...proof, binding: structuredClone(proof.binding), reconstructionInputs: structuredClone(proof.reconstructionInputs),
      documents: proof.documents.map(document => ({ ...document, source: { ...document.source }, text: document.retainedJson ?? document.text })) };
  } catch { return null; }
}
export function restoreSoccerMatchConditionsObservation(proof) {
  try {
  if (!proof?.binding || !Array.isArray(proof.documents) || !['travel', 'uclContext'].includes(proof.binding.field)) return null;
  const { game, now } = proof.reconstructionInputs || {}, league = soccerLeague(game?.league);
  if (!league || proof.binding.league !== game.league || proof.binding.gameId !== game.id || proof.binding.date !== game.date
    || proof.binding.startTime !== game.startTime || proof.reconstructionInputs.field && proof.reconstructionInputs.field !== proof.binding.field
    || ['home', 'away'].some(side => proof.binding[side] && proof.binding[side].sourceId !== game[side]?.sourceId)) return null;
  const documents = proof.documents.map(document => document.source?.provider === 'ESPN'
    ? { ...document, ok: true, retainedJson: document.text ?? document.retainedJson, data: JSON.parse(document.text ?? document.retainedJson) } : document);
  const summaryDocument = documents.find(document => urlFor(document)?.pathname === `/apis/site/v2/sports/soccer/${league.espnSlug}/summary`);
  const geographyInputs = (proof.reconstructionInputs.geographyInputs || []).map(input => ({ ...input,
    documents: input.documentHashes.map(key => documents.find(document => document.source?.contentHash === key)).filter(Boolean) }));
  const rebuilt = buildSoccerMatchConditionsEvidence({ game, now, summaryDocument, geographyInputs, workloadDocuments: documents.filter(document => document.source?.provider === 'ESPN' && document !== summaryDocument) });
  const observation = rebuilt[proof.binding.field], expectedHash = proof.observationHash ?? proof.binding.observationHash;
  if (!observation || observation.phase !== proof.binding.phase || expectedHash && hash(observation) !== expectedHash) return null;
  return observation;
  } catch { return null; }
}
export async function fetchSoccerMatchConditionsEvidence({ game, evidence, workload } = {}, options = {}) {
  const clock = typeof options.now === 'function' ? options.now : options.now === undefined ? Date.now : () => options.now;
  const started = clock(), league = soccerLeague(game?.league), deadline = Date.now() + (options.timeoutMs ?? 6000);
  if (!validGame(game) || !Number.isFinite(started)) return buildSoccerMatchConditionsEvidence({ game, now: started });
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${league.espnSlug}/summary?event=${game.sourceId}`;
  let document;
  const original = soccerSourceDocumentProof(evidence);
  if (original && original.binding.gameId === game.id && original.binding.league === game.league) {
    const binding = original.binding;
    document = { ok: true, data: JSON.parse(original.text), retainedJson: original.text,
      source: { provider: binding.provider, url: binding.sourceUrl, contentHash: binding.contentHash,
        fetchedAt: binding.fetchedAt, availableAt: binding.availableAt, requestedAt: binding.requestedAt,
        sourcePublishedAt: binding.sourcePublishedAt, sourceUpdatedAt: binding.sourceUpdatedAt } };
  } else {
    try { document = await (options.fetchJson || fetchSoccerJson)(url, { fetchImpl: options.fetchImpl, now: clock, timeoutMs: options.timeoutMs ?? 6000, ttlMs: 30000 }); }
    catch { document = null; }
  }
  let now = clock();
  const summaryDocument = document?.ok ? retainSoccerProviderDocument(document) : null;
  const workloadDocuments = soccerWorkloadSourceDocuments(workload), geographyInputs = [], geographyDocuments = [];
  const initial = buildSoccerMatchConditionsEvidence({ game, now, summaryDocument, workloadDocuments });
  const travel = initial.travel?.value;
  if (travel) {
    const venues = [{ role: 'target', value: travel.targetVenue }, ...['home', 'away'].map(side => ({ role: `${side}Previous`, value: travel.teams[side].previousVenue }))];
    await Promise.all(venues.map(async ({ role, value }) => {
      if (!value || value.coordinates || !value.venueId && !value.scopeKey || !value.city || !value.country || Date.now() >= deadline) return;
      const venue = geographyVenue(value);
      const supplied = role === 'target' ? options.targetGeography : null;
      let geography = supplied;
      try { if (!geography) geography = await (options.fetchVenueGeography || fetchSoccerVenueGeography)(venue,
        { fetchImpl: options.fetchImpl, now: clock, timeoutMs: Math.max(1, deadline - Date.now()) }); } catch { return; }
      const proof = soccerVenueGeographyDocumentProof(geography);
      if (!proof || hash(proof.reconstructionInputs.venue) !== hash(venue)) return;
      geographyInputs.push({ role, venue, documents: proof.documents }); geographyDocuments.push(...proof.documents);
    }));
  }
  now = clock();
  const result = buildSoccerMatchConditionsEvidence({ game, now, summaryDocument, workloadDocuments, geographyInputs });
  const documents = [...(summaryDocument && validSummary(game, summaryDocument, now) ? [summaryDocument] : []), ...workloadDocuments]
    .filter(document => validDocument(document, now)).map(document => ({ ...retainSoccerProviderDocument(document), source: { ...document.source } }));
  documents.push(...geographyDocuments);
  for (const field of ['travel', 'uclContext']) {
    const observation = result[field];
    if (!observation || observation.value === null || observation.status === 'NOT_APPLICABLE' || !documents.length) continue;
    const fieldDocuments = [...new Map((field === 'uclContext' ? [documents[0]] : documents)
      .map(value => [hash([value.source.provider, value.source.url, value.source.contentHash, value.source.fetchedAt]), value])).values()];
    const binding = { ...scopeOf(game), phase: observation.phase, kind: 'match_conditions', field };
    proofs.set(observation, { binding, reconstructionInputs: { game: structuredClone(game), now, field,
      geographyInputs: field === 'uclContext' ? [] : geographyInputs.map(input => ({ role: input.role, venue: input.venue,
        documentHashes: input.documents.map(document => document.source.contentHash) })) }, documents: fieldDocuments,
      observationHash: hash(observation), sourceHashes: [...new Set(fieldDocuments.map(value => value.source.contentHash))] });
  }
  return result;
}
