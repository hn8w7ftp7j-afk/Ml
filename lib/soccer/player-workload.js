import { createHash } from 'node:crypto';
import { fetchSoccerJson } from './data.js';
import { soccerMinutesAuditV2, SOCCER_MINUTES_AUDIT_V2_VERSION } from './personnel-audit.js';

const DAY = 86_400_000;
// New live observations use the source-ID/state extractor. Previously saved
// workloads and frozen personnel/model artifacts keep their original versions.
const VERSION = 'SOCCER-OBSERVED-PLAYER-WORKLOAD-v2';
const CLOCK = 'PROVIDER_REGULATION_SECONDS_EXCLUDES_ADDED_TIME';
const id = value => /^\d{1,16}$/.test(String(value ?? '')) ? String(value) : null;
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const clean = value => typeof value === 'string' ? value.replace(/[<>\u0000-\u001f]/g, ' ').trim().slice(0, 160) : null;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = (code, extra = {}) => ({ ok: false, version: VERSION, code, modelEffectApplied: false, formalEligible: false, executable: false, ...extra });
const summaryUrl = record => `https://site.api.espn.com/apis/site/v2/sports/soccer/${record.competition.slug}/summary?event=${record.eventId}`;

function uidMatches(value, expected) {
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

function recordValid(record, teamWorkload, asOf) {
  const start = instant(record?.startTime), reference = instant(teamWorkload?.referenceAt), known = instant(teamWorkload?.asOf);
  return teamWorkload?.ok === true && id(teamWorkload.sourceId) && known !== null && known <= asOf && reference !== null && reference <= asOf
    && id(record?.eventId) && id(record?.opponent?.sourceId) && id(record.opponent.sourceId) !== id(teamWorkload.sourceId)
    && id(record?.competition?.id) && typeof record?.competition?.slug === 'string' && /^[a-z][a-z0-9._-]{1,63}$/.test(record.competition.slug)
    && ['home', 'away'].includes(record?.homeAway) && record.status === 'COMPLETED'
    && start !== null && start < reference && start >= reference - 14 * DAY;
}

/** Validate one previously completed club match. This is observed history, never a minutes forecast. */
export function normalizeSoccerPlayerMatch(payload, record, teamWorkload, source, asOf = Date.now()) {
  if (!Number.isFinite(asOf) || !recordValid(record, teamWorkload, asOf)) return fail('SOCCER_PLAYER_MATCH_SCOPE_INVALID');
  const fetched = instant(source?.fetchedAt);
  if (fetched === null || fetched > asOf) return fail('SOCCER_PLAYER_SOURCE_AFTER_CUTOFF');
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || source?.provider !== 'ESPN' || source.url !== summaryUrl(record)
    || source.contentHash !== createHash('sha256').update(JSON.stringify(payload)).digest('hex')) return fail('SOCCER_PLAYER_SOURCE_VERSION_INVALID');
  const header = payload?.header, league = header?.league, competitions = header?.competitions;
  if (id(header?.id) !== record.eventId || !Array.isArray(competitions) || competitions.length !== 1
    || id(league?.id) !== record.competition.id || league?.slug !== record.competition.slug
    || !uidMatches(header.uid, { s: '600', l: record.competition.id, e: record.eventId })
    || !uidMatches(league.uid, { s: '600', l: record.competition.id })) return fail('SOCCER_PLAYER_SUMMARY_SCOPE_MISMATCH');
  const competition = competitions[0], competitors = competition?.competitors;
  if (id(competition?.id) !== record.eventId || instant(competition.date) !== instant(record.startTime)
    || header.timeValid === false || competition.timeValid === false
    || !uidMatches(competition.uid, { s: '600', l: record.competition.id, e: record.eventId, c: record.eventId })
    || !Array.isArray(competitors) || competitors.length !== 2
    || competitors.some(team => !object(team) || !object(team.team))
    || competitors.filter(team => team.homeAway === 'home').length !== 1 || competitors.filter(team => team.homeAway === 'away').length !== 1
    || competitors.some(team => !id(team.team?.id) || id(team.id) !== id(team.team.id) || !uidMatches(team.team.uid, { s: '600', t: id(team.team.id) }))) return fail('SOCCER_PLAYER_SUMMARY_IDENTITY_INVALID');
  const own = competitors.find(team => team.homeAway === record.homeAway), opponent = competitors.find(team => team.homeAway !== record.homeAway);
  if (id(own?.team.id) !== teamWorkload.sourceId || id(opponent?.team.id) !== record.opponent.sourceId) return fail('SOCCER_PLAYER_TEAM_IDENTITY_MISMATCH');
  const status = competition.status;
  if (status?.type?.completed !== true || status?.type?.state !== 'post' || status.type.name !== 'STATUS_FULL_TIME'
    || payload.format?.regulation?.periods !== 2 || payload.format?.regulation?.clock !== 2700) return fail('SOCCER_PLAYER_REGULATION_FINAL_UNVERIFIED');
  const allPlayerIds = new Set();
  if (!Array.isArray(payload.rosters) || payload.rosters.length !== 2) return fail('SOCCER_PLAYER_ROSTER_SCOPE_INVALID');
  for (const roster of payload.rosters) {
    if (!object(roster) || !Array.isArray(roster.roster) || roster.roster.length > 40) return fail('SOCCER_PLAYER_ROSTER_SCOPE_INVALID');
    for (const player of roster.roster) {
      if (!object(player) || !object(player.athlete)) return fail('SOCCER_PLAYER_ROSTER_IDENTITY_INVALID');
      const playerId = id(player.athlete.id);
      if (!playerId || allPlayerIds.has(playerId) || !clean(player.athlete?.displayName || player.athlete?.fullName)) return fail('SOCCER_PLAYER_ROSTER_IDENTITY_INVALID');
      allPlayerIds.add(playerId);
    }
  }
  if (!Array.isArray(payload.keyEvents) || payload.keyEvents.length > 1000 || payload.keyEvents.some(event => !object(event))) return fail('SOCCER_PLAYER_TIMELINE_SCHEMA_INVALID');
  const game = Object.fromEntries(['home', 'away'].map(side => [side, { sourceId: id(competitors.find(team => team.homeAway === side).team.id) }]));
  let audit;
  try { audit = soccerMinutesAuditV2(payload, { ...game, status: 'final' }, { teamSide: record.homeAway }); }
  catch { return fail('SOCCER_PLAYER_SUMMARY_SCHEMA_INVALID'); }
  if (audit.status !== 'REGULATION_CLOCK_RECONSTRUCTED') return fail(audit.reason || 'SOCCER_PLAYER_MINUTES_UNVERIFIED');
  const team = audit.teams[record.homeAway];
  return {
    ok: true, version: VERSION, eventId: record.eventId, sourceId: teamWorkload.sourceId,
    startTime: record.startTime, competition: structuredClone(record.competition), homeAway: record.homeAway,
    source: structuredClone(source), players: team.players.map(player => ({ ...player, name: clean(player.name) })),
    teamPlayerMinutes: team.teamPlayerMinutes, teamScope: audit.teamScope, auditedTeamSide: audit.teamSide, clockBasis: CLOCK,
    extractorVersion: SOCCER_MINUTES_AUDIT_V2_VERSION, roleResolutionPolicy: audit.roleResolutionPolicy,
    dismissalPolicy: audit.dismissalPolicy, stateResolvedSubstitutions: audit.stateResolvedSubstitutions,
    informationalCardReviewCount: audit.informationalCardReviewCount,
    participationEvents: team.events, informationalCardReviews: team.informationalCardReviews,
    physicalElapsedMinutesVerified: false, modelEffectApplied: false, formalEligible: false, executable: false,
  };
}

