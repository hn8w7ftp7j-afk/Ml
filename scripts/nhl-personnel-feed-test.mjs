import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { allowedNhlPersonnelUrl, nhlPersonnelArticleUrl, parseNhlLineupArticle, fetchNhlPersonnelArticle, fetchNhlPersonnel, compareNhlPersonnelVersions, mergeNhlPersonnelIdentitySources } from '../lib/nhl/personnel-feed.js';

const facts = JSON.parse(await readFile(new URL('./fixtures/nhl/personnel-official-20260614-facts.json', import.meta.url), 'utf8'));
const game = facts.game;
// The HTML envelope is a parser fixture built from live official factual rows,
// not a purported archived original page. Synthetic scenario edits below never
// enter Production storage or historical validation samples.
const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function article(data = facts, report = '', metadata = {}) {
  const team = side => `<p>${data[side].heading} projected lineup</p>${[...data[side].lines, ...data[side].pairs].map(row => `<p>${esc(row.join(' -- '))}</p>`).join('')}${data[side].goalies.map(name => `<p>${esc(name)}</p>`).join('')}<p>Scratched: ${esc(data[side].scratched.join(', ') || 'None')}</p><p>Injured: ${esc(data[side].injured.map(row => `${row[0]} (${row[1]})`).join(', ') || 'None')}</p>`;
  return `<html><head><link rel="canonical" href="${data.sourceUrl}"><script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', datePublished: data.sourcePublishedAt, dateModified: data.sourceUpdatedAt, ...metadata })}</script></head><body><article class="nhl-c-article"><div class="oc-c-markdown-stories"><h2>(1M) HURRICANES at (1P) GOLDEN KNIGHTS</h2>${team('away')}${team('home')}<p>Status report</p><p>${esc(report)}</p></div></article></body></html>`;
}
function identities(data = facts) {
  return Object.fromEntries(['away', 'home'].map(side => {
    const teamId = data.game[`${side}TeamId`];
    const roster = { ok: true, teamId, source: data[side].rosterSource, players: data[side].rosterPlayers.map(([playerId, name, position]) => ({ playerId, teamId, name, position })) };
    const club = { ok: true, teamId, season: data.game.season, gameType: data.game.gameType, source: data[side].clubSource, skaters: [], goalies: [] };
    for (const [playerId, name, position] of data[side].additionalClubPlayers) {
      const names = name.split(' '); const row = { playerId, firstName: { default: names.shift() }, lastName: { default: names.join(' ') }, positionCode: position };
      club[position === 'G' ? 'goalies' : 'skaters'].push(row);
    }
    return [side, mergeNhlPersonnelIdentitySources(roster, club, data.game, side)];
  }));
}
const now = Date.parse('2026-09-06T20:00:00Z');
const opts = { game, rosters: identities(), sourceUrl: facts.sourceUrl, observedAt: new Date(now).toISOString(), now };
const html = article();
const parsed = parseNhlLineupArticle(html, opts);
assert.equal(parsed.ok, true); assert.equal(parsed.matched, true); assert.equal(parsed.league, 'NHL');
assert.equal(parsed.teams.away.lineCombinations.length, 4); assert.equal(parsed.teams.home.lineCombinations.length, 4);
assert.equal(parsed.teams.away.defensivePairings.length, 3); assert.equal(parsed.teams.home.defensivePairings.length, 3);
assert.equal(parsed.goalies.away.playerId, 8483548); assert.equal(parsed.goalies.home.playerId, 8479394);
assert.equal(parsed.goalies.away.status, 'PROJECTED'); assert.equal(parsed.goalies.home.confirmationExplicit, false);
assert.equal(parsed.teams.home.injuries[0].playerId, 8476448); assert.equal(parsed.teams.home.injuries[0].reason, 'upper body');
assert.deepEqual(parsed.teams.away.injuries, []);
assert.equal(parsed.teams.home.unresolvedAvailability.length, 3);
assert.ok(parsed.teams.home.unresolvedAvailability.some(row => row.name === 'Kaeden Korczak'));
assert.equal(parsed.status, 'PARTIAL'); assert.equal(parsed.qa.status, 'BLOCK');
assert.equal(parsed.pointInTimeEligible, false); assert.equal(parsed.freshness.fresh, false);
assert.equal(parsed.source.sourcePublishedAt, '2026-06-14T15:45:00.000Z');
assert.equal(parsed.source.availableAt, '2026-06-14T15:54:51.163Z');
assert.equal(parsed.identitySources.length, 4); assert.ok(parsed.players.every(row => row.identitySources.every(source => source.contentHash && source.url && source.fetchedAt)));
assert.equal(parsed.teams.away.listedGoalies[1].membershipBasis, 'OFFICIAL_SEASON_PARTICIPATION_AND_ARTICLE_TEAM_BLOCK');

