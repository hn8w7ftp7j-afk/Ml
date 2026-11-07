export const HISTORY_LEAGUES = Object.freeze(['MLB', 'NBA', 'NPB', 'KBO', 'CPBL', 'EPL', 'UCL']);
export const EMPTY_HISTORY_FILTERS = Object.freeze({ league: '', from: '', through: '', gameKey: '' });
export const HISTORY_LEAGUE_LABELS = Object.freeze({ EPL: '英超 EPL', UCL: '歐冠 UCL' });
const SOURCE_TABLES = ['tai888_market_line_history_v1', 'sports_soccer_reader_observations_v2'];
const HISTORY_INTERPRETATION_VERSION = 'SOCCER-HISTORY-PERIOD-INTERPRETATION-v1';
const HISTORY_INTERPRETATION_BASIS = 'SAME_OBSERVATION_PRIMARY_AND_EXPLICIT_HT';

export function historyMarketHasDirections(market) {
  if (!['AVAILABLE', 'RETROSPECTIVE_INTERPRETATION'].includes(market?.status) || !Array.isArray(market.directions)) return false;
  const directions = market.directions;
  const valid = directions.every(direction => typeof direction?.pick === 'string'
    && typeof direction.water === 'number' && Number.isFinite(direction.water));
  return valid && (market.kind === 'MONEYLINE'
    ? directions.length === 3 && ['away', 'draw', 'home'].every(side => directions.filter(direction => direction.side === side).length === 1)
    : directions.length >= 2 && directions.length % 2 === 0);
}

export function historyDisplayMarkets(row) {
  return Array.isArray(row.displayMarkets) ? row.displayMarkets : row.markets;
}

export function historyInterpretationSummary(row) {
  const interpretation = row.historyInterpretation;
  if (!interpretation || !historyDisplayMarkets(row).some(market => market.status === 'RETROSPECTIVE_INTERPRETATION')) return '';
  return `全場盤口已於 ${taipeiHistoryTime(interpretation.interpretedAt)} 依同一筆主盤與明示上半場辨識。原始時段仍保留 UNKNOWN；這是查閱時辨識，不代表當時已可分析或下注。`;
}

export function historyIntegrityNotice(row) {
  if (row.integrity?.ok !== false) return '';
  const issues = Array.isArray(row.integrity.issues) ? row.integrity.issues : [];
  if (!issues.length || issues.some(issue => issue !== 'PERIOD_UNKNOWN')) return '這筆保存內容尚未通過完整性核對，請查看原始保存內容。';
  if (row.historyInterpretation && !historyDisplayMarkets(row).some(market => market.status === 'PERIOD_UNKNOWN')) return '';
  return '部分市場的全場／上半場尚未辨識，請查看各市場狀態。';
}

function validHistoryInterpretation(value, row) {
  return value?.version === HISTORY_INTERPRETATION_VERSION && value.basis === HISTORY_INTERPRETATION_BASIS
    && value.observationId === row.observationId && value.historicalAvailabilityVerified === false && value.executable === false
    && typeof value.interpretedAt === 'string' && Number.isFinite(Date.parse(value.interpretedAt))
    && Date.parse(value.interpretedAt) >= Date.parse(row.persistedAt || row.observedAt);
}

