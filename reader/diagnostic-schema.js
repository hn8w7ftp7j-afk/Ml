import { NBA_AUTHORITY_DIAGNOSTICS_VERSION, NBA_DIAGNOSTIC_TEAM_CODES } from './nba-authority-diagnostics.js';

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
const AUTHORITY_VERSION = 'SOCCER-AUTHORITY-DIAGNOSTICS-v1';
const PERIODS = ['FT', 'HT', 'UNKNOWN'];
const PAIR_COUNTS = ['sharedGames', 'leftOnlyGames', 'rightOnlyGames', 'sharedContracts', 'changedContracts', 'leftOnlyContracts', 'rightOnlyContracts', 'stateDifferences'];
const DIFFERENCES = ['PRICE', 'STATE', 'GAME_ONLY_LEFT', 'GAME_ONLY_RIGHT', 'CONTRACT_ONLY_LEFT', 'CONTRACT_ONLY_RIGHT'];
const dateValid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const sourceValid = value => Number.isInteger(value) && value >= 1 && value <= 4;
const pairValid = value => sourceValid(value?.leftSource) && sourceValid(value?.rightSource)
  && value.leftSource < value.rightSource && PERIODS.includes(value.period);
function authorityValue(field, value) {
  if (!['awayWater', 'homeWater', 'overWater', 'underWater', 'drawWater', 'line', 'lineSide', 'marketStatus'].includes(field)) return false;
  if (value === null) return true;
  if (['awayWater', 'homeWater', 'overWater', 'underWater', 'drawWater'].includes(field)) return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000;
  if (field === 'line') return typeof value === 'string' && /^(?:\d{1,3}(?:\.\d{1,3})?)(?:平|[+-]\d{1,3})?$/.test(value);
  if (field === 'lineSide') return ['home', 'away'].includes(value);
  if (field === 'marketStatus') return ['open', 'locked'].includes(value);
  return false;
}
// Both the installed Reader and the API run this allow-list. These values are
// diagnostic observations and never authorize a market or a score.
function authorityEvidence(input, league) {
  const expectedVersion = league === 'NBA' ? NBA_AUTHORITY_DIAGNOSTICS_VERSION : AUTHORITY_VERSION;
  const teamCodeValid = league === 'NBA' ? value => NBA_DIAGNOSTIC_TEAM_CODES.includes(value) : value => /^S[0-9A-F]{8}$/.test(value);
  if (input?.version !== expectedVersion) return null;
  const sources = (Array.isArray(input.sources) ? input.sources : []).slice(0, 4).filter(row => sourceValid(row?.index)).map(row => ({
    index: row.index, dates: [...new Set((Array.isArray(row.dates) ? row.dates : []).slice(0, 40).filter(dateValid))],
    periods: PERIODS.filter(period => Array.isArray(row.periods) && row.periods.includes(period)),
    ...Object.fromEntries(['gameCount', 'marketCount', 'invalidGameCount', 'invalidMarketCount'].map(key => [key, diagnosticCount(row[key])])),
  }));
  const pairIdentity = row => ({ leftSource: row.leftSource, rightSource: row.rightSource, period: row.period });
  const pairs = (Array.isArray(input.pairs) ? input.pairs : []).slice(0, 18).filter(pairValid).map(row => ({
    ...pairIdentity(row), ...Object.fromEntries(PAIR_COUNTS.map(key => [key, diagnosticCount(row[key])])),
  }));
  const differences = (Array.isArray(input.differences) ? input.differences : []).slice(0, 8)
    .filter(row => pairValid(row) && DIFFERENCES.includes(row.type) && dateValid(row.date)
      && typeof row.time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(row.time)
      && typeof row.awayCode === 'string' && typeof row.homeCode === 'string'
      && teamCodeValid(row.awayCode) && teamCodeValid(row.homeCode))
    .map(row => ({ ...pairIdentity(row), type: row.type, date: row.date, time: row.time, awayCode: row.awayCode, homeCode: row.homeCode,
      ...(['HANDICAP', 'TOTAL', 'MONEYLINE'].includes(row.marketKind) ? { marketKind: row.marketKind } : {}),
      ...(typeof row.line === 'string' && authorityValue('line', row.line) ? { line: row.line } : {}),
      ...(['home', 'away'].includes(row.lineSide) ? { lineSide: row.lineSide } : {}),
      fields: (Array.isArray(row.fields) ? row.fields : []).slice(0, 5)
        .filter(item => typeof item?.field === 'string' && authorityValue(item.field, item.left) && authorityValue(item.field, item.right))
        .map(item => ({ field: item.field, left: item.left, right: item.right })),
    }));
  return { version: expectedVersion, sourceCount: diagnosticCount(input.sourceCount), sources, pairs, differences,
    differenceCount: diagnosticCount(input.differenceCount), sourcesTruncated: input.sourcesTruncated === true,
    detailsTruncated: input.detailsTruncated === true, differencesTruncated: input.differencesTruncated === true };
}
export function sanitizeDiagnosticReport(input) {
  const created = typeof input?.createdAt === 'string' ? Date.parse(input.createdAt) : NaN;
  if (input?.schema !== DIAGNOSTIC_SCHEMA || !diagnosticIdValid(input?.reportId)
    || !version(input?.readerVersion) || !Number.isFinite(created)) throw Object.assign(new Error('診斷格式錯誤'), { status: 400 });
  const leagues = {};
  for (const league of DIAGNOSTIC_LEAGUES) {
    const row = input?.leagues?.[league];
    if (!row || !STATES.has(row.state)) continue;
    const authority = ['NBA', 'EPL', 'UCL'].includes(league) ? authorityEvidence(row.authority, league) : null;
    leagues[league] = { state: row.state, errorCode: row.errorCode ? diagnosticCode(row.errorCode) : '',
      issues: codes(row.issues), rawGameCount: diagnosticCount(row.rawGameCount), marketCount: diagnosticCount(row.marketCount),
      boards: (Array.isArray(row.boards) ? row.boards : []).slice(0, 2).map(board => ({
        diagnostics: counts(board?.diagnostics), parsedGameCount: diagnosticCount(board?.parsedGameCount),
        issues: codes(board?.issues),
      })), ...(authority ? { authority } : {}) };
  }
  return { schema: DIAGNOSTIC_SCHEMA, reportId: input.reportId, readerVersion: version(input.readerVersion),
    extensionManifestVersion: version(input.extensionManifestVersion), createdAt: new Date(created).toISOString(),
    silentTabCount: diagnosticCount(input.silentTabCount), tabCount: diagnosticCount(input.tabCount),
    exceptionCode: input.exceptionCode ? diagnosticCode(input.exceptionCode) : '', leagues };
}
