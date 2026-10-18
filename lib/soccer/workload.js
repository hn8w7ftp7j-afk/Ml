import { fetchSoccerJson } from './data.js';
import { soccerLeague } from './contracts.js';

const DAY = 86_400_000;
const version = 'SOCCER-ALL-COMPETITION-WORKLOAD-v1';
const id = value => /^\d{1,16}$/.test(String(value ?? '')) ? String(value) : null;
const clean = value => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 160) : null;
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const fail = (code, extra = {}) => ({ ok: false, version, code, modelEffectApplied: false, ...extra });

function validUid(value, expected) {
  if (value == null) return true;
  if (typeof value !== 'string' || !value) return false;
  const tokens = new Map();
  for (const part of value.split('~')) {
    const match = /^([a-z]):([^~:]+)$/.exec(part);
    if (!match || tokens.has(match[1])) return false;
    tokens.set(match[1], match[2]);
  }
  return Object.entries(expected).every(([key, wanted]) => !tokens.has(key) || tokens.get(key) === String(wanted));
}

/** All-competition club schedule observations, not a complete player-load model. */
export function normalizeSoccerTeamWorkload(observations, team, game, asOf) {
  const teamId = id(team?.sourceId), targetId = id(game?.sourceId), targetStart = instant(game?.startTime);
  if (!teamId || !targetId || targetStart === null || !Number.isFinite(asOf) || !Array.isArray(observations) || !observations.length) return fail('SOCCER_WORKLOAD_SCOPE_INVALID');
  const referenceAt = Math.min(asOf, targetStart), records = new Map(), excluded = [], sources = [];
  for (const observation of observations) {
    const { data, source, kind } = observation || {};
    const fetchedAt = instant(source?.fetchedAt);
    if (fetchedAt === null || fetchedAt > asOf) return fail('SOCCER_WORKLOAD_SOURCE_AFTER_CUTOFF');
    if (!['results', 'fixtures'].includes(kind) || data?.status !== 'success' || id(data.team?.id) !== teamId || !Array.isArray(data.events) || data.events.length > 500) return fail('SOCCER_WORKLOAD_TEAM_SCHEMA_INVALID');
    if (Number.isInteger(observation.season) && data.requestedSeason?.year != null && Number(data.requestedSeason.year) !== observation.season) return fail('SOCCER_WORKLOAD_SEASON_MISMATCH');
    sources.push(source);
    for (const raw of data.events) {
      const eventId = id(raw?.id), competition = raw.competitions?.[0], leagueId = id(raw.league?.id), leagueSlug = raw.league?.slug;
      if (!eventId || !Array.isArray(raw.competitions) || raw.competitions.length !== 1 || id(competition?.id) !== eventId || !leagueId || typeof leagueSlug !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/.test(leagueSlug)) return fail('SOCCER_WORKLOAD_EVENT_SCHEMA_INVALID');
      if (!validUid(raw.uid, { s: '600', l: leagueId, e: eventId }) || !validUid(competition.uid, { s: '600', l: leagueId, e: eventId, c: eventId })) return fail('SOCCER_WORKLOAD_EVENT_IDENTITY_INVALID');
      const start = instant(raw.date), competitionStart = instant(competition.date);
      if (start === null || competitionStart === null || start !== competitionStart) return fail('SOCCER_WORKLOAD_START_INVALID');
      const competitors = competition.competitors;
      if (!Array.isArray(competitors) || competitors.length !== 2 || competitors.filter(t => t.homeAway === 'home').length !== 1 || competitors.filter(t => t.homeAway === 'away').length !== 1 || competitors.some(t => !id(t.team?.id) || id(t.id) !== id(t.team.id) || !validUid(t.team.uid, { s: '600', t: id(t.team.id) }))) return fail('SOCCER_WORKLOAD_COMPETITORS_INVALID');
      const own = competitors.filter(t => id(t.team.id) === teamId);
      if (own.length !== 1 || id(competitors[0].team.id) === id(competitors[1].team.id)) return fail('SOCCER_WORKLOAD_TEAM_IDENTITY_INVALID');
      if (eventId === targetId) continue;
      if (raw.timeValid === false || competition.timeValid === false) { excluded.push({ eventId, reason: 'START_TIME_UNCONFIRMED' }); continue; }
      const type = competition.status?.type, name = String(type?.name || '').toUpperCase();
      const completed = type?.completed === true && type?.state === 'post' && /^STATUS_(?:FULL_TIME|FINAL(?:_AET|_PEN|_AGT|_AGT_PEN|_AFTER_EXTRA_TIME|_AFTER_PENALTIES)?)$/.test(name);
      const scheduled = type?.completed === false && type?.state === 'pre' && name === 'STATUS_SCHEDULED';
      if (!completed && !scheduled) { excluded.push({ eventId, reason: 'NOT_CONFIRMED_COMPLETED_OR_SCHEDULED' }); continue; }
      if (completed && start >= referenceAt) { excluded.push({ eventId, reason: 'COMPLETED_START_NOT_BEFORE_REFERENCE' }); continue; }
      if (scheduled && start <= asOf) { excluded.push({ eventId, reason: 'SCHEDULED_TIME_ALREADY_ELAPSED' }); continue; }
      const opponent = competitors.find(t => id(t.team.id) !== teamId);
      const record = { eventId, startTime: new Date(start).toISOString(), competition: { id: leagueId, slug: leagueSlug, name: clean(raw.league.name) }, homeAway: own[0].homeAway, opponent: { sourceId: id(opponent.team.id), name: clean(opponent.team.displayName || opponent.team.name) }, venue: clean(competition.venue?.fullName), neutralSite: competition.neutralSite === true, status: completed ? 'COMPLETED' : 'SCHEDULED', providerStatus: name, extraTimeReported: completed && (Number(competition.status?.period) > 2 || /AET|AFTER_EXTRA_TIME/.test(name)), playerMinutes: null, actualEndTime: null, sourcePublishedAt: null };
      const previous = records.get(eventId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(record)) return fail('SOCCER_WORKLOAD_EVENT_REVISION_CONFLICT');
      records.set(eventId, record);
    }
  }
  const all = [...records.values()].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const completed = all.filter(e => e.status === 'COMPLETED' && Date.parse(e.startTime) < referenceAt);
  const last = completed.at(-1) || null;
  const recent = completed.filter(e => Date.parse(e.startTime) >= referenceAt - 14 * DAY);
  const scheduledAhead = all.filter(e => e.status === 'SCHEDULED' && Date.parse(e.startTime) <= targetStart + 7 * DAY);
  const scheduledBeforeTarget = scheduledAhead.filter(e => Date.parse(e.startTime) < targetStart);
  const resultsObserved = observations.some(o => o.kind === 'results');
  return {
    ok: true, version, status: 'PROVIDER_REPORTED_PARTIAL', sourceId: teamId,
    asOf: new Date(asOf).toISOString(), referenceAt: new Date(referenceAt).toISOString(),
    referenceMeaning: targetStart > asOf ? 'ACTUAL_LOAD_AS_OF_ANALYSIS' : 'OBSERVED_HISTORY_BEFORE_TARGET_KICKOFF_NOT_HISTORICAL_PIT_PROOF',
    lastKnownCompleted: last, recentCompleted: recent, scheduledAhead, scheduledBeforeTarget,
    completedMatchesLast7Days: resultsObserved ? recent.filter(e => Date.parse(e.startTime) >= referenceAt - 7 * DAY).length : null,
    completedMatchesLast14Days: resultsObserved ? recent.length : null,
    kickoffGapHoursFromLastCompleted: last ? (targetStart - Date.parse(last.startTime)) / 3_600_000 : null,
    elapsedHoursSinceLastCompletedKickoff: last && targetStart > asOf ? (asOf - Date.parse(last.startTime)) / 3_600_000 : null,
    actualRestHours: null,
    coverage: { allCompetitionsRequested: true, complete: false, independentlyVerified: false, resultsObserved, fixturePlansObserved: observations.some(o => o.kind === 'fixtures'), countMeaning: 'OBSERVED_COMPLETED_CLUB_FIXTURES_ONLY', responseEvents: observations.reduce((n, o) => n + o.data.events.length, 0), distinctCompetitions: [...new Set(all.map(e => e.competition.slug))].sort(), playerMinutesComplete: false, internationalDutyCoverageVerified: false, reason: 'PROVIDER_ALL_COMPETITION_COVERAGE_NOT_INDEPENDENTLY_VERIFIED' },
    sources, excluded, modelEffectApplied: false, pointInTimeAvailabilityVerified: false,
    limitations: ['Kickoff gap is not elapsed recovery time; the prior actual end time is unavailable.', 'Future fixtures are published plans and do not count as completed physical workload.', 'Club schedules do not establish individual participation, international duty, injury, travel distance or complete workload coverage.'],
  };
}