function validDisplayMarkets(row) {
  if (row.displayMarkets == null) return row.historyInterpretation == null;
  if (!['EPL', 'UCL'].includes(row.league) || !Array.isArray(row.displayMarkets) || !row.displayMarkets.length) return false;
  let count = 0;
  for (const market of row.displayMarkets) {
    if (typeof market?.market !== 'string' || !['FT', 'HT', 'UNKNOWN'].includes(market.period)
      || !['HANDICAP', 'TOTAL', 'MONEYLINE'].includes(market.kind)
      || !['AVAILABLE', 'NOT_CAPTURED', 'INVALID', 'LOCKED', 'PERIOD_UNKNOWN', 'RETROSPECTIVE_INTERPRETATION'].includes(market.status)) return false;
    if (['AVAILABLE', 'RETROSPECTIVE_INTERPRETATION'].includes(market.status) && !historyMarketHasDirections(market)) return false;
    if (market.status !== 'RETROSPECTIVE_INTERPRETATION') continue;
    if (market.period !== 'FT' || !Array.isArray(market.contracts) || !market.contracts.length) return false;
    let marketCount = 0;
    for (const contract of market.contracts) {
      const proof = contract?.historyPeriodInterpretation;
      if (proof == null) continue;
      if (!validHistoryInterpretation(proof, row) || proof.originalPeriod !== 'UNKNOWN' || proof.displayPeriod !== 'FT') return false;
      count++; marketCount++;
    }
    if (!marketCount) return false;
  }
  const summary = row.historyInterpretation;
  return count === 0 ? summary == null : validHistoryInterpretation(summary, row)
    && summary.status === 'RETROSPECTIVE_INTERPRETATION' && summary.interpretedContractCount === count
    && Array.isArray(summary.originalPeriods) && summary.originalPeriods.length === 1 && summary.originalPeriods[0] === 'UNKNOWN'
    && Array.isArray(summary.displayPeriods) && summary.displayPeriods.length === 1 && summary.displayPeriods[0] === 'FT';
}

export function historyGameKeyLimit(league) {
  return !league || ['EPL', 'UCL'].includes(league) ? 200 : 80;
}

export function historyFiltersFromSearch(search = '') {
  const params = new URLSearchParams(search);
  return Object.fromEntries(Object.keys(EMPTY_HISTORY_FILTERS).map(key => [key, String(params.get(key) || '').trim()]));
}

export function historyGameFilters(game) {
  return { league: game.league, from: game.boardDate, through: game.boardDate, gameKey: game.gameKey };
}

export function historyRecordLabel(row) {
  return row.recordKind === 'READER_OBSERVATION' || ['EPL', 'UCL'].includes(row.league) ? '讀盤觀測' : '變盤版本';
}

export function historyMarketStatusText(status) {
  if (status === 'LOCKED') return '來源標記鎖盤；此筆沒有可用報價。';
  if (status === 'PERIOD_UNKNOWN') return '半場／全場期間未確認，請查看原始保存內容。';
  if (status === 'INVALID' || status === 'AVAILABLE') return '原始紀錄格式異常，請查看保存內容。';
  return '此筆未保存這個市場。';
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.valueOf()) && instant.toISOString().slice(0, 10) === value;
}

export function historyQueryUrl(filters, pagination = null) {
  const league = String(filters?.league || '').trim().toUpperCase();
  const from = String(filters?.from || '').trim();
  const through = String(filters?.through || '').trim();
  const gameKey = String(filters?.gameKey || '').trim();
  if (league && !HISTORY_LEAGUES.includes(league)) throw new Error('請選擇支援的聯盟。');
  if ((from && !validDate(from)) || (through && !validDate(through))) throw new Error('請輸入有效的盤日。');
  if (from && through && from > through) throw new Error('起始盤日不能晚於結束盤日。');
  const maxKeyLength = historyGameKeyLimit(league);
  if (gameKey.length > maxKeyLength) throw new Error(`場次識別最多 ${maxKeyLength} 個字元。`);
  const query = new URLSearchParams({ limit: '100' });
  if (league) query.set('league', league);
  if (from) query.set('from', from);
  if (through) query.set('through', through);
  if (gameKey) query.set('gameKey', gameKey);
  if (pagination) {
    if (!pagination.nextAfter || !Number.isFinite(Date.parse(pagination.until || ''))) {
      throw new Error('分頁資訊不完整，請重新查詢。');
    }
    query.set('until', pagination.until);
    query.set('after', pagination.nextAfter);
  }
  return `/api/market-line-history?${query.toString()}`;
}

