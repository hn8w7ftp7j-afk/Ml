import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from '../reader/parser.js';
import { selectAuthoritativeBoard, readerPayloadsByDate, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { validateNhlCapture } from '../lib/nhl/reader.js';
import { validateNhlObservation } from '../lib/nhl/store.js';
import { VERIFIED_NHL_MARKET_MANIFEST } from '../lib/nhl/contracts.js';

// Synthetic DOM/transport boundary fixtures. No real Tai888 quote/rule evidence.
const context = { globalThis: {} };
vm.createContext(context);
for (const name of ['capture-policy.js', 'league-registry.js', 'nhl-teams.js', 'row-normalizer.js']) vm.runInContext(fs.readFileSync(`reader/${name}`, 'utf8'), context);
const { Tai888LeagueRegistry: registry, Tai888RowNormalizer: normalizer, Tai888NhlTeams: teams } = context.globalThis;
assert.deepEqual([...registry.ids], ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'NHL', 'EPL', 'UCL']);
for (const heading of ['聯盟：NHL 國家冰球聯盟(1)', '聯盟：NHL 美國職業冰球-熱身賽(1)', '聯盟：NHL(1)']) assert.equal(registry.standardMarker(heading, 'NHL'), true);
// Screenshot 2026-10-18: the NHL label is adjacent to Chinese and the standard
// full-game section explicitly includes OT/SO. This is label evidence only.
const screenshotHeading = '聯盟：NHL美式冰球--包括加時與點球(2)';
for (const heading of [screenshotHeading, '聯盟：NHL 美式冰球－包括加時與點球(2)', '联盟：NHL美式冰球-包括加时与点球(2)']) {
  assert.equal(registry.identify(heading), 'NHL');
  assert.equal(registry.standardMarker(heading, 'NHL'), true, heading);
}
for (const heading of ['聯盟：NHLX美式冰球(2)', '聯盟：KHL俄羅斯冰球(9)', `${screenshotHeading} 第一節`, `${screenshotHeading} 正規時間`, `${screenshotHeading} 加時`, `${screenshotHeading} 主隊總得分`]) {
  assert.equal(registry.standardMarker(heading, 'NHL'), false, heading);
}
for (const suffix of ['LIVE', '走地', '第一節', '上半', '正規時間', '60分鐘', 'OVERTIME', '主隊總得分']) assert.equal(registry.standardMarker(`聯盟：NHL 冰球 ${suffix}(1)`, 'NHL'), false);
assert.equal(registry.identify('NHL 導覽'), null);
assert.equal(registry.identify('聯盟：NBA NHL 球隊'), 'NBA');
assert.equal(teams.byCode('UTA').teamId, 68, 'current Mammoth identity must not inherit historical Hockey Club 59');
assert.equal(teams.resolve('BOS-楓葉'), null, 'conflicting NHL name/code cannot identify a team');
assert.deepEqual(readerMarketProperties('NHL'), ['fullRunline', 'fullTotal']);

const now = new Date('2026-10-12T08:00:00Z');
const names = ['時間', '主客隊伍', '讓球', '大小盤', '獨贏', '單雙'];
const record = (order, values) => ({ order, top: order * 25, bottom: order * 25 + 20, text: values.filter(Boolean).join(' '), cells: values.map((text, i) => ({ text, left: i * 100, right: (i + 1) * 100, rows: text ? [{ text, top: order * 25, left: i * 100 }] : [], lines: text ? [text] : [] })) });
const records = [record(0, names), record(1, ['聯盟：NHL 國家冰球聯盟(2)']), record(2, ['10-13', 'BOS 棕熊', '1 + 50 0.950', '6 - 50 大 0.970', '1.150', '單 0.940']), record(3, ['07:00', 'TOR 楓葉[主]', '0.930', '小 0.910', '0.750', '雙 0.940']), record(4, ['10-14', 'UTA 猶他猛獁', '', '6.5 大 0.950', '0.800', '']), record(5, ['08:00', 'SEA 海怪[主]', '', '小 0.950', '1.100', ''])];
const normalized = normalizer.normalizeRowRecords(records, { expectedLeague: 'NHL' });
// Reproduce the mixed ice-hockey table: unrelated league above and below NHL.
const mixed = [record(0, names), record(1, ['聯盟：KHL俄羅斯冰球(1)']),
  record(2, ['10-13', 'BOS 棕熊', '2 0.950', '5.5 大 0.950']), record(3, ['07:00', 'TOR 楓葉[主]', '0.950', '小 0.950']),
  ...records.slice(1).map((row, index) => record(index + 4, index === 0 ? [screenshotHeading] : row.cells.map(cell => cell.text))),
  record(9, ['聯盟：NHL美式冰球-第一節(1)']),
  record(10, ['10-13', 'BOS 棕熊', '3 0.950', '2.5 大 0.950']), record(11, ['07:00', 'TOR 楓葉[主]', '0.950', '小 0.950'])];
