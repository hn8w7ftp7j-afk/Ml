// Observational evidence only. This module cannot select a source or authorize
// an upload; it describes bounded differences between already-parsed typed
// boards without retaining browser identifiers, raw team names or raw text.
export const SOCCER_AUTHORITY_DIAGNOSTICS_VERSION = 'SOCCER-AUTHORITY-DIAGNOSTICS-v1';
const PERIODS = ['FT', 'HT', 'UNKNOWN'];
const MAX_SOURCES = 4, MAX_DIFFERENCES = 8, MAX_GAMES = 40, MAX_MARKETS = 120;
const WATER_FIELDS = ['awayWater', 'homeWater', 'overWater', 'underWater', 'drawWater'];
const count = value => Math.min(100000, Math.max(0, value));
const periodOf = value => PERIODS.includes(value) ? value : 'UNKNOWN';
const validDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const validTime = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const validCode = value => typeof value === 'string' && /^S[0-9A-F]{8}$/.test(value);
const validLine = value => typeof value === 'string' && /^(?:\d{1,3}(?:\.\d{1,3})?)(?:平|[+-]\d{1,3})?$/.test(value);
const validWater = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000;
const marketKey = market => [market.kind, market.line || '', market.lineSide || ''].join('|');

function marketEvidence(input, unit) {
  if (!input || input.unit !== unit || !['HANDICAP', 'TOTAL', 'MONEYLINE'].includes(input.kind)) return null;
  if (input.kind !== 'MONEYLINE' && !validLine(input.line)) return null;
  if (input.kind === 'HANDICAP' && !['home', 'away'].includes(input.lineSide)) return null;
  const fields = input.kind === 'HANDICAP' ? ['awayWater', 'homeWater']
    : input.kind === 'TOTAL' ? ['overWater', 'underWater'] : ['homeWater', 'drawWater', 'awayWater'];
  if (fields.some(field => !validWater(input[field]))) return null;
  return { period: periodOf(input.period), kind: input.kind,
    ...(input.kind !== 'MONEYLINE' ? { line: input.line } : {}),
    ...(input.kind === 'HANDICAP' ? { lineSide: input.lineSide } : {}),
    ...Object.fromEntries(fields.map(field => [field, input[field]])) };
}

function sourceEvidence(candidate, index, scope, { unit, teamCodeValid, gameEvidence }) {
  const inputGames = Array.isArray(candidate?.parsed?.games) ? candidate.parsed.games : [];
  const games = new Map(), dates = new Set(), periods = new Set();
  let marketCount = 0, invalidGameCount = 0, invalidMarketCount = 0, truncated = inputGames.length > MAX_GAMES;
  for (const rawGame of inputGames.slice(0, MAX_GAMES)) {
    const input = gameEvidence(rawGame);
    if (!validDate(input?.boardDate) || !validTime(input?.boardTime)
      || !teamCodeValid(input?.awayCode) || !teamCodeValid(input?.homeCode) || input.awayCode === input.homeCode) {
      invalidGameCount++; continue;
    }
    const rawMarkets = Array.isArray(input.markets) ? input.markets : [];
    marketCount += rawMarkets.length;
    if (rawMarkets.length > MAX_MARKETS) truncated = true;
    const scoped = new Map();
    for (const raw of rawMarkets.slice(0, MAX_MARKETS)) {
      const market = marketEvidence(raw, unit);
      if (!market) { invalidMarketCount++; continue; }
      if (scope && market.period !== scope) continue;
      if (!scoped.has(market.period)) scoped.set(market.period, { state: 'open', markets: new Map() });
      scoped.get(market.period).markets.set(marketKey(market), market);
    }
    // Only an explicit parser-backed scoped lock can describe an empty board.
    for (const period of PERIODS) {
      if (scope && scope !== period) continue;
      if (Array.isArray(input.periodsCovered) && input.periodsCovered.includes(period) && input.periodStates?.[period] === 'locked' && !scoped.has(period)) {
        scoped.set(period, { state: 'locked', markets: new Map() });
      }
    }
    if (!scoped.size) continue;
    dates.add(input.boardDate);
    for (const period of scoped.keys()) periods.add(period);
    const key = [input.boardDate, input.boardTime, input.awayCode, input.homeCode].join('|');
    games.set(key, { date: input.boardDate, time: input.boardTime, awayCode: input.awayCode, homeCode: input.homeCode, scoped });
  }
  return { games, truncated, summary: { index, dates: [...dates].sort(), periods: PERIODS.filter(period => periods.has(period)),
    gameCount: count(inputGames.length), marketCount: count(marketCount), invalidGameCount, invalidMarketCount } };
}

export function buildSoccerAuthorityDiagnostics(candidates, { league, period = null } = {}) {
  if (!['EPL', 'UCL'].includes(league) || period !== null && !PERIODS.includes(period)) return null;
  return buildTypedAuthorityDiagnostics(candidates, { league, period, version: SOCCER_AUTHORITY_DIAGNOSTICS_VERSION, unit: 'GOALS', teamCodeValid: validCode, includeSourceTopology: true });
}

