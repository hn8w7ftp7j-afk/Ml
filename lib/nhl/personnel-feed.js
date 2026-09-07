import { createHash } from 'node:crypto';
import { load } from 'cheerio';
import { validNhlDate, validateNhlIdentity } from './identity.js';
import { nhlSourceCooldown, recordNhlSourceRateLimit } from './source-retry-policy.js';

export const NHL_PERSONNEL_FEED_VERSION = 'NHL-OFFICIAL-EDITORIAL-PERSONNEL-v1.2';
const cacheByFetch = new WeakMap();
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const normalized = value => String(value || '').normalize('NFD').replace(/\p{M}/gu, '').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
  && validNhlDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const officialDate = value => timestamp(value) ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value)) : null;
const issue = (code, extras = {}) => ({ ok: false, league: 'NHL', leagueId: 'NHL', status: 'UNAVAILABLE', code, ...extras });
const unknownGoalie = () => ({ status: 'UNKNOWN', playerId: null, confirmationExplicit: false });

export function nhlPersonnelArticleUrl(season) {
  const value = String(season);
  if (!/^\d{8}$/.test(value) || Number(value.slice(4)) !== Number(value.slice(0, 4)) + 1) return null;
  return `https://www.nhl.com/news/nhl-lineup-projections-${value.slice(0, 4)}-${value.slice(6)}-season`;
}

export function allowedNhlPersonnelUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'www.nhl.com' && !url.port && !url.username && !url.password && !/^https:\/\/[^/?#]*@/i.test(String(value))
      && /^\/news\/[a-z0-9-]+$/.test(url.pathname) && !url.search && !String(value).includes('#');
  } catch { return false; }
}

