import { createHash, randomUUID } from 'node:crypto';
import * as cheerio from 'cheerio';
import { soccerDate, validSoccerDate } from './contracts.js';

export const SOCCER_TEAM_XG_VERSION = 'SOCCER-OPTA-TEAM-XG-v1';
export const SOCCER_TEAM_XG_SOURCE_URL = 'https://theanalyst.com/competition/premier-league/table?view=expected';
export const SOCCER_TEAM_XG_SEASON = '2026/2027';
export const SOCCER_TEAM_XG_COMPETITION = Object.freeze({ id: '2kwbbcootiqqgmrzs6o5inle5', code: 'EPL',
  name: 'Premier League', tournamentCalendarId: '6pdwluctev9iebv00r4qqukno' });
export const SOCCER_TEAM_XG_PROVIDERS = Object.freeze({
  epl: Object.freeze({ league: 'epl', sourceUrl: SOCCER_TEAM_XG_SOURCE_URL, season: SOCCER_TEAM_XG_SEASON,
    competition: SOCCER_TEAM_XG_COMPETITION, teamCount: 20, tab: 'expected', heading: 'Premier League Table',
    canonicalUrl: 'https://theanalyst.com/competition/premier-league/table' }),
  ucl: Object.freeze({ league: 'ucl', sourceUrl: 'https://theanalyst.com/competition/uefa-champions-league/table',
    season: SOCCER_TEAM_XG_SEASON, competition: Object.freeze({ id: '4oogyu6o156iphvdvphwpck10', code: 'UCL',
      name: 'Champions League', tournamentCalendarId: '99jev9kv55deht65t6myggxlg' }),
    teamCount: 36, tab: 'actual', heading: 'Champions League Table',
    canonicalUrl: 'https://theanalyst.com/competition/uefa-champions-league/table' }),
});
export const getSoccerTeamXgProvider = league => Object.hasOwn(SOCCER_TEAM_XG_PROVIDERS, league)
  ? SOCCER_TEAM_XG_PROVIDERS[league] : null;
export const SOCCER_TEAM_XG_MAX_BYTES = 2 * 1024 * 1024;
const TTL = 600000, TIMEOUT = 8000, cache = new WeakMap(), documents = new WeakMap();
const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? Date.parse(value) : NaN;
const numericId = value => typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value);