// Shared observational comparison only. Callers provide already-normalized,
// strictly typed identities; this function never selects or authorizes sources.
export function buildTypedAuthorityDiagnostics(candidates, { league, period = null, version, unit, teamCodeValid, gameEvidence = input => input, includeSourceTopology = false }) {
  const eligible = (Array.isArray(candidates) ? candidates : []).filter(candidate => candidate?.parsed?.league === league);
  const pages = new Map();
  const sources = eligible.slice(0, MAX_SOURCES).map((candidate, index) => {
    const source = sourceEvidence(candidate, index + 1, period, { unit, teamCodeValid, gameEvidence });
    // Report-local ordinals reveal whether two captures came from the same
    // page/frame without exporting Chrome identifiers, URLs or page titles.
    if (includeSourceTopology && Number.isInteger(candidate?.tabId) && candidate.tabId >= 0
      && Number.isInteger(candidate?.frameId) && candidate.frameId >= 0) {
      if (!pages.has(candidate.tabId)) pages.set(candidate.tabId, { index: pages.size + 1, frames: new Map() });
      const page = pages.get(candidate.tabId);
      if (!page.frames.has(candidate.frameId)) page.frames.set(candidate.frameId, page.frames.size + 1);
      Object.assign(source.summary, { pageIndex: page.index, frameIndex: page.frames.get(candidate.frameId),
        ...(typeof candidate.active === 'boolean' ? { active: candidate.active } : {}) });
    }
    return source;
  });
  const pairs = [], differences = [];
  let differenceCount = 0;
  const record = value => { differenceCount++; if (differences.length < MAX_DIFFERENCES) differences.push(value); };
  for (let a = 0; a < sources.length; a++) for (let b = a + 1; b < sources.length; b++) {
    const left = sources[a], right = sources[b];
    for (const currentPeriod of PERIODS) {
      if (!left.summary.periods.includes(currentPeriod) || !right.summary.periods.includes(currentPeriod)) continue;
      const identity = { leftSource: a + 1, rightSource: b + 1, period: currentPeriod };
      const pair = { ...identity, sharedGames: 0, leftOnlyGames: 0, rightOnlyGames: 0,
        sharedContracts: 0, changedContracts: 0, leftOnlyContracts: 0, rightOnlyContracts: 0, stateDifferences: 0 };
      const leftGames = new Map([...left.games].filter(([, game]) => game.scoped.has(currentPeriod)));
      const rightGames = new Map([...right.games].filter(([, game]) => game.scoped.has(currentPeriod)));
      for (const key of new Set([...leftGames.keys(), ...rightGames.keys()])) {
        const l = leftGames.get(key), r = rightGames.get(key), game = l || r;
        const detail = { ...identity, date: game.date, time: game.time, awayCode: game.awayCode, homeCode: game.homeCode };
        if (!l || !r) {
          pair[l ? 'leftOnlyGames' : 'rightOnlyGames']++;
          record({ ...detail, type: l ? 'GAME_ONLY_LEFT' : 'GAME_ONLY_RIGHT', fields: [] });
          continue;
        }
        pair.sharedGames++;
        const ls = l.scoped.get(currentPeriod), rs = r.scoped.get(currentPeriod);
        if (ls.state !== rs.state) {
          pair.stateDifferences++;
          record({ ...detail, type: 'STATE', fields: [{ field: 'marketStatus', left: ls.state, right: rs.state }] });
        }
        for (const contract of new Set([...ls.markets.keys(), ...rs.markets.keys()])) {
          const lm = ls.markets.get(contract), rm = rs.markets.get(contract), market = lm || rm;
          if (!lm || !rm) {
            pair[lm ? 'leftOnlyContracts' : 'rightOnlyContracts']++;
            record({ ...detail, type: lm ? 'CONTRACT_ONLY_LEFT' : 'CONTRACT_ONLY_RIGHT', marketKind: market.kind,
              ...(market.line !== undefined ? { line: market.line } : {}),
              ...(market.lineSide ? { lineSide: market.lineSide } : {}),
              fields: ['line', 'lineSide'].filter(field => market[field] !== undefined)
                .map(field => ({ field, left: lm?.[field] ?? null, right: rm?.[field] ?? null })) });
            continue;
          }
          pair.sharedContracts++;
          const fields = WATER_FIELDS.filter(field => lm[field] !== rm[field])
            .map(field => ({ field, left: lm[field] ?? null, right: rm[field] ?? null }));
          if (fields.length) {
            pair.changedContracts++;
            record({ ...detail, type: 'PRICE', marketKind: market.kind,
              ...(market.line !== undefined ? { line: market.line } : {}),
              ...(market.lineSide ? { lineSide: market.lineSide } : {}), fields });
          }
        }
      }
      pairs.push(pair);
    }
  }
  return { version, sourceCount: count(eligible.length),
    sourcesTruncated: eligible.length > MAX_SOURCES, detailsTruncated: sources.some(source => source.truncated),
    sources: sources.map(source => source.summary), pairs, differences, differenceCount: count(differenceCount),
    differencesTruncated: differenceCount > MAX_DIFFERENCES };
}
