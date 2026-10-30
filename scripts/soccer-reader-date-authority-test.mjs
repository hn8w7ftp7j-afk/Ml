import { readFileSync as readNbaRecoverySource } from 'node:fs';
import { installArchiveWorkerFixture } from './reader-archive-receipt-fixture.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { register } from 'node:module';
import { parseTai888Capture, canonicalReaderPayload, readerMarketProperties, nhlReaderEvidencePayload } from '../reader/parser.js';
import { selectAuthoritativeBoard, selectAuthoritativeSoccerBoards, readerPayloadsByDate, shouldSkipSuccessfulPayload } from '../reader/board-selector.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';
import { canonicalSoccerPayload, SOCCER_SOURCE_SCOPE_VERSION } from '../reader/soccer-parser.js';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';

// Synthetic dated boards exercise the shipped parser, source selector, worker,
// server reparse and immutable PostgreSQL save. Never fetch a live bookmaker or
// treat these fixtures as an actual historical source receipt.
const now = Date.parse('2026-10-24T22:00:00Z'), at = new Date(now).toISOString();
const version = JSON.parse(fs.readFileSync('reader/manifest.json')).version;
const background = fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, line => line.includes('./nba-conflict-recovery.js') ? readNbaRecoverySource('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : '');
const labels = { EPL: '英格蘭超級聯賽', UCL: '歐洲冠軍聯賽' };
const plain = value => JSON.parse(JSON.stringify(value));
const cell = pair => ({ pair });
function board(league, dates, { period = 'FT', water = '0.95', locked = false, titleScope = false } = {}) {
  const prefix = period === 'FT' ? '全場' : period === 'HT' ? '上半場' : '';
  return { league, pageLeagueLabel: labels[league], sourceHost: 'www.tai888.in',
    pageUrl: 'https://www.tai888.in/newapp/', observedAt: at,
    tables: [{ sectionTitle: `${labels[league]}${titleScope ? ` ${prefix}` : ''}`,
      headers: ['時間', '主客隊伍', `${titleScope ? '' : prefix}讓球`, `${titleScope ? '' : prefix}大小`, `${titleScope ? '' : prefix}獨贏`],
      rows: dates.map(date => ({ cells: [cell([date, '22:00']), cell(['布倫特福德', '侯城[主]']),
        cell(locked ? ['-', '-'] : [`1平 ${water}`, '0.91']),
        cell(locked ? ['-', '-'] : ['大3+50 0.95', '小 0.89']), cell(['主勝 -', '和 -', '客勝 -'])] })) }],
    diagnostics: { expectedGameCount: dates.length, gameCount: dates.length, lastMutationAt: at } };
}
const candidate = (capture, tabId = 1, frameId = 0) => ({ capture,
  parsed: parseTai888Capture(capture, new Date(now)), tabId, frameId,
  active: tabId === 1, lastAccessed: tabId });
function select(captures, league = 'EPL') {
  return selectAuthoritativeSoccerBoards(captures.map((capture, index) => candidate(capture, index + 1)), { league, now });
}
for (const league of ['EPL', 'UCL']) for (const period of ['FT', 'HT', 'UNKNOWN']) {
  const sources = [board(league, ['10-25'], { period }), board(league, ['10-26'], { period })];
  const before = JSON.stringify(sources), result = select(sources, league);
  assert.equal(result.ok, true, `${league} ${period}: distinct dates are independent contracts`);
  assert.deepEqual(result.scopeSelections.map(row => [row.boardDate, row.period]), [['2026-10-25', period], ['2026-10-26', period]]);
  assert.deepEqual(result.selections.map(row => row.boardDates), [['2026-10-25'], ['2026-10-26']]);
  assert.equal(JSON.stringify(sources), before, 'authority does not relabel captured dates or mutate raw sources');
}
const ft = board('EPL', ['10-25']), tomorrow = board('EPL', ['10-26']);
assert.equal(select([ft, structuredClone(ft)]).selections.length, 1, 'identical same-date sources deduplicate');
const changedLine = board('EPL', ['10-25']); changedLine.tables[0].rows[0].cells[2].pair[0] = '1.5 0.95';
for (const other of [board('EPL', ['10-25'], { water: '0.96' }), board('EPL', ['10-25'], { locked: true }), changedLine]) {
  const result = select([ft, tomorrow, other]);
  assert.equal(result.ok, false, 'an independent good date cannot rescue a shared-date price or lock conflict');
  assert.equal(result.boardDate, '2026-10-25'); assert.equal(result.selections.length, 0);
}
const sameTab = selectAuthoritativeSoccerBoards([candidate(ft, 1, 0), candidate(tomorrow, 1, 2)], { league: 'EPL', now });
assert.equal(sameTab.ok, true, 'separate dated frames are not duplicate same-date boards');
assert.equal(select([ft, board('EPL', ['10-25'], { period: 'HT', water: '0.87' })]).ok, true, 'same-day FT/HT prices remain separate');
assert.equal(selectAuthoritativeSoccerBoards([candidate(ft)], { league: 'NBA', now }).ok, false);
const invalid = board('EPL', ['10-25', '10-26']); invalid.tables[0].rows[1].cells[1].pair = ['侯城', '侯城[主]'];
assert.equal(select([invalid]).ok, false, 'an invalid row on another date cannot be hidden by date projection');

class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
async function workerFlow(captures, { persist = null, selector = selectAuthoritativeSoccerBoards } = {}) {
  const event = { addListener() {} }, state = { readerToken: 'synthetic-date-token', deviceId: 'synthetic-date-device' }, uploads = [];
  const tabs = captures.map((_capture, index) => ({ id: index + 1, active: index === 0, lastAccessed: index + 1 }));
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event }, alarms: { onAlarm: event },
    tabs: { onUpdated: event, query: async () => tabs, sendMessage: async tabId => ({ ok: true,
      capture: { readerVersion: version, captures: [captures[tabId - 1]] } }) },
    webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
    storage: { local: { get: async () => structuredClone(state), set: async value => Object.assign(state, structuredClone(value)), remove: async () => {} } } };
  const worker = vm.createContext({ chrome, Date: Clock, URL, setTimeout, clearTimeout, queueMicrotask,
    TextEncoder, AbortController, crypto: webcrypto, parseTai888Capture, canonicalReaderPayload,
    readerMarketProperties, nhlReaderEvidencePayload, selectAuthoritativeBoard,
    selectAuthoritativeSoccerBoards: selector, readerPayloadsByDate, shouldSkipSuccessfulPayload,
    fetch: async (url, options) => {
      assert.equal(url, 'https://mlb-positive-ev.vercel.app/api/soccer/reader');
      const payload = JSON.parse(options.body); uploads.push(payload);
      const checked = validateSoccerCapture(payload, { now, headerVersion: version });
      assert.equal(checked.ok, true, JSON.stringify(checked.errors));
      assert.ok(captures.some(capture => JSON.stringify(capture.tables) === JSON.stringify(payload.sourceCapture.tables)), 'the full original raw source survives date authority');
      assert.equal(payload.observedAt, at); assert.equal(payload.executable, false);
      assert.ok(payload.games.every(game => game.boardDate === payload.boardDate));
      const data = persist ? await persist(payload) : readerSaveReceiptFixture(payload);
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    } });
  installArchiveWorkerFixture(worker);
  vm.runInContext(background, worker);
  const run = reason => vm.runInContext(`performSync('${reason}')`, worker);
  const first = await run('manual'); return { first, state, uploads, run };
}
for (const league of ['EPL', 'UCL']) {
  const flow = await workerFlow([board(league, ['10-25']), board(league, ['10-26'])]);
  assert.equal(flow.first.ok, true);
  assert.deepEqual(flow.uploads.map(body => [body.league, body.boardDate]), [[league, '2026-10-25'], [league, '2026-10-26']]);
  assert.deepEqual(Object.keys(flow.state.lastSuccessfulSyncAts).sort(), [`${league}:2026-10-25:FT`, `${league}:2026-10-26:FT`]);
  flow.uploads.length = 0; await flow.run('alarm'); assert.equal(flow.uploads.length, 0, 'each dated saved receipt independently throttles its heartbeat');
}
const conflictFlow = await workerFlow([ft, tomorrow, board('EPL', ['10-25'], { water: '0.96' })]);
assert.equal(conflictFlow.first.ok, false); assert.equal(conflictFlow.uploads.length, 0);
assert.equal(conflictFlow.state.readerStatuses.EPL.diagnosticCode, 'conflicting-duplicate-tabs');
const noDates = await workerFlow([ft], { selector: (...args) => {
  const result = selectAuthoritativeSoccerBoards(...args); return { ...result, selections: result.selections.map(({ sourceScopes, ...row }) => row) };
} });
assert.equal(noDates.first.ok, false); assert.equal(noDates.uploads.length, 0);
assert.equal(noDates.state.readerStatuses.EPL.diagnosticCode, 'soccer-authority-date-missing');

