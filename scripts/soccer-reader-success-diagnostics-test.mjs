import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import * as parser from '../reader/parser.js';
import * as selector from '../reader/board-selector.js';
import { createDiagnosticOutbox, DIAGNOSTIC_ALARM } from '../reader/diagnostic-outbox.js';
import { DIAGNOSTIC_SCHEMA, sanitizeDiagnosticReport } from '../reader/diagnostic-schema.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';
import { readerSaveReceiptFixture } from './reader-save-receipt-fixture.mjs';
import { installArchiveWorkerFixture } from './reader-archive-receipt-fixture.mjs';

// Synthetic source dates verify the shipped selector -> worker -> automatic
// diagnostic wire, not the presence of a real bookmaker's future matches.
const now = Date.parse('2026-11-08T08:30:00Z'), at = new Date(now).toISOString();
class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
const version = JSON.parse(readFileSync('reader/manifest.json', 'utf8')).version;
const plain = value => JSON.parse(JSON.stringify(value));
const cell = pair => ({ pair });
const background = readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm,
  line => line.includes('./nba-conflict-recovery.js')
    ? readFileSync('reader/nba-conflict-recovery.js', 'utf8').replace(/^export /gm, '') + '\n' : '');

function capture(league, day, period) {
  const label = league === 'EPL' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽';
  const prefix = period === 'FT' ? '全場' : '上半場';
  return { league, pageLeagueLabel: label, sourceHost: 'www.tai888.in',
    pageUrl: 'https://www.tai888.in/newapp/', observedAt: at,
    tables: [{ sectionTitle: label, headers: ['時間', '主客隊伍', `${prefix}讓球`, `${prefix}大小`, `${prefix}獨贏`],
      rows: [{ cells: [cell([day, '01:30']), cell(['阿仙奴', '利物浦[主]']),
        cell(['1平 0.95', '0.91']), cell(['大3+50 0.95', '小 0.89']), cell(['主勝 -', '和 -', '客勝 -'])] }] }],
    diagnostics: { expectedGameCount: 1, gameCount: 1, lastMutationAt: at } };
}

for (const league of ['EPL', 'UCL']) {
  const sources = [capture(league, '11-07', 'FT'), capture(league, '11-08', 'HT')];
  const original = JSON.stringify(sources);
  const candidates = sources.map((source, index) => ({ capture: source,
    parsed: parser.parseTai888Capture(source, new Date(now)), tabId: 101 + index, frameId: index,
    active: index === 0 }));
  const selected = selector.selectAuthoritativeSoccerBoards(candidates, { league, now });
  assert.equal(selected.ok, true);
  assert.deepEqual(selected.scopeSelections.map(row => [row.boardDate, row.period]),
    [['2026-11-07', 'FT'], ['2026-11-08', 'HT']]);
  assert.deepEqual(selected.diagnosticEvidence.sources.map(row => [row.dates, row.periods, row.pageIndex, row.frameIndex]),
    [[['2026-11-07'], ['FT'], 1, 1], [['2026-11-08'], ['HT'], 2, 1]]);
  assert.equal(selected.diagnosticEvidence.sourceCount, 2);
  assert.equal(JSON.stringify(sources), original, 'diagnostics cannot mutate source contracts');
  assert.ok(!JSON.stringify(selected.diagnosticEvidence).includes('www.tai888.in'), 'source topology uses local ordinals, not URLs');
  assert.ok(!Object.hasOwn(selected.diagnosticEvidence, 'coverageComplete'), 'successful selection cannot claim full schedule coverage');
  const many = selector.selectAuthoritativeSoccerBoards([...candidates,
    ...Array.from({ length: 3 }, (_, index) => ({ ...candidates[0], tabId: 103 + index }))], { league, now });
  assert.equal(many.ok, true, 'diagnostic limits cannot become source scan limits');
  assert.equal(many.diagnosticEvidence.sourceCount, 5);
  assert.equal(many.diagnosticEvidence.sources.length, 4);
  assert.equal(many.diagnosticEvidence.sourcesTruncated, true, 'bounded reports explicitly disclose unlisted sources');

  const state = { readerToken: 'synthetic-private-token', deviceId: 'synthetic-private-device', pairedAt: now, autoEnabled: true };
  const marketUploads = [], reports = [], event = { addListener() {} };
  const chrome = { runtime: { onInstalled: event, onStartup: event, onMessage: event, getManifest: () => ({ version }) },
    alarms: { onAlarm: event },
    tabs: { onUpdated: event, query: async () => sources.map((_, index) => ({ id: 101 + index, active: index === 0 })),
      sendMessage: async tabId => ({ ok: true, capture: { readerVersion: version, seenCaptureVersion: 'READER-SEEN-CAPTURE-v1', captures: [sources[tabId - 101]] } }) },
    webNavigation: { getAllFrames: async ({ tabId }) => [{ frameId: tabId - 101 }] },
    storage: { local: { get: async () => structuredClone(state), set: async values => Object.assign(state, structuredClone(values)), remove: async () => {} } } };
  const worker = vm.createContext({ chrome, ...parser, ...selector, createDiagnosticOutbox, DIAGNOSTIC_ALARM,
    DIAGNOSTIC_SCHEMA, Date: Clock, crypto: webcrypto, TextEncoder, URL, AbortController,
    setTimeout, clearTimeout, queueMicrotask, fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      if (url.endsWith('/api/soccer/reader')) {
        assert.equal(validateSoccerCapture(payload, { now, headerVersion: version }).ok, true);
        marketUploads.push(payload);
        return Response.json(readerSaveReceiptFixture(payload));
      }
      assert.ok(url.endsWith('/api/reader/diagnostics'));
      const report = sanitizeDiagnosticReport(payload); reports.push(report);
      return Response.json({ ok: true, durable: true, reportId: report.reportId, receivedAt: at });
    } });
  installArchiveWorkerFixture(worker);
  vm.runInContext(background, worker);
  const result = await vm.runInContext("performSync('manual')", worker);
  assert.equal(result.ok, true);
  assert.equal(marketUploads.length, 2, 'observational diagnostics do not add an upload or invent another source date');
  assert.deepEqual(marketUploads.map(row => [row.boardDate, row.periodsCovered]), [['2026-11-07', ['FT']], ['2026-11-08', ['HT']]]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].leagues[league].state, 'synced');
  assert.deepEqual(reports[0].leagues[league].authority, plain(selected.diagnosticEvidence), 'successful automatic report retains typed source dates and topology');
  assert.ok(!JSON.stringify(reports).includes('synthetic-private'), 'wire report does not retain device/token data');
  assert.equal(state.diagnosticDelivery.state, 'sent');
}
console.log('Soccer successful-source diagnostics: dated FT/HT selection, automatic typed wire, privacy and unchanged live validation PASS');
