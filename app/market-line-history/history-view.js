export const HISTORY_LEAGUES = Object.freeze(['MLB', 'NBA', 'NPB', 'KBO', 'CPBL']);
export const EMPTY_HISTORY_FILTERS = Object.freeze({ league: '', from: '', through: '', gameKey: '' });

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
  if (gameKey.length > 80) throw new Error('場次識別最多 80 個字元。');
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
      || !Array.isArray(row.markets) || row.markets.some(market => typeof market?.market !== 'string'
        || !['AVAILABLE', 'NOT_CAPTURED', 'INVALID'].includes(market.status)
        || (market.status === 'AVAILABLE' && (!Array.isArray(market.directions)
          || market.directions.length !== 2 || market.directions.some(direction => typeof direction?.pick !== 'string'
            || typeof direction.water !== 'number' || !Number.isFinite(direction.water))))))) {
    throw new Error('歷史盤口回應格式不完整，未當成成功或零筆資料。');
  }
  return payload;
}

export function historyRowKey(row) {
  return JSON.stringify([row.league, row.boardDate, row.gameKey, row.observedAt]);
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
