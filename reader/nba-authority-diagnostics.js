import { buildTypedAuthorityDiagnostics } from './soccer-authority-diagnostics.js';

// Public parser team aliases only; arbitrary DOM text and browser identifiers
// never enter this observational report or authorize a market upload.
export const NBA_AUTHORITY_DIAGNOSTICS_VERSION = 'NBA-AUTHORITY-DIAGNOSTICS-v1';
export const NBA_DIAGNOSTIC_TEAM_CODES = Object.freeze([
  'ATL', 'BOS', 'BKN', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND',
  'LAC', 'LAL', 'MEM', 'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX',
  'POR', 'SAC', 'SA', 'TOR', 'UTAH', 'WSH',
]);
const DEFINITIONS = [
  ['fullRunline', 'FT', 'HANDICAP'], ['fullTotal', 'FT', 'TOTAL'],
  ['firstHalfRunline', 'HT', 'HANDICAP'], ['firstHalfTotal', 'HT', 'TOTAL'],
];

export function buildNbaAuthorityDiagnostics(candidates) {
  const gameEvidence = game => {
    const markets = [], periodsCovered = [], periodStates = {};
    for (const period of ['FT', 'HT']) {
      const definitions = DEFINITIONS.filter(([, value]) => value === period);
      for (const [property, , kind] of definitions) {
        const market = game?.[property];
        if (market == null) continue;
        markets.push({ unit: 'POINTS', kind, period, line: market.line,
          ...(kind === 'HANDICAP' ? { lineSide: market.lineSide, awayWater: market.awayWater, homeWater: market.homeWater }
            : { overWater: market.overWater, underWater: market.underWater }) });
      }
      if (game?.marketStatus === 'locked' || definitions.every(([property]) => game?.marketStates?.[property] === 'locked')) {
        periodsCovered.push(period); periodStates[period] = 'locked';
      }
    }
    return { boardDate: game?.boardDate, boardTime: game?.boardTime, awayCode: game?.awayCode, homeCode: game?.homeCode,
      markets, periodsCovered, periodStates };
  };
  return buildTypedAuthorityDiagnostics(candidates, { league: 'NBA', version: NBA_AUTHORITY_DIAGNOSTICS_VERSION,
    unit: 'POINTS', gameEvidence, teamCodeValid: value => NBA_DIAGNOSTIC_TEAM_CODES.includes(value) });
}
