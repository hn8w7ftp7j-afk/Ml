// Transport-only inspection. Never feeds marketVerification or scoring.
export const EXTERNAL_AUDIT_VERSION = 'EXTERNAL-SOURCE-INSPECTION-v1';
export const SOURCES = Object.freeze({
  CPBL: { provider: 'OddsPapi', key: 'ODDSPAPI_API_KEY', tournament: 32233 },
  NPB: { provider: 'odds-api.net', key: 'ODDS_API_NET_KEY', league: 'Japan NPB' },
  KBO: { provider: 'odds-api.net', key: 'ODDS_API_NET_KEY', league: 'Korean KBO' },
});
const text = value => String(value ?? '').slice(0, 160);
const number = value => value == null || value === '' ? NaN : Number(value);
const validPrice = value => Number.isFinite(number(value)) && number(value) > 1;
export function quoteState(price, timestamp, active, now = Date.now()) {
  if (active !== true) return 'UNAVAILABLE';
  if (!validPrice(price)) return 'INVALID_PRICE';
  const time = typeof timestamp === 'number' ? timestamp : Date.parse(timestamp || '');
  if (!Number.isFinite(time)) return 'MISSING_TIMESTAMP';
  if (time > now) return 'FUTURE_TIMESTAMP';
  return now - time <= 300000 ? 'FRESH' : 'STALE';
}
export function normalizeNetSnapshot(payload, eventId, now = Date.now()) {
  if (!payload || payload.event_id !== eventId || !Array.isArray(payload.items)) throw new Error('SCHEMA_MISMATCH');
  return payload.items.map(row => {
    const timestamp = number(payload.bookmaker_as_of_ts_ms?.[row.bookmaker]);
    const validTime = Number.isFinite(timestamp) && timestamp > 0 && timestamp <= 8640000000000000;
    return {
      eventId, bookmaker: text(row.bookmaker), market: text(row.market_key),
      period: text(row.period), selection: text(row.selection_name || row.side),
      price: validPrice(row.odds) ? number(row.odds) : null,
      observedAt: validTime ? new Date(timestamp).toISOString() : null,
      timestampBasis: 'BOOKMAKER_SNAPSHOT',
      state: row.event_id !== eventId ? 'EVENT_MISMATCH' : quoteState(row.odds, validTime ? timestamp : null, row.is_available, now),
    };
  });
}
export function normalizePapiQuotes(fixture, now = Date.now()) {
  const rows = [];
  for (const [bookmaker, book] of Object.entries(fixture.bookmakerOdds || {})) {
    for (const [marketId, market] of Object.entries(book.markets || {})) {
      for (const [outcomeId, outcome] of Object.entries(market.outcomes || {})) {
        for (const [playerId, quote] of Object.entries(outcome.players || {})) {
          const timestamp = Date.parse(quote.changedAt || '');
          rows.push({ eventId: text(fixture.fixtureId), bookmaker: text(bookmaker),
            market: `ID ${text(marketId)}`, period: 'UNMAPPED',
            selection: `outcome ${text(outcomeId)} / player ${text(playerId)}`,
            price: validPrice(quote.price) ? number(quote.price) : null,
            observedAt: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null,
            timestampBasis: 'PRICE_CHANGED_AT_NOT_OBSERVATION',
            state: quoteState(quote.price, quote.changedAt, book.bookmakerIsActive === true && quote.active === true, now),
          });
        }
      }
    }
  }
  return rows;
}