// One bounded official request, with no 403/429 evasion or cross-host redirects.
// Cache raw evidence separately from caller-owned normalized views.
export async function fetchNhlPersonnelArticle(url, { fetchImpl = globalThis.fetch, now = Date.now, timeoutMs = 8000, ttlMs = 60_000, negativeTtlMs = 30_000 } = {}) {
  if (!allowedNhlPersonnelUrl(url)) return issue('NHL_PERSONNEL_SOURCE_NOT_ALLOWED');
  if (typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isFinite(now()) || !Number.isFinite(new Date(now()).getTime())
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 20_000
    || ![ttlMs, negativeTtlMs].every(n => Number.isFinite(n) && n >= 0 && n <= 300_000)) return issue('NHL_PERSONNEL_FETCH_OPTIONS_INVALID');
  if (!cacheByFetch.has(fetchImpl)) cacheByFetch.set(fetchImpl, new Map());
  const cache = cacheByFetch.get(fetchImpl);
  const previous = cache.get(url);
  if (previous?.inflight) return clone(await previous.inflight);
  if (previous?.expiresAt > now()) return { ...clone(previous.value),
    ...(previous.value?.code === 'NHL_PERSONNEL_RATE_LIMITED' ? nhlSourceCooldown(fetchImpl, url, now()) : {}), cached: true };
  const cooling = nhlSourceCooldown(fetchImpl, url, now());
  if (cooling) return issue('NHL_PERSONNEL_RATE_LIMITED', { httpStatus: 429, attempts: 0, ...cooling,
    source: { provider: 'NHL_EDITORIAL', url, rateLimitObservedAt: cooling.rateLimitObservedAt } });
  const operation = (async () => {
    const controller = new AbortController();
    let timer;
    let value;
    const requestedAt = new Date(now()).toISOString();
    const source = { provider: 'NHL_EDITORIAL', url, requestedAt };
    try {
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('NHL_PERSONNEL_TIMEOUT')); }, timeoutMs); });
      const response = await Promise.race([fetchImpl(url, { signal: controller.signal, headers: { Accept: 'text/html' }, redirect: 'manual', cache: 'no-store' }), timeout]);
      // Older season slugs can return 302 to NHL's own not-found page.
      // Classify that observed absence without fetching the redirect or
      // substituting a different season's personnel article.
      const location = response.headers?.get?.('location');
      const officialNotFound = [301, 302, 303, 307, 308].includes(response.status)
        && ['/errors/not-found', 'https://www.nhl.com/errors/not-found'].includes(location);
      if (response?.redirected || response?.type === 'opaqueredirect' || (response?.status >= 300 && response.status < 400)) {
        value = issue(officialNotFound && !response.redirected && response.type !== 'opaqueredirect'
          ? 'NHL_PERSONNEL_ARTICLE_NOT_FOUND' : 'NHL_PERSONNEL_REDIRECT_NOT_FOLLOWED', { httpStatus: response.status || null, source });
      } else if (response?.url && response.url !== new URL(url).href) value = issue('NHL_PERSONNEL_RESPONSE_URL_MISMATCH', { source });
      else if (!response?.ok) {
        const httpStatus = Number(response?.status) || null;
        const policy = httpStatus === 429 ? recordNhlSourceRateLimit(fetchImpl, url, { retryAfter: response.headers?.get?.('retry-after'), now: now() }) : {};
        value = issue(httpStatus === 404 ? 'NHL_PERSONNEL_ARTICLE_NOT_FOUND' : httpStatus === 403 ? 'NHL_PERSONNEL_FORBIDDEN' : httpStatus === 429 ? 'NHL_PERSONNEL_RATE_LIMITED'
          : 'NHL_PERSONNEL_HTTP_ERROR', { httpStatus, source: { ...source, observedAt: new Date(now()).toISOString(), fetchedAt: new Date(now()).toISOString() }, ...policy });
      } else if (Number(response.headers?.get?.('content-length')) > 2_000_000) value = issue('NHL_PERSONNEL_RESPONSE_TOO_LARGE', { source });
      else {
        const html = await Promise.race([response.text(), timeout]);
        value = typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 2_000_000
          ? issue('NHL_PERSONNEL_RESPONSE_TOO_LARGE', { source })
          : { ok: true, status: 'OK', html, source: { ...source, observedAt: new Date(now()).toISOString(), fetchedAt: new Date(now()).toISOString(), contentHash: hash(html) } };
      }
    } catch { value = issue(controller.signal.aborted ? 'NHL_PERSONNEL_TIMEOUT' : 'NHL_PERSONNEL_NETWORK_ERROR', { source }); }
    finally { clearTimeout(timer); }
    cache.set(url, { value, expiresAt: value.code === 'NHL_PERSONNEL_RATE_LIMITED' && value.retryAt
      ? Date.parse(value.retryAt) : now() + (value.ok ? ttlMs : negativeTtlMs) });
    while (cache.size > 64) cache.delete(cache.keys().next().value);
    return value;
  })();
  cache.set(url, { inflight: operation });
  return clone(await operation);
}

function articleMetadata($) {
  const articles = [];
  function visit(value) {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    if ([].concat(value['@type'] || []).includes('NewsArticle')) articles.push(value);
    if (value['@graph']) visit(value['@graph']);
  }
  $('script[type="application/ld+json"]').each((_, element) => { try { visit(JSON.parse($(element).text())); } catch { /* A missing valid article is rejected below. */ } });
  return articles.length === 1 ? articles[0] : null;
}

function teamAliases(game, side) {
  const name = normalized(game?.[side]?.name || game?.[`${side}Name`]);
  const common = normalized(game?.[side]?.commonName?.default || game?.[side]?.commonName);
  // NHL source lineup headings use either full official team names or the exact
  // nickname suffix. Never infer a numeric team ID from a nickname alone.
  return [name, common].filter(Boolean);
}

function matchesTeam(label, aliases) {
  const value = normalized(label).replace(/^\([^)]*\)\s*/, '');
  return value.length >= 3 && aliases.some(name => name === value || name.endsWith(` ${value}`));
}

function matchingGameHeading(text, game) {
  const parts = String(text).split(/\s+at\s+/i);
  return parts.length === 2 && matchesTeam(parts[0], teamAliases(game, 'away')) && matchesTeam(parts[1], teamAliases(game, 'home'));
}

