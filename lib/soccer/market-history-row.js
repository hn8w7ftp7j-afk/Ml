import { createHash } from 'node:crypto';
import { canonicalSoccerPayload } from '../../reader/soccer-parser.js';
import { soccerJournalHash } from './journal.js';

const MARKET_NAMES = ['全場讓分', '全場大小', '上半讓分', '上半大小'];
const label = value => typeof value === 'string' && value.length > 0 && value === value.trim();
const water = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const stamp = value => Number.isFinite(Date.parse(value || '')) ? new Date(value).toISOString() : null;

// Expand original immutable observations. This is a read-time view, not an
// adoption/replay path: unknown periods, locks and invalid evidence stay visible.
export function expandSoccerMarketHistoryRow(row) {
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
  return { league: row.league, boardDate: row.board_date, gameKey: row.game_key, gamePk: null,
    observedAt: row.observed_at, receivedAt: row.received_at, persistedAt: row.persisted_at,
    recordId: row.record_id, recordKind: 'READER_OBSERVATION', sourceTable: 'sports_soccer_reader_observations_v2',
    observationId, contentHash, sourceHash: contentHash, stateHash: null,
    readerVersion: payload?.readerVersion || null, identityBasis: identityValid ? 'READER_BOARD_TIME_AND_TEAM_KEYS' : 'UNRESOLVED_SOURCE_RECORD',
    gameLabel: row.game_key.startsWith('UNRESOLVED:') ? '無法辨識場次之原始觀測'
      : `${game?.awayCode || away || '?'} @ ${game?.homeCode || home || '?'} ${game?.boardTime || ''}`.trim(),
    markets, integrity: { ok: issues.length === 0, issues },
    rawMarkets: JSON.stringify(game?.markets ?? null), rawGame: game };
}