// The active single-day frame wins only tomorrow; the multi-day frame wins
// only today. Distinct raw headers are equivalent contracts but preserve their
// own provenance. Replaying the whole multi-day original would upload tomorrow
// twice and overwrite its selected source. The dated allow-list prevents it.
const activeTomorrow = board('EPL', ['10-26'], { titleScope: true });
const multi = board('EPL', ['10-25', '10-26']);
const scoped = select([activeTomorrow, multi]);
assert.equal(scoped.ok, true);
assert.deepEqual(scoped.selections.map(row => [row.selected.candidate.tabId, row.boardDates]), [[2, ['2026-10-25']], [1, ['2026-10-26']]]);
const flow = await workerFlow([activeTomorrow, multi]);
assert.deepEqual(flow.uploads.map(body => body.boardDate), ['2026-10-25', '2026-10-26']);
assert.equal(flow.uploads[0].sourceCapture.tables[0].rows.length, 2);
assert.equal(flow.uploads[1].sourceCapture.tables[0].rows.length, 1);
const forged = structuredClone(flow.uploads[0]); forged.boardDate = '2026-10-27'; forged.games[0].boardDate = forged.boardDate;
assert.equal(validateSoccerCapture(forged, { now, headerVersion: version }).ok, false, 'raw reparse rejects an invented date');

