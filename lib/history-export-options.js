const leagues = new Set(['MLB', 'NPB', 'KBO', 'CPBL']);
export const HISTORY_EXPORT_HEADERS = Object.freeze({
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
});

export function parseHistoryExportLeague(params) {
  const values = params.getAll('league');
  if (!values.length) return null;
  if (values.length !== 1 || !leagues.has(values[0])) throw new Error('INVALID_LEAGUE');
  return values[0];
}

export function historyExportHeaders(params, filename) {
  return params.get('download') === '1'
    ? { ...HISTORY_EXPORT_HEADERS, 'Content-Disposition': `attachment; filename="${filename}"` }
    : HISTORY_EXPORT_HEADERS;
}