// Explicit ID correspondence reviewed against the actual provider table and
// ESPN's eng.1 teams response. Exact labels are additional consistency checks,
// never the lookup key. Provenance and retained IDs are in the opta-* fixtures.
const identities = [
  ['359','Arsenal','4dsgumo7d4zupm2ugsvm4zm4d','Arsenal','ARS'],
  ['382','Manchester City','a3nyxabgsqlnqfkeg41m6tnpp','Manchester City','MCI'],
  ['393','Nottingham Forest','1qtaiy11gswx327s0vkibf70n','Nottingham Forest','NFO'],
  ['331','Brighton & Hove Albion','e5p0ehyguld7egzhiedpdnc3w','Brighton & Hove Albion','BHA'],
  ['349','AFC Bournemouth','1pse9ta7a45pi2w2grjim70ge','Bournemouth','BOU'],
  ['364','Liverpool','c8h9bw1l82s06h77xxrelzhur','Liverpool','LIV'],
  ['337','Brentford','7yx5dqhhphyvfisohikodajhv','Brentford','BRE'],
  ['370','Fulham','hzqh7z0mdl3v7gwete66syxp','Fulham','FUL'],
  ['357','Leeds United','48gk2hpqtsl6p9sx9kjhaydq4','Leeds United','LEE'],
  ['367','Tottenham Hotspur','22doj4sgsocqpxw45h607udje','Tottenham Hotspur','TOT'],
  ['360','Manchester United','6eqit8ye8aomdsrrq0hk3v7gh','Manchester United','MUN'],
  ['363','Chelsea','9q0arba2kbnywth8bkxlhgmdr','Chelsea','CHE'],
  ['368','Everton','ehd2iemqmschhj2ec0vayztzz','Everton','EVE'],
  ['366','Sunderland','1r3545b2dzan8yqa80gtmcjch','Sunderland','SUN'],
  ['362','Aston Villa','b496gs285it6bheuikox6z9mj','Aston Villa','AVL'],
  ['373','Ipswich Town','8b523ujgl21tbc01me65q0aoh','Ipswich Town','IPS'],
  ['384','Crystal Palace','1c8m2ko0wxq1asfkuykurdr0y','Crystal Palace','CRY'],
  ['388','Coventry City','dacoc20k0n3fxu4zek8wufmko','Coventry City','COV'],
  ['306','Hull City','f0figafm2v9h8ofo6slajj7xf','Hull City','HUL'],
  ['361','Newcastle United','7vn2i2kd35zuetw6b38gw9jsz','Newcastle United','NEW'],
].map(([espnId,espnName,optaId,optaName,optaCode]) => Object.freeze({espnId,espnName,optaId,optaName,optaCode}));
const uclIdentities = [
  ["132","Bayern Munich","apoawtpvac4zqlancmvw4nk4o","Bayern München","FCB"],
  ["362","Aston Villa","b496gs285it6bheuikox6z9mj","Aston Villa","AVL"],
  ["382","Manchester City","a3nyxabgsqlnqfkeg41m6tnpp","Manchester City","MCI"],
  ["134","VfB Stuttgart","3dwlvz6cl4lcavvrg0y2dycrt","Stuttgart","VFB"],
  ["2572","Como","6uzfw7ahyxg4wrrfxo5u7qt0n","Como","COM"],
  ["244","Real Betis","ah8dala7suqqkj04n2l8xz4zd","Real Betis","BET"],
  ["86","Real Madrid","3kq9cckrnlogidldtdie2fkbl","Real Madrid","RMA"],
  ["359","Arsenal","4dsgumo7d4zupm2ugsvm4zm4d","Arsenal","ARS"],
  ["124","Borussia Dortmund","dt4pinj0vw0t0cvz7za6mhmzy","Borussia Dortmund","BVB"],
  ["83","Barcelona","agh9ifb2mw3ivjusgedj7c3fe","Barcelona","BAR"],
  ["2250","Sporting CP","7catg5lpivcmpf4xhggh6d8rk","Sporting CP","SCP"],
  ["160","Paris Saint-Germain","2b3mar72yy8d6uvat1ka6tn3r","Paris Saint-Germain","PSG"],
  ["364","Liverpool","c8h9bw1l82s06h77xxrelzhur","Liverpool","LIV"],
  ["494","Slavia Prague","8kpapuorr6hf0vosnovbreqqd","Slavia Praha","SLA"],
  ["104","AS Roma","2tk2l9sgktwc9jhzqdd4mpdtb","Roma","ROM"],
  ["360","Manchester United","6eqit8ye8aomdsrrq0hk3v7gh","Manchester United","MUN"],
  ["2980","Bodo/Glimt","ctvzi2jbl1q6xzq0s3sexj73g","Bodø / Glimt","BOD"],
  ["436","Fenerbahce","8lroq0cbhdxj8124qtxwrhvmm","Fenerbahçe","FB"],
  ["570","Club Brugge","1oyb7oym5nwzny8vxf03szd2h","Club Brugge","CLU"],
  ["148","PSV Eindhoven","24fvcruwqrqvqa3aonf8c3zuy","PSV","PSV"],
  ["887","AEK Athens","7ruua9q5rtswwi5d6xtquuto5","AEK Athens","AEK"],
  ["110","Internazionale","3vo5mpj7catp66nrwwqiuhuup","Internazionale","INT"],
  ["493","Shakhtar Donetsk","cf8plcmeniaen0fc5emyb5j93","Shakhtar Donetsk","SHK"],
  ["1068","Atlético Madrid","4ku8o6uf87yd8iecdalipo6wd","Atlético de Madrid","ATM"],
  ["175","Lens","3xedluek08t2ka7oypwuullcn","Lens","RCL"],
  ["166","Lille","be2k34rut1lz79jxenabttqlc","Lille","LIL"],
  ["114","Napoli","gi0l1habji5hpgar77dl5jqe","Napoli","NAP"],
  ["11420","RB Leipzig","9gefq4dz9b2hl8rqrxwrlrzmp","RB Leipzig","RBL"],
  ["102","Villarreal","74mcjsm72vr3l9pw2i4qfjchj","Villarreal","VIL"],
  ["437","FC Porto","66bsnl0zjb7l5akwo00h0y5me","Porto","POR"],
  ["432","Galatasaray","esa748l653sss1wurz5ps3228","Galatasaray","GS"],
  ["4411","LASK Linz","boxkkgnpn38ywao4kzu7dx58h","LASK","ASK"],
  ["142","Feyenoord Rotterdam","20vymiy7bo8wkyxai3ew494fz","Feyenoord","FEY"],
  ["21922","Sabah FK","evvhmz4bq4dq1v9llaev1j97u","Sabah","SAB"],
  ["510","Viking FK","bsykw9d70ffqe9atosc92n1e9","Viking","VIK"],
  ["521","Slovan Bratislava","cmj1019uptq8i042n5y16itbd","Slovan Bratislava","SLO"],
].map(([espnId,espnName,optaId,optaName,optaCode]) => Object.freeze({espnId,espnName,optaId,optaName,optaCode}));
const identityMaps = {
  epl: { byEspn: new Map(identities.map(value => [value.espnId, value])), byOpta: new Map(identities.map(value => [value.optaId, value])) },
  ucl: { byEspn: new Map(uclIdentities.map(value => [value.espnId, value])), byOpta: new Map(uclIdentities.map(value => [value.optaId, value])) },
};

