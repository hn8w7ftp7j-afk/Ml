import { NBA_DIAGNOSTIC_TEAM_CODES } from './nba-authority-diagnostics.js';

// Coverage is an observation, separate from save receipts and source authority.
// Receiving every expected slot cannot prove that a source displayed every
// event, so these helpers deliberately never return a COMPLETE status.
const FLAGS = Object.freeze({ coverageComplete: false, readOnly: true });
const MARKET_KEYS = Object.freeze(['fullRunline', 'fullTotal', 'firstHalfRunline', 'firstHalfTotal']);
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum;
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const timeValid = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
const teamValid = value => NBA_DIAGNOSTIC_TEAM_CODES.includes(value);
const unknownReport = () => ({ status: 'UNKNOWN', sourceGaps: [], missingMarketCount: null, ...FLAGS });
const unknownSnapshot = () => ({ status: 'UNKNOWN', expectedGameCount: null, gameCount: null,
  missingGameCount: null, missingMarketCount: null, missingMarkets: [], ...FLAGS });

export function readerDiagnosticCoverage(row) {
  if (!row || !count(row.rawGameCount, 40) || !count(row.marketCount, 160)
    || row.marketCount > row.rawGameCount * MARKET_KEYS.length
    || !Array.isArray(row.boards) || row.boards.length > 2) return unknownReport();
  const sourceGaps = [];
  for (const [index, board] of row.boards.entries()) {
    const expected = board?.diagnostics?.expectedGameCount, parsed = board?.parsedGameCount;
    if (!count(expected, 40) || !count(parsed, 40) || parsed > expected) return unknownReport();
    // Header count zero means the source count is unknown, not a complete slate.
    if (expected > parsed) sourceGaps.push({ sourceIndex: index + 1, expected, parsed, missing: expected - parsed });
  }
  const missingMarketCount = row.rawGameCount * MARKET_KEYS.length - row.marketCount;
  return { status: sourceGaps.length || missingMarketCount ? 'PARTIAL' : 'UNKNOWN',
    sourceGaps, missingMarketCount, ...FLAGS };
}

export function nbaSnapshotCoverage(snapshot) {
  if (!snapshot || !dateValid(snapshot.boardDate) || !Array.isArray(snapshot.games)
    || !count(snapshot.expectedGameCount, 40) || !count(snapshot.gameCount, 40)
    || snapshot.games.length !== snapshot.gameCount || snapshot.gameCount > snapshot.expectedGameCount
    || snapshot.marketCount !== undefined && !count(snapshot.marketCount, 160)) return unknownSnapshot();
  const identities = new Set(), missingMarkets = [];
  let missingMarketCount = 0;
  for (const game of snapshot.games) {
    if (!teamValid(game?.awayCode) || !teamValid(game?.homeCode) || game.awayCode === game.homeCode
      || game.boardDate !== snapshot.boardDate || !timeValid(game.boardTime)) return unknownSnapshot();
    const identity = [game.boardDate, game.boardTime, game.awayCode, game.homeCode].join('|');
    if (identities.has(identity)) return unknownSnapshot();
    identities.add(identity);
    if (MARKET_KEYS.some(key => game[key] != null
      && (typeof game[key] !== 'object' || Array.isArray(game[key])))) return unknownSnapshot();
    const markets = MARKET_KEYS.filter(key => game[key] == null);
    missingMarketCount += markets.length;
    if (markets.length) missingMarkets.push({ awayCode: game.awayCode, homeCode: game.homeCode,
      boardDate: game.boardDate, boardTime: game.boardTime, markets });
  }
  const capturedMarketCount = snapshot.gameCount * MARKET_KEYS.length - missingMarketCount;
  if (snapshot.marketCount !== undefined && snapshot.marketCount !== capturedMarketCount) return unknownSnapshot();
  const missingGameCount = snapshot.expectedGameCount - snapshot.gameCount;
  return { status: missingGameCount || missingMarketCount ? 'PARTIAL' : 'UNKNOWN',
    expectedGameCount: snapshot.expectedGameCount, gameCount: snapshot.gameCount, missingGameCount,
    missingMarketCount, missingMarkets, ...FLAGS };
}