/** Aggregate only verified match observations. Zeroes describe that observed subset, not complete player history. */
export function normalizeSoccerPlayerWorkload(teamWorkload, observations, { asOf = Date.now(), matchLimit = 4, omissions = [] } = {}) {
  const referenceAt = instant(teamWorkload?.referenceAt), knownAt = instant(teamWorkload?.asOf);
  if (teamWorkload?.ok !== true || !id(teamWorkload.sourceId) || referenceAt === null || knownAt === null
    || !Number.isFinite(asOf) || knownAt > asOf || referenceAt > asOf || !Array.isArray(observations)) return fail('SOCCER_PLAYER_WORKLOAD_SCOPE_INVALID');
  const matches = [], excluded = structuredClone(omissions), sources = [], seen = new Set();
  for (const observation of observations) {
    const record = observation?.record;
    if (!recordValid(record, teamWorkload, asOf)) { excluded.push({ eventId: record?.eventId || null, reason: 'SOCCER_PLAYER_MATCH_SCOPE_INVALID' }); continue; }
    if (seen.has(record.eventId)) return fail('SOCCER_PLAYER_DUPLICATE_MATCH');
    seen.add(record.eventId);
    if (observation.source) sources.push(structuredClone(observation.source));
    let result;
    try {
      result = observation.ok === false ? fail(observation.code || 'SOCCER_PLAYER_SUMMARY_UNAVAILABLE')
        : normalizeSoccerPlayerMatch(observation.data, record, teamWorkload, observation.source, asOf);
    } catch { result = fail('SOCCER_PLAYER_SUMMARY_SCHEMA_INVALID'); }
    if (result.ok) matches.push(result);
    else excluded.push({ eventId: record.eventId, reason: result.code, source: observation.source ? structuredClone(observation.source) : null });
  }
  matches.sort((a, b) => b.startTime.localeCompare(a.startTime));
  const players = new Map();
  for (const match of matches) {
    const within7Days = Date.parse(match.startTime) >= referenceAt - 7 * DAY;
    for (const observed of match.players) {
      if (!players.has(observed.id)) players.set(observed.id, { id: observed.id, name: observed.name,
        regulationClockMinutesLast7Days: 0, regulationClockMinutesLast14Days: 0,
        appearancesLast7Days: 0, appearancesLast14Days: 0, startsLast7Days: 0, startsLast14Days: 0,
        rosterMatchesObservedLast7Days: 0, rosterMatchesObservedLast14Days: 0, sourceMatchIds: [] });
      const player = players.get(observed.id);
      for (const days of within7Days ? [7, 14] : [14]) {
        player[`regulationClockMinutesLast${days}Days`] += observed.regulationClockMinutes;
        player[`appearancesLast${days}Days`] += Number(observed.appeared);
        player[`startsLast${days}Days`] += Number(observed.starter);
        player[`rosterMatchesObservedLast${days}Days`]++;
      }
      player.sourceMatchIds.push(match.eventId);
    }
  }
  for (const player of players.values()) {
    for (const days of [7, 14]) if (player[`rosterMatchesObservedLast${days}Days`] === 0) {
      player[`regulationClockMinutesLast${days}Days`] = null;
      player[`appearancesLast${days}Days`] = null;
      player[`startsLast${days}Days`] = null;
    }
  }
  return {
    ok: matches.length > 0, version: VERSION, status: matches.length ? 'OBSERVED_PARTIAL' : 'UNAVAILABLE',
    sourceId: teamWorkload.sourceId, asOf: new Date(asOf).toISOString(), referenceAt: teamWorkload.referenceAt, windowDays: 14,
    players: [...players.values()].sort((a, b) => b.regulationClockMinutesLast14Days - a.regulationClockMinutesLast14Days || a.id.localeCompare(b.id)),
    matches, sources, omissions: excluded,
    coverage: { complete: false, candidateMatches: matches.length + excluded.length, attemptedMatches: observations.filter(observation => observation?.attempted ?? (observation?.code !== 'SOCCER_PLAYER_BUDGET_EXCEEDED')).length,
      attemptMeaning: 'CONSUMER_SUMMARY_READS_INCLUDING_CACHE_OR_SHARED_INFLIGHT',
      verifiedMatches: matches.length, verifiedMatchesLast7Days: matches.filter(match => Date.parse(match.startTime) >= referenceAt - 7 * DAY).length,
      verifiedMatchesLast14Days: matches.length, omittedMatches: excluded.length, matchLimit,
      countMeaning: 'VERIFIED_OBSERVED_CLUB_MATCHES_ONLY', internationalDutyCoverageVerified: false },
    extractorVersion: SOCCER_MINUTES_AUDIT_V2_VERSION,
    clockBasis: CLOCK, physicalElapsedMinutesVerified: false, pointInTimeAvailabilityVerified: false,
    modelEffectApplied: false, formalEligible: false, executable: false,
    limitations: ['Minutes, starts and appearances cover the verified club-match subset only; missing matches are not zero workload.',
      'Regulation-clock minutes exclude physical added time and extra time; zero clock minutes can still include an added-time appearance.',
      'No expected minutes, current availability, national-team duty or performance adjustment is inferred.'],
  };
}

