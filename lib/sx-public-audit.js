// Read-only, unauthenticated SX v3 public endpoints. Never feeds scoring.
export const SX_LEAGUES = Object.freeze({ MLB: 171, NPB: 1191, KBO: 1389, CPBL: null });
const TYPES = Object.freeze({ 28: ['TOTAL', 'FULL_GAME_INCLUDING_EXTRA'], 342: ['SPREAD', 'FULL_GAME_INCLUDING_EXTRA'], 236: ['TOTAL', 'FIRST_5_INNINGS'], 281: ['SPREAD', 'FIRST_5_INNINGS'] });
const clean = x => String(x ?? '').slice(0, 160);
const integer = x => typeof x === 'string' && /^\d{1,30}$/.test(x);

// Input must be the documented showTakerPerspective=true snapshot. No guessed units.
export function normalizeSxSnapshot(payload, market, fetchedAt) {
  const book = payload?.data;
  if (payload?.status !== 'success' || book?.marketHash !== market.marketHash || !Array.isArray(book.outcomeOne) || !Array.isArray(book.outcomeTwo) || !integer(book.version)) throw new Error('SCHEMA_MISMATCH');
  return ['outcomeOne', 'outcomeTwo'].map((side, i) => {
    const levels = book[side];
    const valid = levels.filter(x => integer(x.percentageOdds) && integer(x.size) && BigInt(x.size) > 0n && BigInt(x.percentageOdds) > 0n && BigInt(x.percentageOdds) < 100000000000000000000n);
    const best = valid.reduce((a, b) => !a || BigInt(b.percentageOdds) < BigInt(a.percentageOdds) ? b : a, null);
    const mapping = TYPES[market.type];
    return { eventId: clean(market.sportXeventId), marketHash: market.marketHash,
      bookmaker: 'SX Bet (single exchange)', market: mapping?.[0] || `ID ${clean(market.type)}`,
      period: mapping?.[1] || 'UNMAPPED', line: Number.isFinite(market.line) ? market.line : null,
      selection: clean(i === 0 ? market.outcomeOneName : market.outcomeTwoName),
      price: best && levels.length === valid.length && market.status === 'ACTIVE' ? 1e20 / Number(best.percentageOdds) : null,
      availableStakeBaseUnits: best?.size || null, priceBasis: 'TAKER_BEFORE_FEES',
      observedAt: null, fetchedAt, timestampBasis: 'FETCH_TIME_ONLY_NOT_SOURCE_TIMESTAMP', bookVersion: book.version,
      state: market.status !== 'ACTIVE' ? 'UNAVAILABLE' : levels.length !== valid.length ? 'SCHEMA_MISMATCH' : best ? 'MISSING_TIMESTAMP' : 'NO_LIQUIDITY',
    };
  });
}