const again = parseNhlLineupArticle(html.replace('</body>', '<p>Changed unrelated latest news</p></body>'), { ...opts, observedAt: new Date(now + 5000).toISOString(), now: now + 5000 });
assert.equal(again.revision, parsed.revision);
assert.equal(compareNhlPersonnelVersions(parsed, again).changed, false);
assert.equal(compareNhlPersonnelVersions(parsed, again).playerChanged, false);

const mismatch = parseNhlLineupArticle(html, { ...opts, game: { ...game, officialDate: '2026-06-15' } });
assert.equal(mismatch.status, 'NO_MATCHING_GAME'); assert.equal(mismatch.ok, true); assert.equal(mismatch.matched, false);
assert.deepEqual(mismatch.players, []); assert.equal(mismatch.observedMatchups[0].officialDate, '2026-06-14');
assert.equal(parseNhlLineupArticle(html.replace('HURRICANES at (1P) GOLDEN KNIGHTS', 'GOLDEN KNIGHTS at HURRICANES'), opts).status, 'NO_MATCHING_GAME');
assert.equal(parseNhlLineupArticle(html.replace('</div>', '<h2>HURRICANES at GOLDEN KNIGHTS</h2></div>'), opts).code, 'NHL_PERSONNEL_DUPLICATE_MATCHUP');
assert.equal(parseNhlLineupArticle(html, { ...opts, game: { ...game, league: 'NBA' } }).code, 'NHL_PERSONNEL_GAME_IDENTITY_INVALID');
assert.equal(parseNhlLineupArticle(html.replace(facts.sourceUrl, 'https://attacker.example/news/'), opts).code, 'NHL_PERSONNEL_CANONICAL_IDENTITY_MISMATCH');
assert.equal(parseNhlLineupArticle(article(facts, '', { dateModified: '2026-09-07T00:00:00Z' }), opts).code, 'NHL_PERSONNEL_SOURCE_FROM_FUTURE');
assert.equal(parseNhlLineupArticle(article(facts, '', { datePublished: '2026-02-30T00:00:00Z' }), opts).code, 'NHL_PERSONNEL_PUBLICATION_TIME_INVALID');
const evergreen = parseNhlLineupArticle(article(facts, '', { datePublished: '2025-10-01T12:00:00Z' }), opts);
assert.equal(evergreen.matched, true); assert.equal(evergreen.source.availableAt, parsed.source.availableAt);