function resolvePlayer(name, roster, teamId) {
  const needle = normalized(name);
  const matches = (Array.isArray(roster?.players) ? roster.players : []).filter(player => normalized(player?.name) === needle && player?.teamId === teamId);
  if (matches.length !== 1 || !Number.isSafeInteger(matches[0].playerId) || matches[0].playerId <= 0) return null;
  const player = matches[0];
  return { playerId: player.playerId, teamId, name: player.name, position: player.position, identitySources: player.identitySources || [roster.source], membershipBasis: player.membershipBasis || 'OFFICIAL_SEASON_ROSTER_AND_ARTICLE_TEAM_BLOCK' };
}

function parseNames(text) {
  if (/^none\.?$/i.test(text.trim())) return [];
  // Parenthesized injury descriptions sometimes contain commas. Splitting on
  // every comma would invent a player; retain each full parenthesized reason.
  const result = [];
  let depth = 0; let item = '';
  for (const char of text) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (depth < 0) return null;
    if (char === ',' && depth === 0) { result.push(item.trim()); item = ''; } else item += char;
  }
  if (depth !== 0) return null;
  if (item.trim()) result.push(item.trim());
  return result.length ? result : null;
}

function parseTeamRows(texts, roster, teamId, source, side, game, statusReports) {
  const errors = []; const warnings = [];
  const result = { teamId, lineupStatus: 'PROJECTED', lineCombinations: [], defensivePairings: [], listedGoalies: [], injuries: null, scratched: null, unresolvedAvailability: [], goalie: unknownGoalie(), issues: errors, warnings };
  const abbrev = game?.[side]?.abbrev || game?.[`${side}Abbrev`];
  const identitySources = roster?.identitySources == null ? [roster?.source] : Array.isArray(roster.identitySources) ? roster.identitySources : [];
  if (roster?.teamId !== teamId || !Array.isArray(roster?.players) || !identitySources.length || identitySources.some(row => !allowedIdentitySource(row, abbrev, game))) errors.push('NHL_PERSONNEL_ROSTER_SOURCE_IDENTITY_INVALID');
  const rosterPlayers = Array.isArray(roster?.players) ? roster.players : [];
  if (rosterPlayers.some(player => !player || player.teamId !== teamId) || new Set(rosterPlayers.map(player => player?.playerId)).size !== rosterPlayers.length) errors.push('NHL_PERSONNEL_ROSTER_IDENTITY_CONFLICT');
  const seen = new Set();
  const sourceFields = { sourceUrl: source.url, sourcePublishedAt: source.sourcePublishedAt, sourceUpdatedAt: source.sourceUpdatedAt, availableAt: source.availableAt, observedAt: source.observedAt, source };
  function resolve(name, allowedPositions = null) {
    const player = resolvePlayer(name, roster, teamId);
    if (!player) { errors.push(`NHL_PERSONNEL_PLAYER_UNRESOLVED:${name}`); return null; }
    if (allowedPositions && !allowedPositions.includes(player.position)) errors.push(`NHL_PERSONNEL_POSITION_CONFLICT:${player.playerId}`);
    if (seen.has(player.playerId)) errors.push(`NHL_PERSONNEL_DUPLICATE_PLAYER:${player.playerId}`);
    seen.add(player.playerId);
    return { ...player, ...sourceFields };
  }
  let inUnavailable = false;
  for (const text of texts) {
    const unavailable = text.match(/^(Injured|Scratched):\s*(.*)$/i);
    if (unavailable) {
      inUnavailable = true;
      const key = unavailable[1].toLowerCase() === 'injured' ? 'injuries' : 'scratched';
      if (result[key] !== null) errors.push(`NHL_PERSONNEL_DUPLICATE_${key.toUpperCase()}_SECTION`);
      const names = parseNames(unavailable[2]);
      if (names === null) { errors.push('NHL_PERSONNEL_UNAVAILABLE_LIST_INVALID'); continue; }
      result[key] = names.map(raw => {
        const match = raw.match(/^(.+?)(?:\s*\(([^()]*)\))?$/);
        const player = match && resolvePlayer(match[1].trim(), roster, teamId);
        if (!player) {
          result.unresolvedAvailability.push({ name: match?.[1]?.trim() || raw, reason: match?.[2]?.trim() || null, category: key, status: 'IDENTITY_UNRESOLVED' });
          warnings.push('NHL_PERSONNEL_AVAILABILITY_IDENTITY_UNRESOLVED');
        } else if (seen.has(player.playerId)) errors.push(`NHL_PERSONNEL_DUPLICATE_PLAYER:${player.playerId}`);
        else seen.add(player.playerId);
        return player && { ...player, ...sourceFields, status: key === 'injuries' ? 'REPORTED_INJURED' : 'PROJECTED_SCRATCH', reason: match[2]?.trim() || null };
      }).filter(Boolean);
      continue;
    }
    if (inUnavailable || !text) continue;
    const names = text.split(/\s+(?:--|–|—)\s+/).map(name => name.trim());
    if (names.length === 3) result.lineCombinations.push(names.map(name => resolve(name, ['C', 'L', 'R', 'LW', 'RW', 'F'])).filter(Boolean));
    else if (names.length === 2) result.defensivePairings.push(names.map(name => resolve(name, ['D'])).filter(Boolean));
    else {
      const player = resolve(text, ['G']);
      if (player) result.listedGoalies.push(player);
    }
  }
  if (result.lineCombinations.length !== 4 || result.lineCombinations.some(row => row.length !== 3)
    || result.defensivePairings.length !== 3 || result.defensivePairings.some(row => row.length !== 2)
    || result.listedGoalies.length !== 2) warnings.push('NHL_PERSONNEL_NONSTANDARD_OR_PARTIAL_LINEUP');
  if (result.injuries === null) warnings.push('NHL_PERSONNEL_INJURY_SECTION_MISSING');
  if (result.scratched === null) warnings.push('NHL_PERSONNEL_SCRATCH_SECTION_MISSING');
  const first = result.listedGoalies[0];
  if (first && !errors.length) {
    const confirmed = explicitConfirmedGoalies(statusReports, result.listedGoalies, roster);
    if (confirmed.length > 1) errors.push('NHL_PERSONNEL_MULTIPLE_CONFIRMED_GOALIES');
    else {
      const starter = confirmed[0] || first;
      result.goalie = { ...starter, ...sourceFields, gameId: String(game.gameId), side, status: confirmed.length ? 'CONFIRMED' : 'PROJECTED', confirmationExplicit: confirmed.length === 1,
        confirmationBasis: confirmed.length ? 'EXPLICIT_CURRENT_GAME_START_STATEMENT' : 'FIRST_LISTED_OFFICIAL_PROJECTED_GOALIE' };
    }
  }
  if (!result.goalie.confirmationExplicit) warnings.push('NHL_PERSONNEL_GOALIE_NOT_EXPLICITLY_CONFIRMED');
  if (errors.length) {
    // A malformed/ambiguous team block is quarantined as a unit; partial names
    // must not silently masquerade as a complete verified lineup.
    return { teamId, lineupStatus: 'BLOCK', lineCombinations: [], defensivePairings: [], listedGoalies: [], injuries: null, scratched: null,
      goalie: unknownGoalie(), issues: [...new Set(errors)], warnings, unverifiedSourceRows: texts.length };
  }
  return result;
}