// One source has both FT and HT. A separate active HT frame wins HT while the
// combined frame wins FT. Its full raw source still contains HT, but neither
// the upload body nor the saved HT head may come from that unselected source.
const half = board('EPL', ['10-27'], { period: 'HT', titleScope: true });
const combined = board('EPL', ['10-27']); combined.tables.push(...board('EPL', ['10-27'], { period: 'HT' }).tables);
const periodScope = select([half, combined]);
assert.equal(periodScope.ok, true);
assert.deepEqual(periodScope.selections.map(row => [row.selected.candidate.tabId, row.sourceScopes]), [
  [2, [{ boardDate: '2026-10-27', periodsCovered: ['FT'] }]], [1, [{ boardDate: '2026-10-27', periodsCovered: ['HT'] }]],
]);
const periodFlow = await workerFlow([half, combined]);
assert.deepEqual(periodFlow.uploads.map(body => body.periodsCovered), [['FT'], ['HT']]);
assert.deepEqual(periodFlow.uploads.map(body => body.sourceCapture.tables.length), [2, 1]);
assert.ok(periodFlow.uploads.every(body => body.games[0].markets.every(market => body.sourceScope.periodsCovered.includes(market.period))));
assert.deepEqual(periodFlow.uploads.map(body => body.sourceScope), [
  { version: SOCCER_SOURCE_SCOPE_VERSION, boardDate: '2026-10-27', periodsCovered: ['FT'] },
  { version: SOCCER_SOURCE_SCOPE_VERSION, boardDate: '2026-10-27', periodsCovered: ['HT'] },
]);
const scopeBody = periodFlow.uploads[0];
const alteredScope = structuredClone(scopeBody); alteredScope.sourceScope.periodsCovered = ['FT', 'HT'];
assert.notEqual(canonicalSoccerPayload(alteredScope), canonicalSoccerPayload(scopeBody), 'the precise source scope is bound by the canonical content hash');
for (const mutate of [
  value => { value.sourceScope.version = 'unrecognized'; },
  value => { value.sourceScope.periodsCovered = ['FT', 'FT']; },
  value => { value.sourceScope.periodsCovered = ['HT', 'FT']; },
  value => { value.sourceScope.periodsCovered = ['SECOND_HALF']; },
  value => { value.sourceScope.periodsCovered = ['UNKNOWN']; },
  value => { value.sourceScope.periodsCovered = ['FT', 'HT']; },
  value => { value.sourceScope.boardDate = '2026-10-28'; },
  value => { value.sourceScope.untrusted = true; },
  value => { value.games[0].markets[0].period = 'HT'; },
  value => { delete value.sourceScope; },
]) {
  const tampered = structuredClone(scopeBody); mutate(tampered);
  assert.equal(validateSoccerCapture(tampered, { now, headerVersion: version }).ok, false, 'scope or contract tampering cannot add, relabel or silently restore unselected periods');
}
const extraRaw = structuredClone(scopeBody); extraRaw.sourceCapture.tables[1].rows[0].cells[1].pair = ['侯城', '侯城[主]'];
assert.equal(validateSoccerCapture(extraRaw, { now, headerVersion: version }).ok, false, 'a bad unselected source period is checked before filtering');
const legacy = { ...parseTai888Capture(combined, new Date(now)), readerVersion: version, pageActivityAt: at };
assert.equal(validateSoccerCapture(legacy, { now, headerVersion: version }).ok, true, 'older unscoped whole-date Reader uploads retain their existing contract');
console.log('PASS dated football authority: real EPL/UCL parsing, exact date+period transport fences and hashed source scope, full raw reparse, selected provenance, heartbeat receipts, legacy compatibility and same-scope conflict rejection; generic selector unchanged');