const ambiguous = structuredClone(opts.rosters); ambiguous.away.players.push({ ...ambiguous.away.players[0], playerId: 9999999 });
const ambiguity = parseNhlLineupArticle(html, { ...opts, rosters: ambiguous });
assert.equal(ambiguity.teams.away.lineupStatus, 'BLOCK'); assert.deepEqual(ambiguity.teams.away.lineCombinations, []);
assert.equal(ambiguity.goalies.away.status, 'UNKNOWN'); assert.equal(ambiguity.teams.home.lineCombinations.length, 4);
assert.equal(compareNhlPersonnelVersions(parsed, ambiguity).ok, false);
const badSource = structuredClone(opts.rosters); badSource.away.identitySources[0].contentHash = null;
assert.equal(parseNhlLineupArticle(html, { ...opts, rosters: badSource }).teams.away.lineupStatus, 'BLOCK');
assert.equal(parseNhlLineupArticle(html, { ...opts, rosters: null }).code, 'NHL_PERSONNEL_ROSTERS_INVALID');
const malformedRoster = structuredClone(opts.rosters); malformedRoster.away.players = { wrong: true };
assert.equal(parseNhlLineupArticle(html, { ...opts, rosters: malformedRoster }).teams.away.lineupStatus, 'BLOCK');
const futureRoster = structuredClone(opts.rosters); futureRoster.away.identitySources[0].fetchedAt = '2026-09-07T00:00:00Z';
assert.equal(parseNhlLineupArticle(html, { ...opts, rosters: futureRoster }).code, 'NHL_PERSONNEL_IDENTITY_SOURCE_FROM_FUTURE');
const duplicate = structuredClone(facts); duplicate.away.lines[0][0] = duplicate.away.lines[0][1];
assert.equal(parseNhlLineupArticle(article(duplicate), opts).teams.away.lineupStatus, 'BLOCK');
const wrongPosition = structuredClone(opts.rosters); wrongPosition.home.players.find(row => row.playerId === 8479394).position = 'C';
assert.equal(parseNhlLineupArticle(html, { ...opts, rosters: wrongPosition }).goalies.home.status, 'UNKNOWN');

// Explicit confirmation is synthetic parser QA, not a claim that this historical
// article confirmed a starter. The genuine article above remains PROJECTED.
const confirmed = parseNhlLineupArticle(article(facts, 'Frederik Andersen will start in goal tonight.'), opts);
assert.equal(confirmed.goalies.away.playerId, 8475883); assert.equal(confirmed.goalies.away.status, 'CONFIRMED');
const change = compareNhlPersonnelVersions(parsed, confirmed);
assert.equal(change.changed, true); assert.equal(change.playerChanged, true); assert.equal(change.goalieStatusChanged, true);
for (const statement of ['Andersen will not start in goal tonight.', 'Andersen could start in goal tonight.', 'Andersen is expected to start in goal tonight.', 'Andersen will start in goal tomorrow.', 'If healthy Andersen will start in goal.', 'Andersen is projected, Bussi will start in goal.', 'Andersen will start in goal next game.', 'Andersen will start for Game 7.', 'Andersen will start against Boston.', 'Wednesday Andersen will start in goal.']) {
  assert.equal(parseNhlLineupArticle(article(facts, statement), opts).goalies.away.status, 'PROJECTED', statement);
}
const twoConfirmed = parseNhlLineupArticle(article(facts, 'Andersen will start in goal. Bussi will start in goal.'), opts);
assert.equal(twoConfirmed.goalies.away.status, 'UNKNOWN');

// Completing acquisition after puck drop cannot be turned into PIT evidence by
// stamping the HTTP request start as the fetch time.
let clock = Date.parse('2026-06-14T23:59:59Z');
const late = await fetchNhlPersonnelArticle(facts.sourceUrl, { now: () => clock, fetchImpl: async () => ({ ok: true, url: facts.sourceUrl, text: async () => { clock += 2000; return html; } }) });
assert.equal(late.source.requestedAt, '2026-06-14T23:59:59.000Z');
assert.equal(late.source.observedAt, '2026-06-15T00:00:01.000Z');
const pitRosters = identities();
for (const roster of Object.values(pitRosters)) for (const source of roster.identitySources) source.fetchedAt = '2026-06-14T16:00:00Z';
const lateParsed = parseNhlLineupArticle(late.html, { ...opts, rosters: pitRosters, observedAt: late.source.observedAt, now: clock });
assert.equal(lateParsed.pointInTimeEligible, false);