function allowedRosterSource(url, abbrev, season) {
  return typeof abbrev === 'string' && url === `https://api-web.nhle.com/v1/roster/${abbrev.toUpperCase()}/${season}`;
}

function allowedIdentitySource(source, abbrev, game) {
  return source && typeof source.contentHash === 'string' && /^[a-f0-9]{64}$/.test(source.contentHash) && timestamp(source.fetchedAt)
    && (allowedRosterSource(source.url, abbrev, game.season)
      || source.url === `https://api-web.nhle.com/v1/club-stats/${abbrev}/${game.season}/${game.gameType}`);
}

export function mergeNhlPersonnelIdentitySources(roster, clubStats, game, side) {
  const teamId = game?.[`${side}TeamId`];
  const abbrev = game?.[side]?.abbrev || game?.[`${side}Abbrev`];
  const sources = [];
  const rows = [];
  if (roster?.ok && Array.isArray(roster.players) && roster.teamId === teamId && allowedRosterSource(roster.source?.url, abbrev, game?.season)) {
    sources.push(roster.source);
    rows.push(...roster.players.map(player => ({ ...player, identitySources: [roster.source], membershipBasis: 'OFFICIAL_SEASON_ROSTER_AND_ARTICLE_TEAM_BLOCK' })));
  }
  if (clubStats?.ok && clubStats.teamId === teamId && clubStats.season === game?.season && clubStats.gameType === game?.gameType
    && clubStats.source?.url === `https://api-web.nhle.com/v1/club-stats/${abbrev}/${game.season}/${game.gameType}`) {
    sources.push(clubStats.source);
    for (const [kind, players] of [['skaters', clubStats.skaters], ['goalies', clubStats.goalies]]) {
      for (const player of Array.isArray(players) ? players : []) rows.push({
        playerId: player.playerId, teamId, name: [player.firstName?.default || player.firstName, player.lastName?.default || player.lastName].filter(Boolean).join(' '),
        position: kind === 'goalies' ? 'G' : player.positionCode,
        identitySources: [clubStats.source], membershipBasis: 'OFFICIAL_SEASON_PARTICIPATION_AND_ARTICLE_TEAM_BLOCK',
      });
    }
  }
  const players = new Map(); const conflicts = new Set();
  for (const player of rows) {
    if (!Number.isSafeInteger(player.playerId) || player.playerId <= 0 || !player.name || player.teamId !== teamId) continue;
    const before = players.get(player.playerId);
    if (before && (normalized(before.name) !== normalized(player.name) || before.position !== player.position)) conflicts.add(player.playerId);
    else if (before) before.identitySources.push(...player.identitySources);
    else players.set(player.playerId, player);
  }
  // Identity conflicts stay explicitly invalid and are not silently resolved by
  // preferring whichever source happened to arrive first.
  for (const playerId of conflicts) players.set(playerId, { ...players.get(playerId), name: null });
  return { ok: sources.length > 0 && conflicts.size === 0, teamId, abbrev, season: game?.season,
    source: roster?.ok ? roster.source : sources[0] || null,
    identitySources: sources, players: [...players.values()], identityConflicts: [...conflicts] };
}