export function unavailableSoccerTeamXg(reason = 'TEAM_XG_SOURCE_UNAVAILABLE', game) {
  return { ok: false, version: SOCCER_TEAM_XG_VERSION, status: 'UNKNOWN', code: reason, reason,
    league: game?.league || null, gameId: game?.id || null, date: game?.date || null, startTime: game?.startTime || null,
    season: getSoccerTeamXgProvider(game?.league)?.season || null, source: null, teams: null,
    modelEffectApplied: false, pointInTimeAvailabilityVerified: false, formalEligible: false, executable: false };
}

function requestFailure(game, now) {
  const provider = getSoccerTeamXgProvider(game?.league);
  if (!provider) return 'TEAM_XG_LEAGUE_UNSUPPORTED';
  const kickoff = instant(game?.startTime);
  if (!Number.isFinite(now) || !numericId(game?.sourceId)
    || game.id !== `soccer:${provider.league}:${game.sourceId}` || !validSoccerDate(game.date) || !Number.isFinite(kickoff)
    || soccerDate(game.startTime) !== game.date) return 'TEAM_XG_GAME_SCOPE_INVALID';
  if (game.status !== 'scheduled' || kickoff <= now) return 'TEAM_XG_NOT_PREMATCH';
  // This reviewed calendar and club map deliberately stops at the season end.
  // A newly fetched current table never fills a past season or a postgame input.
  const from = Date.parse('2026-07-01T00:00:00Z'), through = Date.parse('2027-07-01T00:00:00Z');
  if (now < from || now >= through || kickoff < from || kickoff >= through) return 'TEAM_XG_SEASON_UNSUPPORTED';
  for (const side of ['home','away']) {
    const team = game[side], mapping = identityMaps[provider.league].byEspn.get(team?.sourceId);
    if (!mapping || team.name !== mapping.espnName || team.id !== `soccer:${provider.league}:team:${mapping.espnId}`)
      return 'TEAM_XG_TEAM_IDENTITY_UNVERIFIED';
  }
  if (game.home.sourceId === game.away.sourceId) return 'TEAM_XG_TEAM_IDENTITY_UNVERIFIED';
  return null;
}

/** Pure parser; supplied timestamps are checked, but this cannot create a
 * private fetched-document proof or an archival/point-in-time approval. */