export async function inspectSource({ league, date, eventId = '', env = process.env, fetcher = fetch, now = Date.now() }) {
  const source = Object.hasOwn(SOURCES, league) ? SOURCES[league] : null;
  if (!source) throw new Error('UNKNOWN_LEAGUE');
  const start = Date.parse(`${date}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) || new Date(start + 28800000).toISOString().slice(0, 10) !== date) throw new Error('INVALID_DATE');
  const base = { version: EXTERNAL_AUDIT_VERSION, league, date, provider: source.provider,
    configured: Boolean(env[source.key]?.trim()), requiredSetting: source.key,
    policy: 'INSPECTION_ONLY_NO_SCORING', verified: false, events: [], quotes: [],
    identityStatus: 'NOT_MATCHED_TO_OFFICIAL_SCHEDULE', };
  if (!base.configured) return { ...base, status: 'NOT_CONFIGURED' };
  const request = async (url, headers = {}) => {
    const response = await fetcher(url, { headers, cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      const error = new Error(({ 401: 'SOURCE_AUTH_FAILED', 403: 'SOURCE_ACCESS_DENIED', 429: 'SOURCE_RATE_LIMITED' })[response.status] || 'SOURCE_HTTP_ERROR');
      error.httpStatus = response.status;
      throw error;
    }
    return response.json();
  };
  try {
    if (league === 'CPBL') {
      const url = new URL('https://api.oddspapi.io/v4/odds-by-tournaments');
      url.search = new URLSearchParams({ bookmaker: 'pinnacle', tournamentIds: String(source.tournament), apiKey: env[source.key], oddsFormat: 'decimal' }).toString();
      const payload = await request(url);
      if (!Array.isArray(payload)) throw new Error('SCHEMA_MISMATCH');
      const fixtures = payload.filter(row => row.tournamentId === source.tournament && Date.parse(row.startTime) >= start && Date.parse(row.startTime) < start + 86400000);
      base.events = fixtures.map(row => ({ id: text(row.fixtureId), label: `participant ${text(row.participant1Id)} / participant ${text(row.participant2Id)}（主客未核對）`, start: text(row.startTime) }));
      if (eventId) {
        const fixture = fixtures.find(row => String(row.fixtureId) === eventId);
        if (!fixture) return { ...base, status: 'EVENT_NOT_FOUND' };
        base.quotes = normalizePapiQuotes(fixture, now);
      }
    } else {
      const headers = { 'X-API-Key': env[source.key] };
      const params = new URLSearchParams({ sport: 'baseball', league: source.league, start_from: String(start / 1000), start_to: String((start + 86400000) / 1000), limit: '100' });
      const payload = await request(`https://api.odds-api.net/v1/events?${params}`, headers);
      if (!Array.isArray(payload?.items)) throw new Error('SCHEMA_MISMATCH');
      base.partial = Boolean(payload.next_cursor);
      const events = payload.items.filter(row => row.sport === 'baseball' && row.league === source.league && number(row.start_time) >= start / 1000 && number(row.start_time) < (start + 86400000) / 1000);
      base.events = events.map(row => ({ id: text(row.event_id), home: text(row.home_team), away: text(row.away_team), start: new Date(row.start_time * 1000).toISOString() }));
      if (eventId) {
        if (!events.some(row => row.event_id === eventId)) return { ...base, status: 'EVENT_NOT_FOUND' };
        const snapshot = await request(`https://api.odds-api.net/v1/events/${encodeURIComponent(eventId)}/odds/snapshot?include_source=true`, headers);
        base.partial ||= Boolean(snapshot.next_cursor) || snapshot.complete !== true;
        base.quotes = normalizeNetSnapshot(snapshot, eventId, now);
      }
    }
    const total = base.quotes.length;
    base.quotes = base.quotes.slice(0, 500);
    base.partial ||= total > 500;
    return { ...base, fetchedAt: new Date(now).toISOString(), status: eventId ? total ? 'QUOTES_RECEIVED_NOT_VERIFIED' : 'NO_QUOTES' : base.events.length ? 'EVENTS_RECEIVED' : 'NO_EVENTS', totalQuotes: total };
  } catch (error) {
    // Never return upstream error messages: they can include credential URLs.
    const allowed = ['SCHEMA_MISMATCH', 'SOURCE_AUTH_FAILED', 'SOURCE_ACCESS_DENIED', 'SOURCE_RATE_LIMITED', 'SOURCE_HTTP_ERROR'];
    return { ...base, status: allowed.includes(error.message) ? error.message : 'SOURCE_UNAVAILABLE', httpStatus: error.httpStatus || null };
  }
}