export async function inspectSxSource({ league, date, eventId = '', fetcher = fetch, now = Date.now() }) {
  if (!Object.hasOwn(SX_LEAGUES, league)) throw new Error('UNKNOWN_LEAGUE');
  const start = Date.parse(`${date}T00:00:00+08:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(start) || new Date(start + 28800000).toISOString().slice(0, 10) !== date) throw new Error('INVALID_DATE');
  const base = { version: 'SX-PUBLIC-AUDIT-v1', league, date, provider: 'SX Bet public API', configured: true, registrationRequired: false,
    policy: 'INSPECTION_ONLY_NO_SCORING', verified: false, identityStatus: 'NOT_MATCHED_TO_OFFICIAL_SCHEDULE', events: [], quotes: [], partial: false };
  if (SX_LEAGUES[league] === null) return { ...base, status: 'LEAGUE_NOT_MAPPED' };
  const signal = AbortSignal.timeout(24000);
  const request = async path => {
    const response = await fetcher(`https://api.sx.bet${path}`, { cache: 'no-store', redirect: 'error', signal });
    if (!response.ok) throw new Error(({401:'SOURCE_AUTH_FAILED',403:'SOURCE_ACCESS_DENIED',429:'SOURCE_RATE_LIMITED'})[response.status] || 'SOURCE_HTTP_ERROR');
    const payload = await response.json();
    if (payload?.status !== 'success') throw new Error('SCHEMA_MISMATCH');
    return payload;
  };
  try {
    const markets = new Map();
    let next = '';
    for (let page = 0; page < 1; page++) {
      const params = new URLSearchParams({ leagueId: String(SX_LEAGUES[league]), sportIds: '3', type: '28,342,236,281', onlyMainLine: 'true', pageSize: '100', gameTime: String(start / 1000) });
      if (eventId) params.set('eventId', eventId);
      if (next) params.set('paginationKey', next);
      const payload = await request(`/markets/active?${params}`);
      if (!Array.isArray(payload.data?.markets)) throw new Error('SCHEMA_MISMATCH');
      for (const m of payload.data.markets) {
        if (m.sportId !== 3 || m.leagueId !== SX_LEAGUES[league] || !Object.hasOwn(TYPES, m.type) || m.status !== 'ACTIVE' || typeof m.gameTime !== 'number' || m.gameTime < start / 1000 || m.gameTime >= start / 1000 + 86400 || (eventId && m.sportXeventId !== eventId)) continue;
        if (!/^0x[0-9a-fA-F]{64}$/.test(m.marketHash) || typeof m.sportXeventId !== 'string' || !m.sportXeventId) throw new Error('SCHEMA_MISMATCH');
        markets.set(m.marketHash, m);
      }
      const cursor = payload.data.nextKey;
      if (!cursor) { next = ''; break; }
      if (typeof cursor !== 'string' || cursor.length > 200) throw new Error('SCHEMA_MISMATCH');
      if (cursor === next) { base.partial = true; break; }
      next = cursor;
    }
    base.partial ||= Boolean(next);
    const events = new Map();
    for (const m of markets.values()) events.set(m.sportXeventId, { id: m.sportXeventId, label: `${clean(m.teamOneName)} / ${clean(m.teamTwoName)}（主客尚未核對）`, start: new Date(m.gameTime * 1000).toISOString() });
    base.events = [...events.values()];
    if (eventId) {
      if (!base.events.length) return { ...base, status: 'EVENT_NOT_FOUND' };
      const selected = [...markets.values()].slice(0, 6);
      base.partial ||= markets.size > selected.length;
      // Bounded concurrency: four requested market types, at most six snapshots.
      const results = await Promise.allSettled(selected.map(async market => {
        const payload = await request(`/orderbook-v3/snapshot?${new URLSearchParams({ marketHash: market.marketHash, showTakerPerspective: 'true' })}`);
        return normalizeSxSnapshot(payload, market, new Date().toISOString());
      }));
      for (const result of results) {
        if (result.status === 'fulfilled') base.quotes.push(...result.value);
        else { base.partial = true; base.sourceErrors ||= []; base.sourceErrors.push(['SCHEMA_MISMATCH','SOURCE_AUTH_FAILED','SOURCE_ACCESS_DENIED','SOURCE_RATE_LIMITED','SOURCE_HTTP_ERROR'].includes(result.reason?.message) ? result.reason.message : 'SOURCE_UNAVAILABLE'); }
      }
    }
    return { ...base, fetchedAt: new Date(now).toISOString(), totalQuotes: base.quotes.length,
      status: eventId ? base.quotes.length ? 'QUOTES_RECEIVED_NOT_VERIFIED' : base.sourceErrors?.[0] || 'NO_QUOTES' : base.events.length ? 'EVENTS_RECEIVED' : 'NO_EVENTS' };
  } catch (error) {
    const allowed = ['SCHEMA_MISMATCH','SOURCE_AUTH_FAILED','SOURCE_ACCESS_DENIED','SOURCE_RATE_LIMITED','SOURCE_HTTP_ERROR'];
    return { ...base, status: allowed.includes(error.message) ? error.message : 'SOURCE_UNAVAILABLE' };
  }
}