export function validateHistoryResponse(payload) {
  const count = value => Number.isSafeInteger(value) && value >= 0;
  if (payload?.ok !== true || payload?.schema !== 'market-line-history-query-v1'
    || payload?.sourceTable !== 'tai888_market_line_history_v1'
    || (payload.sourceTables != null && (!Array.isArray(payload.sourceTables)
      || payload.sourceTables.some(table => !SOURCE_TABLES.includes(table))))
    || !Array.isArray(payload.rows) || !Array.isArray(payload.leagues)
    || !count(payload.totals?.savedStates) || !count(payload.totals?.gameDateKeys)
    || !count(payload.totals?.boardDates)
    || payload.leagues.some(row => !HISTORY_LEAGUES.includes(row?.league)
      || !count(row.savedStates) || !count(row.gameDateKeys) || !count(row.boardDates))
    || !Number.isFinite(Date.parse(payload.until || ''))
    || typeof payload.hasMore !== 'boolean'
    || (payload.hasMore && (typeof payload.nextAfter !== 'string' || !payload.nextAfter))
    || payload.rows.some(row => !HISTORY_LEAGUES.includes(row?.league)
      || !validDate(row.boardDate || '') || typeof row.gameKey !== 'string' || !row.gameKey
      || !Number.isFinite(Date.parse(row.observedAt || ''))
      || (row.gameLabel != null && typeof row.gameLabel !== 'string')
      || (row.recordId != null && typeof row.recordId !== 'string')
      || (row.recordKind != null && !['CHANGED_STATE', 'READER_OBSERVATION'].includes(row.recordKind))
      || (row.sourceTable != null && !SOURCE_TABLES.includes(row.sourceTable))
      || (['EPL', 'UCL'].includes(row.league) && (row.recordKind !== 'READER_OBSERVATION'
        || typeof row.recordId !== 'string' || !row.recordId || row.sourceTable !== 'sports_soccer_reader_observations_v2'))
      || !validDisplayMarkets(row)
      || !Array.isArray(row.markets) || row.markets.some(market => typeof market?.market !== 'string'
        || !['AVAILABLE', 'NOT_CAPTURED', 'INVALID', 'LOCKED', 'PERIOD_UNKNOWN'].includes(market.status)
        || (market.status === 'AVAILABLE' && (!Array.isArray(market.directions)
          || market.directions.length < 2 || market.directions.length % 2 !== 0 || market.directions.some(direction => typeof direction?.pick !== 'string'
            || typeof direction.water !== 'number' || !Number.isFinite(direction.water))))))) {
    throw new Error('歷史盤口回應格式不完整，未當成成功或零筆資料。');
  }
  return payload;
}

export function historyRowKey(row) {
  return JSON.stringify([row.league, row.boardDate, row.gameKey, row.observedAt, row.recordId || '']);
}

export function mergeHistoryRows(previous, incoming) {
  const rows = new Map(previous.map(row => [historyRowKey(row), row]));
  for (const row of incoming) rows.set(historyRowKey(row), row);
  return [...rows.values()].sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt)
    || historyRowKey(left).localeCompare(historyRowKey(right)));
}

export function groupHistoryRows(rows) {
  const groups = new Map();
  for (const row of mergeHistoryRows([], rows)) {
    const key = JSON.stringify([row.league, row.boardDate, row.gameKey]);
    if (!groups.has(key)) groups.set(key, { key, league: row.league, boardDate: row.boardDate,
      gameKey: row.gameKey, label: row.gameLabel || `場次 ${row.gameKey}`, rows: [] });
    groups.get(key).rows.push(row);
  }
  return [...groups.values()].sort((left, right) => right.boardDate.localeCompare(left.boardDate)
    || left.league.localeCompare(right.league) || left.gameKey.localeCompare(right.gameKey));
}

export function taipeiHistoryTime(value) {
  if (!Number.isFinite(Date.parse(value || ''))) return '時間未保存';
  return new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

export function historyWater(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '未保存';
}

export function historyFilterLabel(filters) {
  const range = filters.from || filters.through
    ? `${filters.from || '不限起日'} ～ ${filters.through || '不限迄日'}` : '全部盤日';
  return `${filters.league || '全部聯盟'}｜${range}${filters.gameKey ? `｜場次 ${filters.gameKey}` : ''}`;
}