// A shared producer may have a longer timeout than this consumer. Bound only
// our wait; its AbortController belongs to the producer and other readers.
async function readSummaryWithinDeadline(url, { fetchImpl, now, timeoutMs, deadline }) {
  const remaining = deadline - Date.now();
  const source = { provider: 'ESPN', url, requestedAt: remaining > 0 ? new Date(now()).toISOString() : null,
    fetchedAt: null, acquisitionStatus: 'NOT_ACQUIRED_BY_THIS_CONSUMER' };
  if (remaining <= 0) return fail('SOCCER_PLAYER_BUDGET_EXCEEDED', { source, attempted: false });
  const waitMs = Math.min(timeoutMs, remaining);
  const timeoutCode = remaining <= timeoutMs ? 'SOCCER_PLAYER_BUDGET_EXCEEDED' : 'SOCCER_SOURCE_TIMEOUT';
  let timer;
  try {
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(fail(timeoutCode, { source })), waitMs); });
    const result = await Promise.race([timeout,
      fetchSoccerJson(url, { fetchImpl, now, ttlMs: 300_000, timeoutMs: waitMs })]);
    // Late resolution cannot publish a successful observation after our budget.
    return { ...(Date.now() > deadline ? fail('SOCCER_PLAYER_BUDGET_EXCEEDED', { source }) : result), attempted: true };
  } catch { return fail('SOCCER_SOURCE_UNAVAILABLE', { source, attempted: true }); }
  finally { clearTimeout(timer); }
}