// Only a narrow affirmative present-game clause can promote a projected goalie.
// "expected", "could", future/previous games and negated clauses never confirm.
// No final boxscore fields are read anywhere in this module.
function explicitConfirmedGoalies(texts, listedGoalies, roster) {
  const matches = [];
  for (const player of listedGoalies) {
    const full = normalized(player.name);
    const last = full.split(' ').at(-1);
    const uniqueLast = (Array.isArray(roster?.players) ? roster.players : []).filter(row => normalized(row?.name).split(' ').at(-1) === last).length === 1;
    for (const text of texts) {
      // Keep sentence terminators until questions have been excluded. Splitting
      // on '?' first turns "Andersen will start?" into a false confirmation.
      for (const clause of normalized(text).match(/[^.!?…。！？]+[.!?…。！？]*/gu) || []) {
        if (/[?？]/u.test(clause)) continue;
        const sentence = clause.replace(/[.!…。！]+$/u, '').trim();
        if (/\b(not|won't|would|could|might|may|expected|projected|likely|probable|if|yesterday|tomorrow|last|previous|next|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december)\b|\bgame\s+\d|\d{4}-\d\d-\d\d/.test(sentence)) continue;
        const escaped = [full, ...(uniqueLast ? [last] : [])].map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        const name = `(?:${escaped.join('|')})`;
        // Require the affirmative clause to end here or with today/tonight.
        // "will start against [different opponent]" and "for Game 7" must not
        // be attached to the current article's Game 6 by sentence proximity.
        // Require the whole direct declaration, not a trailing clause preceded
        // by "perhaps", "unconfirmed", or an unverified attribution.
        if (new RegExp(`^${name} (?:will start|starts|will get the start|will make the start)(?: in goal| in net)?(?: tonight| today)?$`).test(sentence)) matches.push(player);
      }
    }
  }
  return [...new Map(matches.map(player => [player.playerId, player])).values()];
}

export function parseNhlLineupArticle(html, { game, rosters = {}, sourceUrl, observedAt, now = Date.now(), maxAgeMs = 6 * 60 * 60_000 } = {}) {
  const base = { league: 'NHL', leagueId: 'NHL', gameId: String(game?.gameId || ''), version: NHL_PERSONNEL_FEED_VERSION, matched: false, teams: {}, players: [], goalies: { away: unknownGoalie(), home: unknownGoalie() }, pointInTimeEligible: false };
  const blocked = (code, extras = {}) => ({ ...base, ...issue(code), status: 'BLOCK', qa: { status: 'BLOCK', issues: [code], warnings: [] }, ...extras });
  if (!validateNhlIdentity(game).ok) return blocked('NHL_PERSONNEL_GAME_IDENTITY_INVALID');
  if (!rosters || typeof rosters !== 'object' || Array.isArray(rosters)) return blocked('NHL_PERSONNEL_ROSTERS_INVALID');
  if (!allowedNhlPersonnelUrl(sourceUrl)) return blocked('NHL_PERSONNEL_SOURCE_NOT_ALLOWED');
  if (!timestamp(observedAt) || !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0 || Date.parse(observedAt) > now) return blocked('NHL_PERSONNEL_CLOCK_INVALID');
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 2_000_000) return blocked('NHL_PERSONNEL_ARTICLE_INVALID');
  const $ = load(html);
  if ($('link[rel="canonical"]').attr('href') !== sourceUrl) return blocked('NHL_PERSONNEL_CANONICAL_IDENTITY_MISMATCH');
  const metadata = articleMetadata($);
  const publishedAt = timestamp(metadata?.datePublished);
  const modifiedAt = metadata?.dateModified == null ? null : timestamp(metadata.dateModified);
  if (!metadata || !publishedAt || (metadata.dateModified != null && !modifiedAt) || (modifiedAt && Date.parse(modifiedAt) < Date.parse(publishedAt))) return blocked('NHL_PERSONNEL_PUBLICATION_TIME_INVALID');
  const availableAt = modifiedAt || publishedAt;
  const source = { provider: 'NHL_EDITORIAL', url: sourceUrl, sourcePublishedAt: publishedAt, sourceUpdatedAt: modifiedAt, availableAt, observedAt: timestamp(observedAt), fetchedAt: timestamp(observedAt), contentHash: hash(html) };
  if (Date.parse(availableAt) > Date.parse(observedAt)) return blocked('NHL_PERSONNEL_SOURCE_FROM_FUTURE', { source });
  const main = $('article.nhl-c-article');
  if (main.length !== 1) return blocked('NHL_PERSONNEL_ARTICLE_SCHEMA_CHANGED', { source });
  const blocks = [];
  main.find('.oc-c-markdown-stories').each((_, container) => {
    $(container).children('h2,h3,h4,p').each((__, element) => blocks.push({ tag: element.tagName?.toLowerCase(), text: $(element).text().replace(/\s+/g, ' ').trim() }));
  });
  const observedMatchups = blocks.filter(block => block.tag === 'h2' && /\s+at\s+/i.test(block.text)).map(block => ({ label: block.text, officialDate: officialDate(availableAt) }));
  const expectedDate = game.officialDate || game.northAmericaDate;
  if (!validNhlDate(expectedDate) || officialDate(availableAt) !== expectedDate) return { ...base, ok: true, status: 'NO_MATCHING_GAME', source, observedMatchups,
    qa: { status: 'WARNING', issues: [], warnings: ['NHL_PERSONNEL_ARTICLE_DATE_DOES_NOT_MATCH_GAME'] } };
  const headings = blocks.map((block, index) => block.tag === 'h2' && matchingGameHeading(block.text, game) ? index : -1).filter(index => index >= 0);
  if (headings.length !== 1) return headings.length > 1 ? blocked('NHL_PERSONNEL_DUPLICATE_MATCHUP', { source })
    : { ...base, ok: true, status: 'NO_MATCHING_GAME', source, observedMatchups, qa: { status: 'WARNING', issues: [], warnings: ['NHL_PERSONNEL_GAME_NOT_IN_ARTICLE'] } };
  const end = blocks.findIndex((block, index) => index > headings[0] && block.tag === 'h2');
  const section = blocks.slice(headings[0] + 1, end < 0 ? undefined : end);
  const starts = {};
  for (const side of ['away', 'home']) {
    const indices = section.map((row, index) => {
      const label = row.text.match(/^(.+?) projected lineup$/i);
      return label && matchesTeam(label[1], teamAliases(game, side)) ? index : -1;
    }).filter(index => index >= 0);
    if (indices.length !== 1) return blocked('NHL_PERSONNEL_TEAM_SECTION_MISSING_OR_DUPLICATE', { source });
    starts[side] = indices[0];
  }
  if (starts.away >= starts.home) return blocked('NHL_PERSONNEL_TEAM_SECTION_ORDER_CONFLICT', { source });
  const reportAt = section.findIndex(row => /^status report$/i.test(row.text));
  const reports = reportAt >= 0 ? section.slice(reportAt + 1).map(row => row.text) : [];
  if (Object.values(rosters).some(roster => (Array.isArray(roster?.identitySources) ? roster.identitySources : [roster?.source]).some(row => timestamp(row?.fetchedAt) && Date.parse(row.fetchedAt) > now))) return blocked('NHL_PERSONNEL_IDENTITY_SOURCE_FROM_FUTURE', { source });
  const teams = {};
  for (const side of ['away', 'home']) {
    const stop = side === 'away' ? starts.home : reportAt >= 0 ? reportAt : section.length;
    teams[side] = parseTeamRows(section.slice(starts[side] + 1, stop).map(row => row.text), rosters[side], game[`${side}TeamId`], source, side, game, reports);
  }
  const errors = [...new Set(Object.values(teams).flatMap(team => team.issues))];
  if (Object.values(teams).some(team => team.unresolvedAvailability?.length)) errors.push('NHL_PERSONNEL_AVAILABILITY_IDENTITY_UNRESOLVED');
  const warnings = [...new Set(Object.values(teams).flatMap(team => team.warnings))];
  const ageSeconds = Math.floor((now - Date.parse(availableAt)) / 1000);
  const fresh = now - Date.parse(availableAt) <= maxAgeMs;
  const identitySources = Object.values(rosters).flatMap(roster => Array.isArray(roster?.identitySources) ? roster.identitySources : (roster?.source ? [roster.source] : []));
  const pointInTimeEligible = !errors.length && Date.parse(availableAt) <= Date.parse(game.startTimeUTC) && Date.parse(observedAt) <= Date.parse(game.startTimeUTC)
    && identitySources.length >= 2 && identitySources.every(source => timestamp(source.fetchedAt) && Date.parse(source.fetchedAt) <= Date.parse(game.startTimeUTC));
  if (!fresh) warnings.push('NHL_PERSONNEL_SOURCE_STALE');
  if (!pointInTimeEligible) warnings.push('NHL_PERSONNEL_RETROSPECTIVE_NOT_PREGAME_PIT');
  const players = Object.values(teams).flatMap(team => [...team.lineCombinations.flat(), ...team.defensivePairings.flat(), ...team.listedGoalies, ...(team.injuries || []), ...(team.scratched || [])]);
  if (new Set(players.map(player => player.playerId)).size !== players.length) return blocked('NHL_PERSONNEL_CROSS_TEAM_PLAYER_CONFLICT', { source });
  const semantic = value => Array.isArray(value) ? value.map(semantic) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter(([key]) => !['observedAt', 'fetchedAt', 'identitySources', 'source'].includes(key)).map(([key, item]) => [key, semantic(item)])) : value;
  const revision = hash({ gameId: base.gameId, availableAt, teams: semantic(teams) });
  return { ...base, matched: true, ok: true, status: errors.length ? 'PARTIAL' : warnings.length ? 'WARNING' : 'OK', teams, players, goalies: { away: teams.away.goalie, home: teams.home.goalie }, source, observedMatchups,
    pointInTimeEligible, identitySources, freshness: { fresh, ageSeconds, maxAgeMs, basis: 'ARTICLE_LAST_PUBLISHED_REVISION_NOT_FETCH_TIME' }, revision,
    qa: { status: errors.length ? 'BLOCK' : warnings.length ? 'WARNING' : 'PASS', issues: errors, warnings } };
}

