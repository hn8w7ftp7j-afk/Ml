import { createHash } from 'node:crypto';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';
import { soccerJournalHash } from './journal.js';
import { interpretSoccerHistoryPeriods } from './history-period-interpretation.js';

const MARKET_NAMES = ['全場讓分', '全場大小', '上半讓分', '上半大小'];
const label = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const water = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const stamp = value => Number.isFinite(Date.parse(value || '')) ? new Date(value).toISOString() : null;
const teamLabel = (game, side) => {
  const raw = game?.[`${side}Raw`];
  if (label(raw)) return raw.replace(/\s*[\[［【(（]\s*主\s*[\]］】)）]\s*$/u, '').trim();
  const code = game?.[`${side}Code`], key = game?.[`${side}Key`];
  return /^S[A-F0-9]{8}$/.test(code || '') ? key || code : code || key || '?';
};

function displayMarketGroups(game, contracts, { sourceValid, identityValid, unknown }) {
  const groups = [['FT', 'HANDICAP', MARKET_NAMES[0]], ['FT', 'TOTAL', MARKET_NAMES[1]],
    ['HT', 'HANDICAP', MARKET_NAMES[2]], ['HT', 'TOTAL', MARKET_NAMES[3]]];
  for (const period of ['FT', 'HT', 'UNKNOWN']) for (const kind of ['HANDICAP', 'TOTAL', 'MONEYLINE']) {
    if (groups.some(group => group[0] === period && group[1] === kind)
      || !contracts.some(contract => contract?.period === period && contract.kind === kind)) continue;
    const prefix = period === 'FT' ? '全場' : period === 'HT' ? '上半' : '原始時段未確認';
    groups.push([period, kind, `${prefix}${kind === 'HANDICAP' ? '讓分' : kind === 'TOTAL' ? '大小' : '勝平負'}`]);
  }
  return groups.map(([period, kind, market]) => {
    const selected = contracts.filter(contract => contract?.period === period && contract.kind === kind);
    if (!sourceValid || !identityValid) return { market, period, kind, status: 'INVALID', contracts: selected, directions: [] };
    if (game?.periodStates?.[period] === 'locked') return { market, period, kind, status: 'LOCKED', contracts: selected, directions: [] };
    if (period === 'UNKNOWN' || !selected.length) return { market, period, kind,
      status: period === 'UNKNOWN' || unknown ? 'PERIOD_UNKNOWN' : 'NOT_CAPTURED', contracts: selected, directions: [] };
    const valid = selected.every(contract => contract.unit === 'GOALS'
      && (kind === 'MONEYLINE' ? water(contract.awayWater) && water(contract.drawWater) && water(contract.homeWater)
        : label(contract.line) && (kind === 'HANDICAP' ? ['away', 'home'].includes(contract.lineSide)
          && water(contract.awayWater) && water(contract.homeWater) : water(contract.overWater) && water(contract.underWater))));
    if (!valid) return { market, period, kind, status: 'INVALID', contracts: selected, directions: [] };
    const directions = selected.flatMap((contract, contractIndex) => kind === 'HANDICAP'
      ? ['away', 'home'].map(side => ({ side, contractIndex,
        pick: `${teamLabel(game, side)}${contract.lineSide === side ? '讓' : '受讓'}${contract.line}`,
        line: contract.line, water: contract[`${side}Water`] }))
      : kind === 'TOTAL' ? [{ side: 'over', contractIndex, pick: `大${contract.line}`, line: contract.line, water: contract.overWater },
        { side: 'under', contractIndex, pick: `小${contract.line}`, line: contract.line, water: contract.underWater }]
        : ['away', 'draw', 'home'].map(side => ({ side, contractIndex,
          pick: side === 'draw' ? '和局' : `${teamLabel(game, side)}勝`, line: null, water: contract[`${side}Water`] })));
    return { market, period, kind,
      status: selected.some(contract => contract.historyPeriodInterpretation) ? 'RETROSPECTIVE_INTERPRETATION' : 'AVAILABLE',
      contracts: selected, directions };
  });
}