const mixedNormalized = normalizer.normalizeRowRecords(mixed, { expectedLeague: 'NHL' });
assert.equal(mixedNormalized.diagnostics.gameCount, 2, 'only NHL full-game rows are captured');
assert.equal(mixedNormalized.diagnostics.expectedGameCount, 2);
assert.equal(mixedNormalized.diagnostics.pageLeagueLabel, screenshotHeading);
assert.equal(normalized.diagnostics.gameCount, 2);
assert.equal(normalized.diagnostics.pageLeagueLabel, '聯盟：NHL 國家冰球聯盟(2)');
assert.equal(normalizer.normalizeRowRecords(records, { expectedLeague: 'NBA' }).tables.length, 0);
const capture = { league: 'NHL', sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/?account=private#/BS?session=private', observedAt: now.toISOString(), pageLeagueLabel: normalized.diagnostics.pageLeagueLabel, tables: normalized.tables, diagnostics: normalized.diagnostics };
const parsed = parseTai888Capture(capture, now);
Object.assign(parsed, { readerVersion: '2.1.39', expectedGameCount: 2, detectedGameCount: 2, pageActivityAt: now.toISOString() });
assert.equal(parsed.pageUrl.includes('private'), false);
assert.deepEqual(parsed.games.map(game => [game.awayAbbrev, game.awayTeamId, game.homeAbbrev, game.homeTeamId]), [['BOS', 6, 'TOR', 10], ['UTA', 68, 'SEA', 55]]);
assert.equal(parsed.games[0].fullRunline.line, '1+50');
assert.equal(parsed.games[0].fullTotal.line, '6-50');
assert.equal(Object.hasOwn(parsed.games[0], 'first5Runline'), false);
assert.equal(Object.hasOwn(parsed.games[0], 'firstHalfRunline'), false);
assert.equal(parsed.games[0].rawMarketEvidence.find(row => row.label === '單雙').rawRows[0], '單 0.940');
assert.equal(parsed.games[0].rawMarketEvidence.find(row => row.key === 'moneyline').rawRows[0], '1.150');
assert.equal(selectAuthoritativeBoard([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { league: 'NHL', now: +now }).ok, true);
const dates = readerPayloadsByDate(parsed);
assert.deepEqual(dates.map(payload => payload.boardDate), ['2026-10-13', '2026-10-14']);
const wire = nhlReaderEvidencePayload(dates[0]);
const result = validateNhlCapture(wire, { now: +now, headerVersion: '2.1.39' });
assert.equal(result.ok, true, JSON.stringify(result.errors));
assert.equal(result.payload.games[0].parsedMarkets.fullTotal.line, '6-50');
assert.equal(result.payload.games[0].rawRowText.includes('單'), true);
assert.equal(result.payload.games[0].includesOvertime, null);
assert.equal(result.payload.games[0].shootoutRule, null);
assert.equal(result.payload.games[0].voidRuleId, null);
assert.equal(result.payload.executable, false);
const screenshotCapture = { ...capture, pageLeagueLabel: screenshotHeading, tables: mixedNormalized.tables, diagnostics: mixedNormalized.diagnostics };
const screenshotParsed = parseTai888Capture(screenshotCapture, now);
screenshotParsed.readerVersion = '2.1.39';
const screenshotWire = nhlReaderEvidencePayload(readerPayloadsByDate(screenshotParsed)[0]);
const screenshotResult = validateNhlCapture(screenshotWire, { now: +now, headerVersion: '2.1.39' });
assert.equal(screenshotResult.ok, true, JSON.stringify(screenshotResult.errors));
assert.equal(screenshotResult.payload.games[0].parsedMarkets.fullRunline.line, '1+50', 'no other-league quote leakage');
assert.equal(screenshotResult.payload.games[0].includesOvertime, null, 'heading alone does not verify settlement');
assert.equal(screenshotResult.payload.games[0].shootoutRule, null);
assert.equal(screenshotResult.payload.executable, false);
assert.equal(validateNhlObservation('READER', wire.boardDate, result.payload, { now: +now }).ok, true);
assert.deepEqual(VERIFIED_NHL_MARKET_MANIFEST, []);
const swapped = { ...capture, tables: [{ headers: names.slice(0, 4), rows: [{ cells: [
  { pair: ['10-13', '07:00'] }, { pair: ['TOR-楓葉[主]', 'BOS-棕熊'] },
  { pair: ['0.930', '1+50 0.950'] }, { pair: ['6-50 大 0.970', '小 0.910'] },
] }] }] };
const swappedParsed = parseTai888Capture(swapped, now); swappedParsed.readerVersion = '2.1.39';
const swappedResult = validateNhlCapture(nhlReaderEvidencePayload(swappedParsed), { now: +now });
assert.equal(swappedResult.ok, true);
assert.equal(swappedResult.payload.games[0].parsedMarkets.fullRunline.lineSide, 'away');
assert.equal(swappedResult.payload.games[0].parsedMarkets.fullRunline.awayWater, 0.95);
for (const mutation of [
  input => { input.league = 'NBA'; },
  input => { input.pageLeagueLabel = '聯盟：NHL 第一節(1)'; },
  input => { input.games[0].homeRaw = 'TOR-楓葉'; },
  input => { input.games[0].awayTeamId = 59; },
  input => { input.games[0].awayRaw = 'BOS-楓葉'; },
  input => { input.games[0].teamEvidence = null; },
  input => { input.games[0].executable = true; },
  input => { input.games[0].rawRows[0].lineText = 'forged'; },
  input => { input.rawRows.push({ ...input.rawRows[0] }); },
  input => { input.games.push({ ...input.games[0] }); },
  input => { input.games[0].rawMarketEvidence[0].rawRows = null; },
]) {
  const forged = structuredClone(wire); mutation(forged);
  assert.equal(validateNhlCapture(forged, { now: +now }).ok, false, mutation.toString());
}
assert.equal(validateNhlCapture(wire, { now: +now + 301000 }).ok, false);
assert.equal(validateNhlCapture(wire, { now: +now, headerVersion: '2.1.30' }).ok, false);
const rawOnly = { ...wire }; delete rawOnly.games;
assert.equal(validateNhlCapture(rawOnly, { now: +now }).ok, true, 'legacy evidence-only raw capture remains ingestible');
const unknownGrammar = structuredClone(dates[0]);
unknownGrammar.games[0].rawMarketEvidence.find(row => row.key === 'runline').rawRows = ['UNKNOWN CONTRACT 0.950', '0.940'];
const unknown = validateNhlCapture(nhlReaderEvidencePayload(unknownGrammar), { now: +now });
assert.equal(unknown.ok, true, 'unknown quote grammar is preserved as evidence without execution');
assert.equal(unknown.payload.games[0].parsedMarkets.fullRunline, null);
const duplicates = structuredClone(capture); duplicates.tables[0].rows.push(structuredClone(duplicates.tables[0].rows[0]));
assert.equal(parseTai888Capture(duplicates, now).games.length, 2);
duplicates.tables[0].rows[2].marketEvidence.find(value => value.key === 'moneyline').pair[0] = '1.160';
assert.ok(parseTai888Capture(duplicates, now).parseIssues.some(value => value.startsWith('conflicting-duplicate:')), 'moneyline raw contradictions cannot be silently lost');
assert.notEqual(canonicalReaderPayload(dates[0]), canonicalReaderPayload({ ...dates[0], games: unknownGrammar.games }));

// Execute the real service worker upload loop. The sink validates the exact
// NHL envelope and the old NBA date route independently; no database writes.
const liveNow = new Date();
const liveCapture = structuredClone(capture); liveCapture.observedAt = liveNow.toISOString(); liveCapture.diagnostics.lastMutationAt = liveNow.toISOString();
const nbaCapture = { league: 'NBA', sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/#/BS', observedAt: liveNow.toISOString(), tables: [{ headers: names.slice(0, 4), rows: [{ cells: [{ pair: ['10-13', '07:00'] }, { pair: ['BOS-塞爾提克', 'TOR-暴龍[主]'] }, { pair: ['1+50 0.950', '0.950'] }, { pair: ['225.5 大 0.950', '小 0.950'] }] }] }], diagnostics: { expectedGameCount: 1, gameCount: 1, lastMutationAt: liveNow.toISOString() } };
const state = { deviceId: 'synthetic-reader-device', readerToken: 'synthetic-reader-token', autoEnabled: true };
const event = { addListener() {} }; const uploaded = [];
const chrome = {
  runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
  tabs: { onUpdated: event, query: async () => [{ id: 7, active: true }], sendMessage: async () => ({ ok: true, capture: { readerVersion: '2.1.39', captures: [liveCapture, nbaCapture] } }) },
  webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
  storage: { local: { get: async () => state, set: async values => Object.assign(state, values), remove: async () => {} } },
};
const worker = { chrome, Date, URL, setTimeout, clearTimeout, queueMicrotask, TextEncoder, AbortController, crypto: webcrypto,
  parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload, selectAuthoritativeBoard, readerPayloadsByDate, shouldSkipSuccessfulPayload,
  fetch: async (url, options) => {
    const input = JSON.parse(options.body); uploaded.push({ url, input });
    assert.equal(options.headers['X-Device-Id'], state.deviceId);
    assert.equal(options.headers.Authorization, `Bearer ${state.readerToken}`);
    if (input.league === 'NHL') {
      assert.match(url, /\/api\/nhl\/reader$/);
      assert.equal(validateNhlCapture(input, { headerVersion: '2.1.39' }).ok, true);
    } else { assert.equal(input.league, 'NBA'); assert.match(url, /\/api\/nba\/reader$/); }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, rawGameCount: input.games.length, marketCount: input.league === 'NHL' ? 2 : 1, executable: false }) };
  },
};
vm.createContext(worker);
vm.runInContext(fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, ''), worker);
const synced = await vm.runInContext("performSync('manual')", worker);
assert.equal(synced.ok, true, JSON.stringify({synced, statuses: state.readerStatuses}));
assert.equal(uploaded.filter(value => value.input.league === 'NHL').length, 2);
assert.equal(uploaded.filter(value => value.input.league === 'NBA').length, 1);
assert.equal(state.readerStatuses.NHL.executable, false);
assert.equal(state.readerStatuses.NHL.captureOnly, true);
assert.deepEqual([...state.readerStatuses.NHL.boardDates], ['2026-10-13', '2026-10-14']);
assert.equal(Object.hasOwn(state.lastSuccessfulPayloadHashes, 'NHL:2026-10-13'), true);
console.log('NHL Reader synthetic raw DOM → isolated authority → multi-date signed upload → server reparse/evidence persistence boundaries PASS; live Tai888 DOM/quotes/rules NOT VERIFIED');