/** Bounded all-competition summary reads; one provider failure never erases other verified observations. */
export async function fetchSoccerPlayerWorkload(teamWorkload, options = {}) {
  const now = options.now || Date.now, current = typeof now === 'function' ? now() : NaN;
  const maxMatches = options.maxMatches ?? 4, maxConcurrent = options.maxConcurrent ?? 2;
  const budgetMs = options.budgetMs ?? 5000, timeoutMs = options.timeoutMs ?? 2500;
  if (teamWorkload?.ok !== true || !Array.isArray(teamWorkload.recentCompleted) || !Number.isFinite(current)
    || !Number.isInteger(maxMatches) || maxMatches < 1 || maxMatches > 6 || !Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 2
    || !Number.isFinite(budgetMs) || budgetMs <= 0 || budgetMs > 6000 || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 4000) return fail('SOCCER_PLAYER_FETCH_OPTIONS_INVALID');
  const candidates = [...teamWorkload.recentCompleted].sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)));
  const jobs = [], omissions = [], seen = new Set();
  for (const record of candidates) {
    if (!recordValid(record, teamWorkload, current)) { omissions.push({ eventId: record?.eventId || null, reason: 'SOCCER_PLAYER_MATCH_SCOPE_INVALID' }); continue; }
    if (seen.has(record.eventId)) return fail('SOCCER_PLAYER_DUPLICATE_MATCH');
    seen.add(record.eventId);
    if (record.extraTimeReported) { omissions.push({ eventId: record.eventId, reason: 'SOCCER_PLAYER_EXTRA_TIME_UNVERIFIED' }); continue; }
    if (jobs.length >= maxMatches) { omissions.push({ eventId: record.eventId, reason: 'SOCCER_PLAYER_MATCH_LIMIT' }); continue; }
    jobs.push(record);
  }
  const deadline = Date.now() + budgetMs, observations = [];
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const record = jobs[cursor++];
      const result = await readSummaryWithinDeadline(summaryUrl(record), { fetchImpl: options.fetchImpl, now, timeoutMs, deadline });
      observations.push({ ...result, record });
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrent, jobs.length) }, worker));
  return normalizeSoccerPlayerWorkload(teamWorkload, observations, { asOf: now(), matchLimit: maxMatches, omissions });
}
