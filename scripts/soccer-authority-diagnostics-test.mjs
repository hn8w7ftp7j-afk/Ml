import assert from 'node:assert/strict';
import { parseSoccerCapture } from '../reader/soccer-parser.js';
import { buildSoccerAuthorityDiagnostics, SOCCER_AUTHORITY_DIAGNOSTICS_VERSION } from '../reader/soccer-authority-diagnostics.js';

const now = new Date('2026-10-24T22:00:00Z');
const candidate = (period = 'FT') => ({ tabId: 987654, frameId: 123456, parsed: parseSoccerCapture({
  league: 'EPL', pageLeagueLabel: '英格蘭超級聯賽', sourceHost: 'www.tai888.in',
  pageUrl: 'https://www.tai888.in/newapp/#secret', observedAt: now.toISOString(),
  tables: [{ sectionTitle: `英格蘭超級聯賽 ${period === 'HT' ? '上半場' : '全場'}`,
    headers: ['時間', '主客隊伍', `${period === 'HT' ? '上半場' : '全場'}讓球`, `${period === 'HT' ? '上半場' : '全場'}大小`, `${period === 'HT' ? '上半場' : '全場'}獨贏`],
    rows: [{ cells: [{ pair: ['10-25', '22:00'] }, { pair: ['布倫特福德', '侯城[主]'] },
      { pair: ['1平 0.95', '0.91'] }, { pair: ['大3+50 0.95', '小 0.89'] }, { pair: ['主勝 -', '和 -', '客勝 -'] }] }] }],
}, now) });
const inspect = (sources, options = {}) => buildSoccerAuthorityDiagnostics(sources, { league: 'EPL', ...options });
const base = candidate(), changed = structuredClone(base);
changed.parsed.games[0].markets[0].homeWater = 0.92;
const before = JSON.stringify([base, changed]);
const price = inspect([base, changed]);
assert.equal(price.version, SOCCER_AUTHORITY_DIAGNOSTICS_VERSION);
assert.equal(price.sourceCount, 2);
assert.deepEqual(price.sources.map(source => [source.index, source.dates, source.periods]), [[1, ['2026-10-25'], ['FT']], [2, ['2026-10-25'], ['FT']]]);
assert.equal(price.pairs[0].sharedGames, 1);
assert.equal(price.pairs[0].changedContracts, 1);
assert.deepEqual(price.differences[0].fields, [{ field: 'homeWater', left: 0.91, right: 0.92 }]);
assert.equal(price.differences[0].type, 'PRICE');
assert.match(price.differences[0].awayCode, /^S[0-9A-F]{8}$/);
assert.match(price.differences[0].homeCode, /^S[0-9A-F]{8}$/);
assert.equal(JSON.stringify([base, changed]), before, 'diagnostics cannot alter original parser evidence');
assert.deepEqual(inspect([base, structuredClone(base)]).differences, []);
const separatePeriods = inspect([base, candidate('HT')]);
assert.deepEqual(separatePeriods.pairs, [], 'FT and HT are separate contracts, not conflicting prices');
assert.deepEqual(separatePeriods.differences, []);
assert.deepEqual(inspect([base, candidate('HT')], { period: 'HT' }).sources[0].periods, []);
assert.equal(inspect([base], { period: 'UNTRUSTED' }), null);
assert.equal(buildSoccerAuthorityDiagnostics([base], { league: 'NBA' }), null);

const otherDate = structuredClone(base);
otherDate.parsed.games[0].boardDate = '2026-10-26';
const dates = inspect([base, otherDate]);
assert.equal(dates.pairs[0].sharedGames, 0);
assert.equal(dates.pairs[0].leftOnlyGames, 1);
assert.equal(dates.pairs[0].rightOnlyGames, 1);
assert.deepEqual(dates.differences.map(row => [row.type, row.date]), [['GAME_ONLY_LEFT', '2026-10-25'], ['GAME_ONLY_RIGHT', '2026-10-26']]);
const otherSlate = structuredClone(base);
otherSlate.parsed.games[0].awayCode = 'S00000001';
assert.equal(inspect([base, otherSlate]).pairs[0].sharedGames, 0, 'same date and time do not merge distinct team pairs');
const otherLine = structuredClone(base);
otherLine.parsed.games[0].markets[0].line = '1-20';
const lines = inspect([base, otherLine]);
assert.equal(lines.pairs[0].changedContracts, 0, 'different contracts are not labelled same-contract price changes');
assert.equal(lines.pairs[0].leftOnlyContracts, 1);
assert.equal(lines.pairs[0].rightOnlyContracts, 1);
assert.deepEqual(lines.differences.map(row => row.type), ['CONTRACT_ONLY_LEFT', 'CONTRACT_ONLY_RIGHT']);
assert.deepEqual(lines.differences[0].fields, [{ field: 'line', left: '1平', right: null }, { field: 'lineSide', left: 'away', right: null }]);
const locked = structuredClone(base);
Object.assign(locked.parsed.games[0], { markets: [], marketStatus: 'locked', periodStates: { FT: 'locked' } });
const states = inspect([base, locked]);
assert.equal(states.pairs[0].stateDifferences, 1);
assert.deepEqual(states.differences[0].fields, [{ field: 'marketStatus', left: 'open', right: 'locked' }]);