let calls = 0;
const fetchImpl = async () => { calls++; return { ok: true, url: facts.sourceUrl, text: async () => html }; };
const fetchOptions = { fetchImpl, now: () => now };
const [a, b] = await Promise.all([fetchNhlPersonnelArticle(facts.sourceUrl, fetchOptions), fetchNhlPersonnelArticle(facts.sourceUrl, fetchOptions)]);
assert.equal(calls, 1); a.source.url = 'corrupt'; assert.equal(b.source.url, facts.sourceUrl);
assert.equal((await fetchNhlPersonnelArticle(facts.sourceUrl, fetchOptions)).cached, true);
for (const status of [403, 404, 409, 429, 500, 302]) {
  let requests = 0; const broken = async () => { requests++; return { ok: false, status }; };
  const x = await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: broken, now: () => now });
  const y = await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: broken, now: () => now });
  assert.equal(x.ok, false); assert.equal(y.cached, true); assert.equal(requests, 1);
}

// Fake-clock transport tests: no official request or real waiting occurs.
const retryTestUrl = 'https://www.nhl.com/news/retry-policy-test';
{
  let clock = now; let requests = 0;
  const fetchImpl = async (url, options) => {
    requests++; assert.equal(options.redirect, 'manual');
    return requests === 1 ? { ok: false, status: 429, url, headers: new Headers({ 'Retry-After': '120' }) }
      : { ok: true, status: 200, url, text: async () => html };
  };
  const options = { fetchImpl, now: () => clock };
  const first = await fetchNhlPersonnelArticle(facts.sourceUrl, options);
  assert.equal(first.code, 'NHL_PERSONNEL_RATE_LIMITED'); assert.equal(first.retryAfter, '120');
  assert.equal(first.retryAt, new Date(now + 120_000).toISOString()); assert.equal(first.rateLimitSourceUrl, facts.sourceUrl);
  clock += 31_000;
  const blocked = await fetchNhlPersonnelArticle(retryTestUrl, options);
  assert.equal(blocked.attempts, 0); assert.equal(blocked.hostCooldown, true); assert.equal(blocked.retryAt, first.retryAt);
  assert.equal(blocked.source.fetchedAt, undefined); assert.equal(blocked.source.observedAt, undefined); assert.equal(requests, 1);
  assert.equal((await fetchNhlPersonnelArticle(facts.sourceUrl, options)).cached, true);
  clock = now + 120_000;
  assert.equal(requests, 1, 'expiry never automatically initiates another source request');
  assert.equal((await fetchNhlPersonnelArticle(facts.sourceUrl, options)).ok, true); assert.equal(requests, 2);
}
{
  for (const [header, duration] of [[new Date(now + 90_000).toUTCString(), 90_000], [null, 60_000], ['bad-header', 60_000]]) {
    let clock = now; let requests = 0;
    const fetchImpl = async url => { requests++; return { ok: false, status: 429, url, headers: { get: () => header } }; };
    const options = { fetchImpl, now: () => clock };
    const limited = await fetchNhlPersonnelArticle(facts.sourceUrl, options);
    assert.equal(limited.retryAt, new Date(now + duration).toISOString()); assert.equal(limited.retryAfter, header);
    clock += duration - 1;
    assert.equal((await fetchNhlPersonnelArticle(retryTestUrl, options)).attempts, 0); assert.equal(requests, 1);
  }
  const independent = await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: async url => ({ ok: true, url, text: async () => html }), now: () => now });
  assert.equal(independent.ok, true);
}
{
  let clock = now; let requests = 0;
  const fetchImpl = async url => {
    requests++;
    return url === facts.sourceUrl ? { ok: true, url, text: async () => html }
      : { ok: false, url, status: 429, headers: new Headers({ 'Retry-After': '120' }) };
  };
  const options = { fetchImpl, now: () => clock, ttlMs: 180_000 };
  const success = await fetchNhlPersonnelArticle(facts.sourceUrl, options);
  clock += 1000; await fetchNhlPersonnelArticle(retryTestUrl, options);
  clock += 31_000;
  const retained = await fetchNhlPersonnelArticle(facts.sourceUrl, options);
  assert.equal(retained.ok, true); assert.equal(retained.cached, true); assert.deepEqual(retained.source, success.source); assert.equal(requests, 2);
}
{
  let requests = 0;
  for (const url of [`${facts.sourceUrl}#fragment`, `${facts.sourceUrl}#`, 'https://@www.nhl.com/news/test']) {
    assert.equal(allowedNhlPersonnelUrl(url), false);
    assert.equal((await fetchNhlPersonnelArticle(url, { fetchImpl: async () => { requests++; } })).code, 'NHL_PERSONNEL_SOURCE_NOT_ALLOWED');
  }
  assert.equal(requests, 0); assert.equal(allowedNhlPersonnelUrl('https://www.nhl.com:443/news/test'), true);
  for (const value of [{ ok: false, status: 302 }, { ok: true, redirected: true }, { ok: true, type: 'opaqueredirect' }, { ok: true, url: 'https://attacker.invalid/article' }]) {
    let attempts = 0;
    const result = await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: async (_url, options) => { attempts++; assert.equal(options.redirect, 'manual'); return value; } });
    assert.equal(result.code, value.url ? 'NHL_PERSONNEL_RESPONSE_URL_MISMATCH' : 'NHL_PERSONNEL_REDIRECT_NOT_FOLLOWED'); assert.equal(attempts, 1);
  }
}
for (const location of ['/errors/not-found', 'https://www.nhl.com/errors/not-found', 'https://attacker.invalid/errors/not-found', '/news/other-season']) {
  let requests = 0;
  const result = await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: async () => {
    requests++; return { ok: false, status: 302, headers: { get: key => key === 'location' ? location : null } };
  } });
  assert.equal(result.code, location === '/errors/not-found' || location === 'https://www.nhl.com/errors/not-found'
    ? 'NHL_PERSONNEL_ARTICLE_NOT_FOUND' : 'NHL_PERSONNEL_REDIRECT_NOT_FOLLOWED');
  assert.equal(requests, 1); assert.equal(result.ok, false); assert.equal(result.html, undefined);
}
assert.equal((await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: async () => ({ ok: false, status: 404 }) })).code, 'NHL_PERSONNEL_ARTICLE_NOT_FOUND');
const timeout = await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: async () => new Promise(() => {}), timeoutMs: 5, now: () => now });
assert.equal(timeout.code, 'NHL_PERSONNEL_TIMEOUT');
const bodyTimeout = await fetchNhlPersonnelArticle(facts.sourceUrl, { fetchImpl: async () => ({ ok: true, text: () => new Promise(() => {}) }), timeoutMs: 5, now: () => now });
assert.equal(bodyTimeout.code, 'NHL_PERSONNEL_TIMEOUT');
for (const url of ['http://www.nhl.com/news/test', 'https://attacker.example/news/test', 'https://www.nhl.com:444/news/test', 'https://secret@www.nhl.com/news/test', 'https://www.nhl.com/news/test?q=secret']) assert.equal(allowedNhlPersonnelUrl(url), false);
assert.equal(nhlPersonnelArticleUrl(20252026), facts.sourceUrl); assert.equal(nhlPersonnelArticleUrl(20252027), null);
let rosterCalls = 0;
const noMatch = await fetchNhlPersonnel({ ...game, officialDate: '2026-06-15' }, { ...fetchOptions, loadRoster: async () => { rosterCalls++; } });
assert.equal(noMatch.status, 'NO_MATCHING_GAME'); assert.equal(rosterCalls, 0);
const integrated = await fetchNhlPersonnel(game, { ...fetchOptions, loadRoster: async (_team, _season, side) => opts.rosters[side] });
assert.equal(integrated.teams.away.lineCombinations.length, 4); assert.equal(integrated.goalies.home.playerId, 8479394);

console.log(JSON.stringify({ ok: true, testGroups: 28, sourceRetryTestGroups: 4, actualEvidence: 'Official 2026-06-14 CAR@VGK lineup facts + official roster/club identity extracts', projectedGoalies: 2, verifiedForwardLines: 8, verifiedDefensivePairs: 6, unresolvedAvailability: 3, strictHistoricalPit: false, fixtureKind: facts.fixtureKind }));
