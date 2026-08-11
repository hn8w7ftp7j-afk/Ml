export const THE_ODDS_TIME_WINDOW_VERSION = 'THE-ODDS-API-STRICT-ISO-SECONDS-v1.0.0';

export function strictIsoSeconds(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('無效的盤口時間');
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function oddsApiWindow(date, schedule = []) {
  const timestamps = (Array.isArray(schedule) ? schedule : [])
    .map(game => Date.parse(game?.gameDate || ''))
    .filter(Number.isFinite);
  if (timestamps.length) {
    return {
      start: strictIsoSeconds(Math.min(...timestamps) - 2 * 60 * 60 * 1000),
      end: strictIsoSeconds(Math.max(...timestamps) + 8 * 60 * 60 * 1000),
    };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('日期格式必須為 YYYY-MM-DD');
  const start = new Date(`${date}T00:00:00+08:00`);
  return {
    start: strictIsoSeconds(start),
    end: strictIsoSeconds(start.getTime() + 36 * 60 * 60 * 1000 - 1000),
  };
}