// Roster acquisition is provided by the existing official data layer, avoiding
// a data.js circular import or a second identity implementation.
export async function fetchNhlPersonnel(game, { rosters, loadRoster, fetchImpl = globalThis.fetch, now = Date.now, sourceUrl = nhlPersonnelArticleUrl(game?.season), ...options } = {}) {
  if (!validateNhlIdentity(game).ok) return issue('NHL_PERSONNEL_GAME_IDENTITY_INVALID');
  const article = await fetchNhlPersonnelArticle(sourceUrl, { ...options, fetchImpl, now });
  if (!article.ok) return { ...article, gameId: String(game.gameId), qa: { status: 'WARNING', issues: [], warnings: [article.code] } };
  // A known non-matching rolling date requires no extra roster network calls.
  const probe = parseNhlLineupArticle(article.html, { game, sourceUrl, observedAt: article.source.observedAt, rosters: {}, now: now(), maxAgeMs: options.maxAgeMs });
  if (probe.status === 'NO_MATCHING_GAME' || ['NHL_PERSONNEL_CLOCK_INVALID', 'NHL_PERSONNEL_PUBLICATION_TIME_INVALID', 'NHL_PERSONNEL_SOURCE_FROM_FUTURE', 'NHL_PERSONNEL_ARTICLE_SCHEMA_CHANGED'].includes(probe.code)) return probe;
  let resolved = rosters;
  if (!resolved && typeof loadRoster === 'function') {
    const rows = await Promise.all(['away', 'home'].map(async side => {
      try { return await loadRoster(game[side], game.season, side); } catch { return null; }
    }));
    resolved = { away: rows[0], home: rows[1] };
  }
  return parseNhlLineupArticle(article.html, { game, sourceUrl, observedAt: article.source.observedAt, rosters: resolved || {}, now: now(), maxAgeMs: options.maxAgeMs });
}