export async function fetchSoccerWorkload(game, options = {}) {
  const now = options.now || Date.now, current = typeof now === 'function' ? now() : NaN;
  const target = instant(game?.startTime), league = soccerLeague(game?.league);
  if (!league || !Number.isFinite(current) || target === null || !id(game?.sourceId) || !id(game?.home?.sourceId) || !id(game?.away?.sourceId) || id(game.home.sourceId) === id(game.away.sourceId)) return fail('SOCCER_WORKLOAD_REQUEST_INVALID');
  const reference = Math.min(current, target), year = new Date(reference).getUTCFullYear();
  if (year < 2001 || year > 2099) return fail('SOCCER_WORKLOAD_SEASON_INVALID');
  const requestedTimeout = options.timeoutMs ?? 8000;
  if (!Number.isFinite(requestedTimeout) || requestedTimeout <= 0) return fail('SOCCER_WORKLOAD_FETCH_OPTIONS_INVALID');
  // UCL clubs need not share the EPL's summer season boundary. Request both
  // calendar-year labels; use the provider's current fixture scope for plans.
  // Neither this policy nor successful responses certify complete coverage.
  const jobs = ['home', 'away'].map(side => ({ side, kind: 'results', season: year }))
    .concat(['home', 'away'].map(side => ({ side, kind: 'fixtures', season: null })))
    .concat(['home', 'away'].map(side => ({ side, kind: 'results', season: year - 1 })));
  const collected = { home: [], away: [] }, started = Date.now();
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const { side, kind, season } = jobs[cursor++], team = game[side];
      const remaining = 9000 - (Date.now() - started);
      const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/teams/${team.sourceId}/schedule?${kind === 'fixtures' ? 'fixture=true' : `season=${season}`}`;
      const result = remaining <= 0 ? fail('SOCCER_WORKLOAD_BUDGET_EXCEEDED') : await fetchSoccerJson(url, { ...options, ttlMs: 60_000, timeoutMs: Math.min(requestedTimeout, remaining), now });
      collected[side].push({ ...result, kind, season });
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  const sides = ['home', 'away'].map(side => {
    const team = game[side], observations = collected[side];
    const available = observations.filter(o => o.ok), failures = observations.filter(o => !o.ok).map(o => ({ kind: o.kind, requestedSeason: o.season, code: o.code, source: o.source || null }));
    const value = available.length ? normalizeSoccerTeamWorkload(available, team, game, now()) : fail(failures[0]?.code || 'SOCCER_WORKLOAD_UNAVAILABLE', { sourceId: team.sourceId });
    return [side, { ...value, ...(value.coverage ? { coverage: { ...value.coverage, requestedResultSeasons: [year, year - 1], fixtureScope: 'PROVIDER_CURRENT_FIXTURES', missingRequests: failures.length } } : {}), sources: observations.map(o => o.source).filter(Boolean), retrievalFailures: failures }];
  });
  const teams = Object.fromEntries(sides), sources = sides.flatMap(([, value]) => value.sources || []);
  return { ok: sides.some(([, value]) => value.ok), version, status: sides.every(([, value]) => value.ok && !value.retrievalFailures.length) ? 'PROVIDER_REPORTED_PARTIAL' : 'INCOMPLETE', gameId: game.id, observedAt: sources.map(s => s.fetchedAt).filter(Boolean).sort().at(-1) || null, teams, sources, modelEffectApplied: false, pointInTimeAvailabilityVerified: false, executable: false };
}