register('./next-route-test-loader.mjs', import.meta.url);
const { soccerSqlFixture } = await import('./helpers/soccer-sql-fixture.mjs');
const fixture = await soccerSqlFixture();
const envKeys = ['DATABASE_URL', 'DATABASE_V2_URL', 'SESSION_SECRET', 'READER_PAIR_SECRET'];
const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]])); const oldNow = Date.now;
try {
  Date.now = () => now; delete process.env.DATABASE_V2_URL;
  process.env.DATABASE_URL = 'postgres://fixture.invalid/soccer-date-authority';
  process.env.SESSION_SECRET = 'synthetic-date-session'; process.env.READER_PAIR_SECRET = 'synthetic-date-pair';
  const { createReaderToken } = await import('../lib/reader-auth-v2.js');
  const { POST } = await import('../app/api/soccer/reader/route.js');
  const token = await createReaderToken({ deviceId: 'synthetic-date-device' });
  const persist = async payload => {
    const response = await POST(new Request('https://fixture.invalid/api/soccer/reader', { method: 'POST', headers: {
      Origin: `chrome-extension://${'a'.repeat(32)}`, Authorization: `Bearer ${token}`,
      'x-device-id': 'synthetic-date-device', 'x-reader-version': version, 'content-type': 'application/json',
    }, body: JSON.stringify(payload) }));
    const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
  };
  const saved = await workerFlow([activeTomorrow, multi], { persist });
  assert.equal(saved.first.ok, true);
  const rows = (await fixture.db.query(`SELECT board_date::text AS date,payload FROM sports_soccer_reader_observations_v2 ORDER BY board_date`)).rows;
  assert.equal(rows.length, 2); assert.deepEqual(rows.map(row => row.date), ['2026-10-25', '2026-10-26']);
  assert.deepEqual(rows.map(row => row.payload.sourceCapture.tables[0].rows.length), [2, 1]);
  assert.ok(rows.every(row => row.payload.games.length === 1 && row.payload.games[0].boardDate === row.date && row.payload.executable === false));
  const heads = (await fixture.db.query('SELECT board_date::text AS date,period FROM sports_soccer_reader_period_heads_v2 ORDER BY board_date')).rows;
  assert.deepEqual(heads, [{ date: '2026-10-25', period: 'FT' }, { date: '2026-10-26', period: 'FT' }]);
  assert.equal((await fixture.db.query('SELECT count(*)::int AS n FROM sports_soccer_analysis_v1')).rows[0].n, 0, 'Reader recovery does not manufacture model scores');
  assert.ok(plain(saved.state.readerStatuses.EPL.dateStatuses).every(row => row.saveReceipt.status === 'CONFIRMED'));
  const savedPeriods = await workerFlow([half, combined], { persist }); assert.equal(savedPeriods.first.ok, true);
  const scopedRows = (await fixture.db.query(`SELECT payload,content_hash FROM sports_soccer_reader_observations_v2 WHERE board_date='2026-10-27' ORDER BY payload->>'sourceScope'`)).rows;
  assert.equal(scopedRows.length, 2);
  for (const row of scopedRows) {
    const period = row.payload.sourceScope.periodsCovered[0];
    assert.deepEqual(row.payload.periodsCovered, [period]);
    assert.equal(row.payload.sourceCapture.tables.length, period === 'FT' ? 2 : 1);
    assert.deepEqual(row.payload.games[0].periodsCovered, [period]);
    assert.ok(row.payload.games[0].markets.every(market => market.period === period));
    assert.equal(row.content_hash, (await import('node:crypto')).createHash('sha256').update(canonicalSoccerPayload(row.payload)).digest('hex'));
  }
  const periodHeads = (await fixture.db.query(`SELECT h.period,o.payload FROM sports_soccer_reader_period_heads_v2 h JOIN sports_soccer_reader_observations_v2 o ON o.observation_id=h.observation_id WHERE h.board_date='2026-10-27' ORDER BY h.period`)).rows;
  assert.deepEqual(periodHeads.map(row => [row.period, row.payload.sourceCapture.tables.length]), [['FT', 2], ['HT', 1]], 'each head refers to the source selected for that exact period');
  await assert.rejects(fixture.db.query(`UPDATE sports_soccer_reader_observations_v2 SET payload=jsonb_set(payload,'{sourceScope,periodsCovered}','["HT"]'::jsonb) WHERE board_date='2026-10-27'`), /immutable/i, 'source scope is immutable with the original observation');
  const { loadSoccerReaderSnapshot } = await import('../lib/soccer/reader-store.js');
  const recovered = await loadSoccerReaderSnapshot('epl', '2026-10-27');
  assert.deepEqual(recovered.sourceObservations.map(row => row.period), ['FT', 'HT']);
  assert.equal(recovered.games.length, 1); assert.equal(recovered.games[0].markets.length, 4);
  assert.ok(recovered.games[0].markets.every(market => market.serverObservation.observationId), 'scoped content hashes survive actual saved aggregate recovery');
  console.log('PASS actual Reader worker → authenticated soccer API → server raw reparse → PostgreSQL immutable receipts and per-date heads: only chosen dated sources saved, no scoring writes and no Production requests');
} finally {
  Date.now = oldNow; await fixture.close();
  for (const key of envKeys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
}
