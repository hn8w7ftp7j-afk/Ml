import { nhlContentHash } from './context.js';

export const NHL_READER_INTERFACE_VERSION = 'NHL-READER-EVIDENCE-v1';
export const NHL_READER_WAITING_MESSAGE = '等待真實 Tai888 NHL 盤驗證';

// Capture interface only. Page labels are evidence, not executable contracts.
// No invented URL, DOM selector, four-market assumption or OT/SO default.
export function validateNhlCapture(input, { now = Date.now() } = {}) {
  const errors = [];
  if (!Number.isFinite(now)) errors.push('NHL_READER_CLOCK_INVALID');
  const validText = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[<>\u0000-\u001f]/.test(value);
  if (input?.league !== 'NHL' || input?.provider !== 'TAI888_READER' || input?.interfaceVersion !== NHL_READER_INTERFACE_VERSION) errors.push('NHL_READER_IDENTITY_INVALID');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input?.boardDate || '') || !Number.isFinite(Date.parse(`${input?.boardDate}T00:00:00Z`))
    || new Date(`${input?.boardDate}T00:00:00Z`).toISOString().slice(0, 10) !== input.boardDate) errors.push('NHL_READER_DATE_INVALID');
  let sourceHost = '';
  try {
    const page = new URL(input.pageUrl);
    sourceHost = page.hostname;
    if (page.protocol !== 'https:' || page.username || page.password || (page.port && page.port !== '443')) errors.push('NHL_READER_SOURCE_INVALID');
  } catch { errors.push('NHL_READER_SOURCE_INVALID'); }
  if (!/^(?:www\d*\.)?tai888\.(?:in|com)$/i.test(sourceHost)) errors.push('NHL_READER_SOURCE_INVALID');
  const observed = Date.parse(input?.observedAt);
  if (typeof input?.observedAt !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(input.observedAt)
    || !Number.isFinite(observed) || observed > now + 5_000 || now - observed > 5 * 60_000) errors.push('NHL_READER_STALE');
  if (!validText(input?.readerVersion, 80) || !validText(input?.pageLeagueLabel, 100) || !/NHL|國家冰球|北美冰球/i.test(input.pageLeagueLabel)) errors.push('NHL_READER_LEAGUE_UNCONFIRMED');
  const rawRows = Array.isArray(input?.rawRows) ? input.rawRows : [];
  if (!Array.isArray(input?.rawRows)) errors.push('NHL_READER_ROWS_MISSING');
  if (rawRows.length > 100) errors.push('NHL_READER_TOO_MANY_ROWS');
  const rows = rawRows.slice(0, 100).map(row => {
    if (!validText(row?.eventLabel, 160) || !validText(row?.marketLabel, 100) || !validText(row?.lineText, 160)
      || !validText(row?.sourceRowId, 100)) errors.push('NHL_READER_ROW_INVALID');
    if (row?.settlementRuleText != null && !validText(row.settlementRuleText, 500)) errors.push('NHL_READER_RULE_TEXT_INVALID');
    return { sourceRowId: row?.sourceRowId, eventLabel: row?.eventLabel, marketLabel: row?.marketLabel,
      lineText: row?.lineText, settlementRuleText: validText(row?.settlementRuleText, 500) ? row.settlementRuleText : null };
  });
  if (new Set(rows.map(row => row.sourceRowId)).size !== rows.length) errors.push('NHL_READER_DUPLICATE_ROW');
  if (errors.length) return { ok: false, status: 'BLOCK', errors: [...new Set(errors)] };
  const payload = { league: 'NHL', provider: 'TAI888_READER', interfaceVersion: NHL_READER_INTERFACE_VERSION,
    boardDate: input.boardDate, observedAt: new Date(observed).toISOString(), sourceHost,
    readerVersion: input.readerVersion, pageLeagueLabel: input.pageLeagueLabel, rawRows: rows,
    marketVerification: 'WAITING_REAL_TAI888_NHL_EVIDENCE', executable: false };
  return { ok: true, status: 'WAITING_REAL_DATA', message: NHL_READER_WAITING_MESSAGE, payload: { ...payload, sourceHash: nhlContentHash(payload) } };
}