// Expand original immutable observations. This is a read-time view, not an
// adoption/replay path: unknown periods, locks and invalid evidence stay visible.
export function expandSoccerMarketHistoryRow(row, { now = Date.now() } = {}) {
  const game = row.game, payload = row.payload, issues = [];
  const observationId = row.observation_id?.trim() || '';
  const contentHash = row.content_hash?.trim() || '';
  let sourceValid = false;
  try {
    sourceValid = payload?.league === row.league && payload?.boardDate === row.board_date
      && stamp(payload.observedAt) === stamp(row.observed_at)
      && soccerJournalHash(payload) === observationId
      && createHash('sha256').update(canonicalSoccerPayload(payload)).digest('hex') === contentHash
      && payload.contentHash === contentHash;
  } catch { /* Never promote corrupted stored evidence to available quotes. */ }
  if (!sourceValid) issues.push('SOURCE_PAYLOAD_HASH_MISMATCH');
  const away = game?.awayKey || game?.awayCode, home = game?.homeKey || game?.homeCode;
  const identityValid = game && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.boardTime || '')
    && label(away) && label(home) && away !== home
    && `${game.boardTime}|${away}|${home}` === row.game_key
    && (!game.league || game.league === row.league)
    && (!game.boardDate || game.boardDate === row.board_date);
  if (!identityValid) issues.push('SOCCER_GAME_KEY_INVALID');
  const originalMarkets = Array.isArray(game?.markets) ? game.markets : [];
  if (!Array.isArray(game?.markets)) issues.push('MARKETS_SHAPE_INVALID');
  const periods = Array.isArray(game?.periodsCovered) ? game.periodsCovered : [];
  const unknown = originalMarkets.some(market => !['FT', 'HT'].includes(market?.period))
    || periods.includes('UNKNOWN') || (!periods.length && !originalMarkets.length);
  if (unknown) issues.push('PERIOD_UNKNOWN');
  const markets = MARKET_NAMES.map((market, index) => {
    const period = index < 2 ? 'FT' : 'HT', kind = index % 2 ? 'TOTAL' : 'HANDICAP';
    const contracts = originalMarkets.filter(value => value?.period === period && value.kind === kind);
    const locked = game?.periodStates?.[period] === 'locked';
    if (!sourceValid || !identityValid) return { market, period, kind, status: 'INVALID', directions: [], contracts };
    if (!contracts.length) return { market, period, kind,
      status: locked ? 'LOCKED' : unknown ? 'PERIOD_UNKNOWN' : 'NOT_CAPTURED', directions: [], contracts };
    const valid = contracts.every(value => value.unit === 'GOALS' && label(value.line)
      && (kind === 'HANDICAP' ? ['away', 'home'].includes(value.lineSide) && water(value.awayWater) && water(value.homeWater)
        : water(value.overWater) && water(value.underWater)));
    if (!valid) {
      issues.push(`MARKET_${index}_INVALID`);
      return { market, period, kind, status: 'INVALID', directions: [], contracts };
    }
    const directions = contracts.flatMap((value, contractIndex) => kind === 'HANDICAP'
      ? ['away', 'home'].map(side => ({ side, contractIndex,
        pick: `${game[`${side}Code`] || game[`${side}Key`]}${value.lineSide === side ? '讓' : '受讓'}${value.line}`,
        line: value.line, water: value[`${side}Water`] }))
      : [{ side: 'over', contractIndex, pick: `大${value.line}`, line: value.line, water: value.overWater },
        { side: 'under', contractIndex, pick: `小${value.line}`, line: value.line, water: value.underWater }]);
    return { market, period, kind, status: 'AVAILABLE', directions, contracts };
  });
  const interpretation = interpretSoccerHistoryPeriods({ payload, game, league: row.league,
    boardDate: row.board_date, gameKey: row.game_key, observationId, contentHash,
    observedAt: row.observed_at, persistedAt: row.persisted_at, now });
  const displayMarkets = displayMarketGroups(game, interpretation.displayContracts, { sourceValid, identityValid,
    unknown: interpretation.displayContracts.some(contract => !['FT', 'HT'].includes(contract?.period)) });
  return { league: row.league, boardDate: row.board_date, gameKey: row.game_key, gamePk: null,
    observedAt: row.observed_at, receivedAt: row.received_at, persistedAt: row.persisted_at,
    recordId: row.record_id, recordKind: 'READER_OBSERVATION', sourceTable: 'sports_soccer_reader_observations_v2',
    observationId, contentHash, sourceHash: contentHash, stateHash: null,
    readerVersion: payload?.readerVersion || null, identityBasis: identityValid ? 'READER_BOARD_TIME_AND_TEAM_KEYS' : 'UNRESOLVED_SOURCE_RECORD',
    gameLabel: row.game_key.startsWith('UNRESOLVED:') ? '無法辨識場次之原始觀測'
      : `${teamLabel(game, 'away')} @ ${teamLabel(game, 'home')} ${game?.boardTime || ''}`.trim(),
    markets, displayMarkets, historyInterpretation: interpretation.historyInterpretation,
    historicalAvailabilityVerified: false, executable: false, integrity: { ok: issues.length === 0, issues },
    rawMarkets: JSON.stringify(game?.markets ?? null), rawGame: game };
}
