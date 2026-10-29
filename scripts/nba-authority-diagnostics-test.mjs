import assert from 'node:assert/strict';
import { buildNbaAuthorityDiagnostics, NBA_AUTHORITY_DIAGNOSTICS_VERSION } from '../reader/nba-authority-diagnostics.js';
import { sanitizeDiagnosticReport } from '../reader/diagnostic-schema.js';

const candidate = () => ({ tabId: 987654, frameId: 123456, capture: { pageUrl: 'https://private-url-cookie/password=secret' }, parsed: { league: 'NBA', games: [{
  awayCode: 'WSH', homeCode: 'CHA', awayRaw: 'password=secret', boardDate: '2026-10-30', boardTime: '07:00',
  fullRunline: { line: '3+50', lineSide: 'home', awayWater: 0.95, homeWater: 0.95 },
  fullTotal: { line: '235.5', overWater: 0.94, underWater: 0.94 },
  firstHalfRunline: { line: '1.5', lineSide: 'home', awayWater: 0.94, homeWater: 0.94 },
  firstHalfTotal: { line: '118平', overWater: 0.94, underWater: 0.94 },
}] } });
const left = candidate(), right = candidate();
right.parsed.games[0].fullRunline.homeWater = 0.93;
const before = JSON.stringify([left, right]);
const price = buildNbaAuthorityDiagnostics([left, right]);
assert.equal(price.version, NBA_AUTHORITY_DIAGNOSTICS_VERSION);
assert.deepEqual(price.sources.map(row => [row.dates, row.periods, row.marketCount]), [
  [['2026-10-30'], ['FT', 'HT'], 4], [['2026-10-30'], ['FT', 'HT'], 4],
]);
assert.equal(price.pairs[0].changedContracts, 1);
assert.deepEqual(price.differences[0], { leftSource: 1, rightSource: 2, period: 'FT', date: '2026-10-30', time: '07:00', awayCode: 'WSH', homeCode: 'CHA',
  type: 'PRICE', marketKind: 'HANDICAP', line: '3+50', lineSide: 'home', fields: [{ field: 'homeWater', left: 0.95, right: 0.93 }] });
assert.equal(JSON.stringify([left, right]), before, 'diagnostics never rewrite original quotes');
assert.deepEqual(buildNbaAuthorityDiagnostics([left, structuredClone(left)]).differences, []);

const changedDate = candidate(); changedDate.parsed.games[0].boardDate = '2026-10-31';
assert.deepEqual(buildNbaAuthorityDiagnostics([left, changedDate]).differences.map(row => row.type),
  ['GAME_ONLY_LEFT', 'GAME_ONLY_RIGHT', 'GAME_ONLY_LEFT', 'GAME_ONLY_RIGHT']);
const changedLine = candidate(); changedLine.parsed.games[0].firstHalfRunline.line = '1平';
const lines = buildNbaAuthorityDiagnostics([left, changedLine]);
assert.deepEqual(lines.differences.map(row => [row.period, row.type, row.line]), [['HT', 'CONTRACT_ONLY_LEFT', '1.5'], ['HT', 'CONTRACT_ONLY_RIGHT', '1平']]);
const locked = candidate(); locked.parsed.games[0] = { awayCode: 'WSH', homeCode: 'CHA', boardDate: '2026-10-30', boardTime: '07:00', marketStatus: 'locked' };
assert.equal(buildNbaAuthorityDiagnostics([left, locked]).differences[0].type, 'STATE');

const malicious = candidate(); malicious.parsed.games[0].awayCode = 'password=secret';
assert.equal(buildNbaAuthorityDiagnostics([malicious]).sources[0].invalidGameCount, 1);
const report = { schema: 'READER-DIAGNOSTICS-v1', reportId: '11111111-1111-4111-8111-111111111111', readerVersion: '2.1.46', createdAt: '2026-10-29T23:00:00Z',
  leagues: { NBA: { state: 'error', authority: structuredClone(price) }, EPL: { state: 'error', authority: price } } };
report.leagues.NBA.authority.url = 'https://private-url-cookie/password=secret';
report.leagues.NBA.authority.differences.push({ ...price.differences[0], awayCode: 'password=secret' });
report.leagues.NBA.authority.differences[0].fields.push({ field: 'password=secret', left: null, right: null });
const sanitized = sanitizeDiagnosticReport(report);
assert.deepEqual(sanitized.leagues.NBA.authority, price);
assert.equal(sanitized.leagues.EPL.authority, undefined, 'NBA evidence cannot be imported as football evidence');
assert.doesNotMatch(JSON.stringify(sanitized), /password=|private-url-cookie|987654|123456/);
assert.deepEqual(sanitizeDiagnosticReport(sanitized), sanitized, 'Reader and API keep the same strict boundary');

const many = Array.from({ length: 8 }, (_, i) => {
  const source = candidate(); source.parsed.games = Array.from({ length: 60 }, (_, j) => ({ ...source.parsed.games[0], boardTime: `${String(j % 24).padStart(2, '0')}:00`,
    fullTotal: { line: String(200 + i), overWater: 0.94, underWater: 0.94 } })); return source;
});
const bounded = buildNbaAuthorityDiagnostics(many);
assert.equal(bounded.sourceCount, 8);
assert.equal(bounded.sources.length, 4);
assert.equal(bounded.differences.length, 8);
assert.equal(bounded.sourcesTruncated, true);
assert.equal(bounded.detailsTruncated, true);
assert.equal(bounded.differencesTruncated, true);
const sizeReport = sanitizeDiagnosticReport({ ...report, leagues: { NBA: { state: 'error', authority: bounded } } });
assert.ok(Buffer.byteLength(JSON.stringify(sizeReport)) < 49152);
console.log('PASS NBA authority diagnostics: exact price/line/date/state differences, bounded sources and payload, public team aliases, no raw text or browser identifiers, immutable quotes and league-specific double sanitization');
