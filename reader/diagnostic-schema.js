// Shared browser/server allow-list. Never upload arbitrary page text, URLs,
// raw DOM, credentials, or server error messages as diagnostic evidence.
export const DIAGNOSTIC_SCHEMA = 'READER-DIAGNOSTICS-v1';
export const DIAGNOSTIC_LEAGUES = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL']);
const STATES = new Set(['synced', 'error', 'disconnected', 'missing', 'idle']);
const CODES = new Set(['unknown-league', 'no-board-candidates', 'conflicting-duplicate-rows',
  'conflicting-duplicate-frames', 'conflicting-duplicate-tabs', 'no-complete-tab',
  'soccer-authority-source-missing', 'invalid-source-host', 'no-board-table',
  'missing-expected-game-count', 'missing-detected-game-count', 'no-parsed-games',
  'conflicting-normalized-rows', 'board-date-mismatch', 'missing-observed-time',
  'stale-observation', 'future-market-activity', 'invalid-away-code', 'invalid-home-code',
  'same-team', 'invalid-date', 'invalid-time', 'missing-explicit-lock', 'locked-game-has-market',
  'locked-game-period-evidence-missing', 'soccer-contract-evidence-invalid',
  'nhl-market-evidence-missing', 'nhl-capture-cannot-execute', 'duplicate-game',
  'unrecognized-issue', 'NETWORK_ERROR', 'TIMEOUT', 'INVALID_RESPONSE', 'SYNC_EXCEPTION']);
const SOCCER_CODES = new Set(['SOCCER_MIXED_LEAGUE_SECTION', 'SOCCER_CARD_HEADERS_MISSING',
  'SOCCER_CARD_HEADERS_AMBIGUOUS', 'SOCCER_CARD_TEAM_IDENTITY_INVALID', 'SOCCER_CARD_QUOTES_AMBIGUOUS',
  'SOCCER_TABLE_IDENTITY_INVALID', 'SOCCER_TABLE_QUOTES_AMBIGUOUS', 'SOCCER_TABLE_HEADERS_AMBIGUOUS',
  'SOCCER_HEADING_FOUND_NO_LAYOUT', 'SOCCER_LAYOUT_UNRECOGNIZED', 'SOCCER_MODULE_MISSING',
  'SOCCER_LAYOUT_RECORDS_TRUNCATED', 'SOCCER_LEAGUE_HEADER_UNCONFIRMED',
  'SOCCER_SECTION_LEAGUE_MISMATCH', 'SOCCER_GAME_IDENTITY_INVALID', 'SOCCER_CONTRACT_PRICE_CONFLICT']);
const COUNT_KEYS = ['recordCount', 'headerCount', 'candidateRows', 'gameCount', 'pairedRows',
  'singleRows', 'expectedGameCount', 'rootCount', 'candidateElementCount', 'acceptedRecordCount', 'skippedAlternativeCount'];
export const diagnosticCount = value => Number.isInteger(value) && value >= 0 && value <= 100000 ? value : 0;
export function diagnosticCode(value) {
  if (typeof value !== 'string' || value.length > 200) return 'unrecognized-issue';
  if (value.startsWith('duplicate-game:')) return 'duplicate-game';
  if (value === 'parser:wrong-period-header:NBA:first-five') return value;
  if (value.startsWith('parser:conflicting-duplicate:')) return 'parser:conflicting-duplicate';
  if (value === 'parser:conflicting-duplicate' || value === 'parser:conflicting-normalized-rows') return value;
  if (CODES.has(value) || /^HTTP_[1-5]\d{2}$/.test(value)) return value;
  if (/^(?:direction-count|board-date-count):\d{1,3}$/.test(value)
    || /^(?:expected-\d{1,3}|raw-detected-\d{1,3})-parsed-\d{1,3}$/.test(value)) return value;
  if (/^game-\d{1,3}:/.test(value)) return `${value.split(':')[0]}:${diagnosticCode(value.slice(value.indexOf(':') + 1))}`;
  if (/^(?:full|first-half|first5)-(?:runline|total):(?:missing|ambiguous-side|invalid-line|invalid-away-water|invalid-home-water|invalid-over-water|invalid-under-water)$/.test(value)) return value;
  if (/^(?:table|parser):/.test(value)) {
    const [prefix, code] = value.split(':');
    if (SOCCER_CODES.has(code)) return `${prefix}:${code}`;
    if (code === 'SOCCER_MARKET_UNRECOGNIZED') return `${prefix}:${code}`;
  }
  return 'unrecognized-issue';
}
const codes = values => [...new Set((Array.isArray(values) ? values : []).slice(0, 16).map(diagnosticCode))];
const version = value => typeof value === 'string' && /^\d{1,3}(?:\.\d{1,3}){1,3}$/.test(value) ? value : null;
export const diagnosticIdValid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
function counts(input) {
  return { ...Object.fromEntries(COUNT_KEYS.map(key => [key, diagnosticCount(input?.[key])])),
    sawLeagueMarker: input?.sawLeagueMarker === true, wrongPeriodHeader: input?.wrongPeriodHeader === true };
}
export function sanitizeDiagnosticReport(input) {
  const created = typeof input?.createdAt === 'string' ? Date.parse(input.createdAt) : NaN;
  if (input?.schema !== DIAGNOSTIC_SCHEMA || !diagnosticIdValid(input?.reportId)
    || !version(input?.readerVersion) || !Number.isFinite(created)) throw Object.assign(new Error('診斷格式錯誤'), { status: 400 });
  const leagues = {};
  for (const league of DIAGNOSTIC_LEAGUES) {
    const row = input?.leagues?.[league];
    if (!row || !STATES.has(row.state)) continue;
    leagues[league] = { state: row.state, errorCode: row.errorCode ? diagnosticCode(row.errorCode) : '',
      issues: codes(row.issues), rawGameCount: diagnosticCount(row.rawGameCount), marketCount: diagnosticCount(row.marketCount),
      boards: (Array.isArray(row.boards) ? row.boards : []).slice(0, 2).map(board => ({
        diagnostics: counts(board?.diagnostics), parsedGameCount: diagnosticCount(board?.parsedGameCount),
        issues: codes(board?.issues),
      })) };
  }
  return { schema: DIAGNOSTIC_SCHEMA, reportId: input.reportId, readerVersion: version(input.readerVersion),
    extensionManifestVersion: version(input.extensionManifestVersion), createdAt: new Date(created).toISOString(),
    silentTabCount: diagnosticCount(input.silentTabCount), tabCount: diagnosticCount(input.tabCount),
    exceptionCode: input.exceptionCode ? diagnosticCode(input.exceptionCode) : '', leagues };
}