export function compareNhlPersonnelVersions(previous, incoming) {
  if (!previous) return { ok: true, changed: false, playerChanged: false, previousRevision: null, revision: incoming?.revision || null };
  if (previous.leagueId !== 'NHL' || incoming?.leagueId !== 'NHL' || previous.gameId !== incoming.gameId || !previous.matched || !incoming.matched || !previous.ok || !incoming.ok
    || ['away', 'home'].some(side => previous.teams?.[side]?.lineupStatus === 'BLOCK' || incoming.teams?.[side]?.lineupStatus === 'BLOCK')
    || !timestamp(previous.source?.availableAt) || !timestamp(incoming.source?.availableAt)
    || Date.parse(incoming.source.availableAt) < Date.parse(previous.source.availableAt)) return { ok: false, changed: false, issue: 'NHL_PERSONNEL_VERSION_IDENTITY_OR_ORDER_CONFLICT' };
  return { ok: true, changed: previous.revision !== incoming.revision,
    playerChanged: ['away', 'home'].some(side => previous.goalies?.[side]?.playerId !== incoming.goalies?.[side]?.playerId),
    goalieStatusChanged: ['away', 'home'].some(side => previous.goalies?.[side]?.status !== incoming.goalies?.[side]?.status),
    sourceRevisionChanged: previous.source.availableAt !== incoming.source.availableAt,
    previousRevision: previous.revision || null, revision: incoming.revision || null };
}