const poison = 'password=secret-cookie-token';
const dirty = structuredClone(base);
dirty.parsed.games[0].markets[0].homeWater = poison;
dirty.parsed.games[0].markets[1].line = poison;
dirty.parsed.games.push({ ...structuredClone(base.parsed.games[0]), awayCode: poison, boardDate: poison });
dirty.parsed.games[0].homeRaw = poison;
dirty.parsed.games[0].markets[0].rawRows = [poison];
dirty.capture = { pageUrl: poison, cookie: poison, tables: [poison] };
const clean = inspect([base, dirty]);
assert.equal(clean.sources[1].invalidGameCount, 1);
assert.equal(clean.sources[1].invalidMarketCount, 2);
for (const text of [poison, 'tai888.in', '侯城', '布倫特福德', '987654', '123456', 'sourceCapture', 'rawRows', 'tabId', 'frameId']) {
  assert.equal(JSON.stringify(clean).includes(text), false, `diagnostics must not copy ${text}`);
}
const many = Array.from({ length: 5 }, (_, index) => {
  const value = structuredClone(base);
  value.parsed.games = Array.from({ length: 10 }, (_, gameIndex) => ({ ...structuredClone(base.parsed.games[0]),
    boardTime: `${String(10 + gameIndex).padStart(2, '0')}:00`,
    markets: base.parsed.games[0].markets.map(market => ({ ...market, homeWater: market.homeWater == null ? undefined : market.homeWater + index / 100 })) }));
  return value;
});
const bounded = inspect(many);
assert.equal(bounded.sourceCount, 5);
assert.equal(bounded.sources.length, 4);
assert.equal(bounded.sourcesTruncated, true);
assert.equal(bounded.differences.length, 8);
assert.equal(bounded.differencesTruncated, true);
assert.equal(bounded.differenceCount, 60, 'difference count describes all retained-source comparisons, not only rendered samples');
const oversized = structuredClone(base);
oversized.parsed.games = Array.from({ length: 41 }, () => structuredClone(base.parsed.games[0]));
assert.equal(inspect([oversized]).detailsTruncated, true);
assert.deepEqual(inspect(null).sources, []);
console.log('PASS football authority diagnostics: typed price/state/contract/date/slate differences, independent periods, anonymous bounded sources, parser-code identities, strict text redaction, immutable evidence and explicit truncation');

const { sanitizeDiagnosticReport } = await import('../reader/diagnostic-schema.js');
const { randomUUID } = await import('node:crypto');
const diagnosticFixture = {
  version: 'SOCCER-AUTHORITY-DIAGNOSTICS-v1', sourceCount: 2,
  sources: [{ index: 1, dates: ['2026-10-25'], periods: ['FT'], gameCount: 5, marketCount: 10 }], pairs: [],
  differences: [{ leftSource: 1, rightSource: 2, period: 'FT', type: 'PRICE', date: '2026-10-25', time: '22:00',
    awayCode: 'S01234567', homeCode: 'S89ABCDEF', marketKind: 'TOTAL', line: '3+50',
    fields: [{ field: 'overWater', left: 0.9, right: 0.91 }] }], differenceCount: 1,
};
const poisonText = 'password=private-url-cookie';
const reportFixture = { schema: 'READER-DIAGNOSTICS-v1', reportId: randomUUID(), readerVersion: '2.1.43', createdAt: new Date().toISOString(),
  leagues: { EPL: { state: 'error', authority: structuredClone(diagnosticFixture) }, NBA: { state: 'error', authority: diagnosticFixture } } };
reportFixture.leagues.EPL.authority.url = poisonText;
reportFixture.leagues.EPL.authority.sources[0].dates.push(poisonText, '2026-02-30');
reportFixture.leagues.EPL.authority.sources[0].periods.push(poisonText);
reportFixture.leagues.EPL.authority.differences[0].fields.push({ field: poisonText, left: null, right: null }, { field: 'line', left: poisonText, right: null });
reportFixture.leagues.EPL.authority.differences.push({ ...diagnosticFixture.differences[0], awayCode: poisonText });
const sanitized = sanitizeDiagnosticReport(reportFixture);
assert.doesNotMatch(JSON.stringify(sanitized), /password=|private-url-cookie|2026-02-30/);
assert.equal(sanitized.leagues.NBA.authority, undefined, 'football evidence cannot expand other-league diagnostic payloads');
assert.deepEqual(sanitized.leagues.EPL.authority.differences, diagnosticFixture.differences);
assert.deepEqual(sanitizeDiagnosticReport(sanitized), sanitized, 'Reader and API sanitization must be idempotent');
console.log('PASS double-boundary football authority allow-list: typed evidence preserved, malformed dates/codes/text and null-valued unknown fields removed, NBA unchanged');