export function normalizeSoccerTeamXg(text, game, source, asOf = Date.now()) {
  const failure = code => unavailableSoccerTeamXg(code, game);
  const invalid = requestFailure(game, asOf);
  if (invalid) return failure(invalid);
  const provider = getSoccerTeamXgProvider(game.league);
  if (typeof text !== 'string' || !text || Buffer.byteLength(text, 'utf8') > SOCCER_TEAM_XG_MAX_BYTES)
    return failure('TEAM_XG_DOCUMENT_SIZE_INVALID');
  const times = [source?.requestedAt,source?.fetchedAt,source?.availableAt].map(instant);
  if (source?.provider !== 'OPTA_ANALYST' || source.url !== provider.sourceUrl
    || !/^[a-f0-9]{64}$/.test(source.contentHash || '') || source.contentHash !== digest(text)
    || !times.every(time => Number.isFinite(time) && time <= asOf)
    || times[0] > times[1] || times[1] !== times[2] || asOf - times[1] >= TTL)
    return failure('TEAM_XG_SOURCE_RECEIPT_INVALID');
  try {
    const $ = cheerio.load(text);
    if ($('link[rel="canonical"]').length !== 1
      || $('link[rel="canonical"]').attr('href') !== provider.canonicalUrl
      || $('h1').length !== 1 || $('h1').text().replace(/\s+/g, ' ').trim() !== provider.heading)
      return failure('TEAM_XG_COMPETITION_UNVERIFIED');
    const seasons = $('.hub-navigation-title-wrapper .hub-navigation-dropdown-button');
    if (seasons.length !== 1 || seasons.text().trim() !== provider.season) return failure('TEAM_XG_SEASON_UNVERIFIED');
    const containers = $('[data-wp-interactive="ta/league-tables"]');
    if (containers.length !== 1) return failure('TEAM_XG_TABLE_SCOPE_UNVERIFIED');
    const context = JSON.parse(containers.attr('data-wp-context'));
    if (context.tmcl !== provider.competition.tournamentCalendarId || context.sections?.expected !== 'expected'
      || context.tab !== provider.tab || context.type !== 'total' || context.group !== 0 || context.ctst !== null || context.full !== true)
      return failure('TEAM_XG_TABLE_SCOPE_UNVERIFIED');
    const states = [], competitions = [];
    for (const script of $('script:not([src])').toArray()) {
      const value = $(script).text();
      if ($(script).attr('type') === 'application/json') {
        const parsed = JSON.parse(value);
        if (parsed.state?.['ta/competition']) states.push(parsed);
      }
      for (const match of value.matchAll(/window\.sdapi\.competitions\s*=\s*(\[[^;]*?\]);/g)) competitions.push(JSON.parse(match[1]));
    }
    if (states.length !== 1 || competitions.length !== 1 || competitions[0].length !== 1)
      return failure('TEAM_XG_DOCUMENT_STATE_AMBIGUOUS');
    const competition = competitions[0][0], config = states[0].config?.['ta/competition'];
    if (competition.id !== provider.competition.id || competition.code !== provider.competition.code || competition.title !== provider.competition.name
      || competition.url !== provider.canonicalUrl.replace(/\/table$/, '')
      || config?.sports?.[context.tmcl] !== 'football') return failure('TEAM_XG_COMPETITION_UNVERIFIED');
    const state = states[0].state['ta/competition'].competitions;
    if (!state || Object.keys(state).length !== 1 || !Object.hasOwn(state, context.tmcl)) return failure('TEAM_XG_TABLE_SCOPE_UNVERIFIED');
    const expected = state[context.tmcl].expected, updated = instant(expected?.lastUpdated);
    if (!Number.isFinite(updated) || updated > times[1] || updated < Date.parse('2026-07-01T00:00:00Z'))
      return failure('TEAM_XG_UPDATE_TIME_UNVERIFIED');
    const rows = expected.rows;
    if (!Array.isArray(rows) || rows.length !== provider.teamCount) return failure('TEAM_XG_TEAM_COVERAGE_INVALID');
    const retained = new Map();
    for (const row of rows) {
      const mapping = identityMaps[provider.league].byOpta.get(row?.contestantId);
      if (!mapping || retained.has(mapping.espnId) || row.longName !== mapping.optaName || row.code !== mapping.optaCode
        || row.key !== `${mapping.optaId}:total:0` || row.view !== 'total:0') return failure('TEAM_XG_TEAM_IDENTITY_UNVERIFIED');
      if (!Number.isSafeInteger(row.played) || row.played < 0 || row.played > 38
        || [row.xG,row.xGA].some(value => typeof value !== 'string' || !/^(?:0|[1-9]\d{0,3})(?:\.\d)?$/.test(value)
          || !Number.isFinite(Number(value)) || Number(value) > 1000 || row.played === 0 && Number(value) !== 0))
        return failure('TEAM_XG_VALUES_INVALID');
      const xg = Number(row.xG), xga = Number(row.xGA);
      retained.set(mapping.espnId, { sourceId: mapping.espnId, optaId: mapping.optaId, name: mapping.espnName,
        played: row.played, xg, xga, xgPerMatch: row.played ? xg / row.played : null,
        xgaPerMatch: row.played ? xga / row.played : null });
    }
    const sourceUpdatedAt = new Date(updated).toISOString();
    return { ok: true, version: SOCCER_TEAM_XG_VERSION, status: 'PROVIDER_REPORTED', league: provider.league,
      gameId: game.id, date: game.date, startTime: game.startTime, season: provider.season,
      competition: { ...provider.competition }, teams: { home: retained.get(game.home.sourceId), away: retained.get(game.away.sourceId) },
      source: { ...source, sourcePublishedAt: null, sourceUpdatedAt,
        scope: { league: provider.league, gameId: game.id, field: 'season-team-xg' }, independentlyConfirmed: false,
        historicalAvailabilityVerified: false },
      sourceEvidence: { version: SOCCER_TEAM_XG_VERSION, sourceScopeVerified: true, contentHashVerified: true,
        fetchTimeVerified: true, observedAvailabilityVerified: true, competitionVerified: true, seasonVerified: true,
        teamIdentityVerified: true, sourcePublishedAt: null, sourceUpdatedAt, publicationStatus: 'MISSING',
        updateField: 'expected.lastUpdated', publishedAvailabilityVerified: false,
        historicalAvailabilityVerified: false, independentlyConfirmed: false },
      coverage: { type: 'SEASON_CUMULATIVE_TEAM_TOTALS', teamCount: provider.teamCount, currentTableOnly: true,
        completeSeason: false, matchLevel: false,
        halfTime: false, nonPenaltyXg: false, shotQuality: false, personnel: false,
        independentlyVerified: false, rounding: 'PROVIDER_DISPLAY_1_DECIMAL' },
      modelEffectApplied: false, pointInTimeAvailabilityVerified: false, formalEligible: false, executable: false };
  } catch { return failure('TEAM_XG_DOCUMENT_FORMAT_CHANGED'); }
}

