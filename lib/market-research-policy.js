import { parseTaiwanLine } from './markets.js';

// This is a display / candidate-list policy, not a model, QA, or ledger gate.
// Never write it into a signed analysis snapshot or use it to reject a record
// of an actual bet. A null return means "this policy does not apply", NOT that
// a market is validated, safe, or eligible under the existing QA gates.
const MLB_FULL_TOTAL_OVER_POLICY = Object.freeze({
  id: 'MLB_FULL_TOTAL_OVER_RESEARCH_ONLY',
  label: '暫停使用／僅供研究',
  reason: 'MLB 全場大分暫停列入可操作候選；保留模型分析、歷史追蹤與實際下注記帳，待獨立驗證後再評估。',
  leagueId: 'MLB',
  market: '全場大小',
  direction: 'over',
  candidateEligible: false,
  preserveAnalysis: true,
  preserveLedger: true,
});

const token = value => typeof value === 'string' ? value.trim().toUpperCase() : '';
const present = value => value != null && !(typeof value === 'string' && !value.trim());
const object = value => value != null && typeof value === 'object' && !Array.isArray(value);

const FULL_PERIODS = new Set(['FULL', 'FULL_GAME', '全場', '全场']);
const FULL_TOTAL_MARKETS = new Set(['全場大小', '全场大小', 'FULL_TOTAL', 'FULL_GAME_TOTAL']);
const TOTAL_FAMILIES = new Set(['TOTAL', 'TOTALS']);
const OVER_DIRECTIONS = new Set(['OVER', '大', '大分']);

/**
 * Resolve only an unambiguous MLB full-game total-over identity. Supported
 * sources are a direction row, the ranking entry { row, item: { game } },
 * legacy flat entries, and an explicit game context. No missing league ever
 * defaults to MLB. Conflicting or unknown supplied identity fields cannot
 * silently override one another; existing identity / QA handling is retained.
 */
export function marketResearchPolicy(row, game = {}) {
  if (!object(row)) return null;
  const rows = [row, row.row].filter(object);
  const leagueSources = [
    ...rows,
    row.game,
    row.row?.game,
    row.item,
    row.item?.game,
    row.item?.customData?.analysis,
    game,
  ].filter(object);
  const leagues = leagueSources.flatMap(source => [source.leagueId, source.league, source.leagueCode])
    .filter(present);
  if (!leagues.length || leagues.some(value => token(value) !== 'MLB')) return null;

  let full = false;
  let total = false;
  let over = false;
  for (const source of rows) {
    for (const value of [source.slotId, source.directionSlotId].filter(present)) {
      if (token(value) !== 'FULL_TOTAL_OVER') return null;
      full = total = over = true;
    }
    for (const value of [source.market].filter(present)) {
      if (FULL_TOTAL_MARKETS.has(token(value))) {
        full = total = true;
      } else if (TOTAL_FAMILIES.has(token(value))) {
        total = true;
      } else return null;
    }
    for (const value of [source.marketType, source.marketFamily].filter(present)) {
      if (!TOTAL_FAMILIES.has(token(value))) return null;
      total = true;
    }
    for (const value of [source.segment, source.period].filter(present)) {
      if (!FULL_PERIODS.has(token(value))) return null;
      full = true;
    }
    for (const value of [source.direction, source.selection].filter(present)) {
      if (!OVER_DIRECTIONS.has(token(value))) return null;
      over = true;
    }
    if (present(source.pick)) {
      // Use the same exact Taiwan-contract parser as the existing direction
      // identity: a team name containing "大" is never an over selection.
      const parsed = parseTaiwanLine(source.pick);
      if (!parsed.valid || !parsed.isTotal || !parsed.isOver) return null;
      total = over = true;
    }
  }
  return full && total && over ? MLB_FULL_TOTAL_OVER_POLICY : null;
}

export function isResearchOnlyMarket(row, game = {}) {
  return marketResearchPolicy(row, game) != null;
}
