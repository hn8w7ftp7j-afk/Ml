export const THE_ODDS_TIME_WINDOW_VERSION = 'THE-ODDS-API-STRICT-ISO-SECONDS-v1.0.0';

const DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?$/i;

export function providerTimestamp(value, { assumeTaipei = false } = {}) {
  const text = String(value || '').trim();
  const match = text.match(DATE_TIME);
  if (!match) return null;
  const [, date, hourMinute, seconds = '00', milliseconds = '', zone = ''] = match;
  if (!zone && !assumeTaipei) return null;
  const fraction = milliseconds ? `.${milliseconds.padEnd(3, '0')}` : '';
  const normalizedZone = zone
    ? zone.toUpperCase() === 'Z' ? 'Z' : zone.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')
    : '+08:00';
  const timestamp = Date.parse(`${date}T${hourMinute}:${seconds}${fraction}${normalizedZone}`);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

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