async function readTable(fetchImpl, provider, now, timeoutMs, ttlMs) {
  if (!cache.has(fetchImpl)) cache.set(fetchImpl, new Map());
  const store = cache.get(fetchImpl);
  const entry = store.get(provider.sourceUrl);
  if (entry?.inflight) return entry.inflight;
  const current = now();
  if (entry?.value && entry.expiresAt > current && current >= entry.storedAt) return entry.value;
  const operation = (async () => {
    const requestedAt = new Date(now()).toISOString(), controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(Error('timeout'), { code: 'TEAM_XG_SOURCE_TIMEOUT' })); }, timeoutMs); });
    let value;
    try {
      const response = await Promise.race([fetchImpl(provider.sourceUrl, { redirect: 'manual', cache: 'no-store',
        headers: { Accept: 'text/html' }, signal: controller.signal }), timeout]);
      if (response?.redirected || response?.type === 'opaqueredirect' || response?.status >= 300 && response.status < 400)
        throw Object.assign(Error(), { code: 'TEAM_XG_SOURCE_REDIRECT_REJECTED' });
      if (response?.url !== provider.sourceUrl) throw Object.assign(Error(), { code: 'TEAM_XG_SOURCE_RESPONSE_URL_MISMATCH' });
      if (!response?.ok) throw Object.assign(Error(), { code: response?.status === 429 ? 'TEAM_XG_SOURCE_RATE_LIMITED' : 'TEAM_XG_SOURCE_HTTP_ERROR' });
      if (!/^text\/html(?:\s*;\s*charset=utf-8)?\s*$/i.test(response.headers?.get('content-type') || ''))
        throw Object.assign(Error(), { code: 'TEAM_XG_SOURCE_CONTENT_TYPE_INVALID' });
      const declared = response.headers?.get('content-length');
      if (declared != null && (!/^\d+$/.test(declared) || Number(declared) > SOCCER_TEAM_XG_MAX_BYTES))
        throw Object.assign(Error(), { code: 'TEAM_XG_DOCUMENT_SIZE_INVALID' });
      if (!response.body || typeof response.body.getReader !== 'function') throw Object.assign(Error(), { code: 'TEAM_XG_SOURCE_BODY_UNAVAILABLE' });
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        while (true) {
          const chunk = await Promise.race([reader.read(), timeout]);
          if (chunk.done) break;
          if (!(chunk.value instanceof Uint8Array)) throw Object.assign(Error(), { code: 'TEAM_XG_SOURCE_BODY_INVALID' });
          bytes += chunk.value.byteLength;
          if (bytes > SOCCER_TEAM_XG_MAX_BYTES) throw Object.assign(Error(), { code: 'TEAM_XG_DOCUMENT_SIZE_INVALID' });
          chunks.push(Buffer.from(chunk.value));
        }
      } catch (error) { controller.abort(); reader.cancel().catch(() => {}); throw error; }
      const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
      if (!text || Buffer.byteLength(text, 'utf8') !== bytes) throw Object.assign(Error(), { code: 'TEAM_XG_SOURCE_UTF8_INVALID' });
      const fetchedAt = new Date(now()).toISOString();
      value = { ok: true, text, bytes, fetchId: randomUUID(), source: { provider: 'OPTA_ANALYST', url: provider.sourceUrl,
        requestedAt, fetchedAt, availableAt: fetchedAt, contentHash: digest(text) } };
    } catch (error) { value = { ok: false, code: error?.code?.startsWith('TEAM_XG_') ? error.code
      : controller.signal.aborted ? 'TEAM_XG_SOURCE_TIMEOUT' : error instanceof TypeError && /encoded data/.test(error.message)
        ? 'TEAM_XG_SOURCE_UTF8_INVALID' : 'TEAM_XG_SOURCE_UNAVAILABLE' }; }
    finally { clearTimeout(timer); }
    store.set(provider.sourceUrl, { value, storedAt: now(), expiresAt: now() + (value.ok ? ttlMs : Math.min(ttlMs, 5000)) });
    return value;
  })();
  store.set(provider.sourceUrl, { inflight: operation });
  return operation;
}

/** One bounded current-season read, shared by both teams and concurrent games. */
export async function fetchSoccerTeamXg(game, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch, now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? TIMEOUT, ttlMs = options.ttlMs ?? TTL;
  if (Object.keys(options).some(key => !['fetchImpl','now','timeoutMs','ttlMs'].includes(key))
    || typeof fetchImpl !== 'function' || typeof now !== 'function' || !Number.isFinite(now())
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > TIMEOUT
    || !Number.isFinite(ttlMs) || ttlMs < 0 || ttlMs > TTL) return unavailableSoccerTeamXg('TEAM_XG_FETCH_OPTIONS_INVALID', game);
  const invalid = requestFailure(game, now());
  if (invalid) return unavailableSoccerTeamXg(invalid, game);
  const fetched = await readTable(fetchImpl, getSoccerTeamXgProvider(game.league), now, timeoutMs, ttlMs);
  if (!fetched.ok) return unavailableSoccerTeamXg(fetched.code, game);
  const result = normalizeSoccerTeamXg(fetched.text, game, fetched.source, now());
  if (result.ok) {
    const binding = { fetchId: fetched.fetchId, gameId: result.gameId, league: result.league, date: result.date,
      season: result.season, competition: { ...result.competition },
      teamIds: { home: result.teams.home.sourceId, away: result.teams.away.sourceId }, kickoffAt: result.startTime,
      gameStatus: game.status, phase: 'PREMATCH_OBSERVATION', provider: 'OPTA_ANALYST', sourceUrl: result.source.url,
      contentHash: result.source.contentHash, requestedAt: result.source.requestedAt, fetchedAt: result.source.fetchedAt,
      availableAt: result.source.availableAt, sourcePublishedAt: null, sourceUpdatedAt: result.source.sourceUpdatedAt };
    documents.set(result, { text: fetched.text, bytes: fetched.bytes, binding, seal: digest(canonical(result)) });
  }
  return result;
}

// Only actual fetch results hold this private proof. Pure normalization, copied
// objects and caller JSON cannot mint it; changing any normalized value revokes it.
export function soccerTeamXgDocumentProof(result) {
  const document = documents.get(result);
  if (!document) return null;
  const { sourceDocumentArchive: _archive, ...original } = result;
  if (digest(canonical(original)) !== document.seal) return null;
  const { seal: _seal, ...proof } = document;
  return structuredClone(proof);
}
