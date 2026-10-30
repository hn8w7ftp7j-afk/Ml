import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { desktopDocument, RenderedElement } from './helpers/soccer-reader-dom-fixture.mjs';
import { buildReaderSeenCapture } from '../lib/reader-seen-capture.js';

const manifest = JSON.parse(readFileSync('reader/manifest.json', 'utf8'));
const version = manifest.version;
const now = Date.parse('2026-10-29T00:00:00.000Z'), at = new Date(now).toISOString();
const plain = value => JSON.parse(JSON.stringify(value));
const ack = { queued: true, durable: true, captureIds: ['a'.repeat(64)] };
const source = { sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/?account=hidden#/FT?token=hidden',
  frameUrl: 'https://tai888.in/newapp/#/FT', readerVersion: version, observedAt: at,
  captureReasons: ['SCAN'], completeCapture: false };
const context = vm.createContext({ URL });
for (const file of ['league-registry.js', 'seen-evidence.js']) vm.runInContext(readFileSync(`reader/${file}`, 'utf8'), context);
const adapter = context.Tai888SeenEvidence;
const cell = (pair, index = 0) => ({ pair, left: index * 100, right: (index + 1) * 100 });
const record = (top, values, extra = {}) => ({ top, left: 0, right: values.length * 100,
  cells: values.map((value, index) => cell(Array.isArray(value) ? value : [value], index)), ...extra });
const header = record(0, ['時間', '主客隊伍', '讓球', '大小盤']);
const heading = record(10, ['聯盟：NBA美國職業籃球(2)']); heading.cells[0].right = 400;
const exact = ' 3+50  0.950\n1.5 ';
const first = record(20, [['not-a-date', '07:00'], ['新隊伍', 'LAL-湖人[主]'], [exact, '0.940'], ['大224.5 0.900', '小 1.000']]);
const conflict = record(21, [['not-a-date', '07:00'], ['新隊伍', 'LAL-湖人[主]'], ['3+75 0.910', '0.970'], ['UNKNOWN', '-']]);
const locked = record(22, [['10/29', '08:00'], ['GS-勇士', 'NY-尼克[主]'], ['🔒', '-'], ['-', '-']], { marketLocked: true });
const privateRow = record(23, ['餘額', '123456.78', 'cookie opaque', 'do-not-export']);
const rows = [header, heading, first, conflict, locked, privateRow];

// An excluded competition is not raw EPL/UCL evidence. After its boundary a
// repeated column header must not restore the preceding senior heading.
for(const [senior,foreign]of [['英格蘭超級聯賽','英格蘭超級聯賽盃U21'],
  ['英格蘭超級聯賽','English Premier League 2'],['歐洲冠軍聯賽','UCL Youth']]){
  const seniorHeading=record(10,[`聯盟: ${senior}(2)`]);seniorHeading.cells[0].right=400;
  const foreignHeading=record(30,[foreign]);foreignHeading.cells[0].right=400;
  const repeatedHeader={...header,top:40};
  const output=plain(adapter.collect([header,seniorHeading,record(20,['senior-original-row']),
    foreignHeading,record(35,['excluded-first-row']),repeatedHeader,record(50,['excluded-after-header'])],source));
  assert.equal(output.length,1);assert.equal(output[0].tables.flatMap(table=>table.rows).length,1);
  assert.equal(output[0].tables[0].rows[0].cells[0].pair[0],'senior-original-row');
  assert.equal(JSON.stringify(output).includes('excluded-'),false,'closed football scope cannot be revived by another header');
  assert.deepEqual(plain(adapter.collectSections([{label:foreign,fragments:[{text:'synthetic-cup-row'}]}],
    senior.includes('英格蘭')?'EPL':'UCL',source)),null);
}
const extracted = plain(adapter.collect(rows, source));
assert.equal(extracted.length, 1); const evidence = extracted[0];
assert.equal(evidence.version, 'TAI888-DOM-CAPTURE-v2.2.0'); assert.equal(evidence.league, 'NBA');
assert.equal(evidence.pageUrl, 'https://tai888.in/newapp/#/FT');
const retained = evidence.tables.flatMap(table => table.rows);
assert.equal(retained.length, 4, 'conflicting rows, invalid identity and explicit locks are not normalized away');
assert.equal(retained[0].cells[2].pair[0], exact, 'safe sport text preserves exact whitespace, newline, credit and decimal tokens');
assert.equal(retained[1].cells[2].pair[0], '3+75 0.910'); assert.equal(retained[1].cells[3].pair[0], 'UNKNOWN');
assert.equal(retained[2].marketLocked, true);
assert.ok(retained[3].cells.every(value => value.pair.every(part => part === '')), 'private labels also redact adjacent amounts');
assert.equal(JSON.stringify(evidence).includes('123456.78'), false);
assert.equal(JSON.stringify(evidence).includes('hidden'), false);
assert.equal(evidence.completeCapture, false); assert.ok(evidence.captureReasons.includes('SOURCE_PARTIAL'));
assert.deepEqual(buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence },
  { deviceId: 'seen-evidence-fixture', headerVersion: version }).evidence, evidence);
for (const secret of ['password hidden', 'ｐａｓｓｗｏｒｄ hidden', '%70%61%73%73%77%6f%72%64 hidden', 'user id hidden', 'a'.repeat(48)]) {
  const output = plain(adapter.collect([header, heading, record(20, ['10/29', 'LAL-湖人[主]', secret, '999999.12'])], source));
  assert.equal(JSON.stringify(output).includes(secret), false); assert.equal(JSON.stringify(output).includes('999999.12'), false);
}
const noHeader = plain(adapter.collect([heading, first], source));
assert.equal(noHeader[0].tables.flatMap(table => table.rows).length, 1, 'an explicitly scoped partial board survives missing market headers');
const unfamiliar = plain(adapter.collect([header, heading, record(20, ['尚未辨識的隊伍'])], source));
assert.equal(unfamiliar[0].tables.flatMap(table => table.rows)[0].cells[0].pair[0], '尚未辨識的隊伍',
  'a witnessed sport lane preserves a single unknown team cell without price/date/home-marker semantics');
const many = plain(adapter.collect([header, heading, ...Array.from({ length: 90 }, (_, index) => record(20 + index,
  ['10/29', `新隊伍${index}[主]`, [`3+${index} 0.950`, '0.940'], ['大224.5 0.950', '小 0.950']]))], source));
assert.equal(many[0].tables.flatMap(table => table.rows).length, 90, 'raw collection has no parser 40-game/60-row truncation');
assert.throws(() => adapter.collect(rows, { ...source, pageUrl: '', sourceHost: '' }), error => error.code === 'SEEN_SOURCE_INVALID');

// Execute the shipped content script with rendered DOM geometry. The local
// persistence boundary is injected; all parsing/normalization remains actual.
function content(options = {}) {
  const { document } = desktopDocument('EPL', { malformedAlternative: true, ...options.layout });
  if (options.aboutBlank) {
    document.referrer = options.noOwner ? '' : 'https://www1.tai888.in/newapp/?token=private#/FT?account=private';
    document.location = { protocol: 'about:', hostname: '', origin: 'null', pathname: 'blank', hash: '', ancestorOrigins: [] };
  }
  let clock = now, handler, observer;
  const intervals = [], timeouts = [], messages = [], saved = [];
  let fail = Boolean(options.fail), resolveLocal;
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [clock])); } static now() { return clock; } }
  const context = vm.createContext({ document, location: document.location, Element: RenderedElement, URL, Date: Clock, console,
    crypto: webcrypto, TextEncoder,
    NodeFilter: { SHOW_TEXT: 4, FILTER_REJECT: 2, FILTER_ACCEPT: 1 },
    Node: { ELEMENT_NODE: 1, DOCUMENT_POSITION_FOLLOWING: 4, DOCUMENT_POSITION_PRECEDING: 2 },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }),
    performance: { timeOrigin: now, now: () => 0, getEntriesByType: () => [] },
    MutationObserver: class { constructor(callback) { observer = callback; } observe() {} disconnect() {} },
    chrome: { runtime: { id: 'seen-evidence-fixture', onMessage: { addListener(callback) { handler = callback; } },
      sendMessage: message => { messages.push(plain(message)); return Promise.resolve(message.type === 'TAI888_SEEN_CAPTURE' && !fail ? ack : {}); } } },
    addEventListener() {}, setInterval(callback, delay) { intervals.push({ callback, delay }); },
    setTimeout(callback, delay) { timeouts.push({ callback, delay }); }, clearTimeout() {},
  });
  for (const file of manifest.content_scripts[0].js) {
    if (file === 'tai888-content.js') continue;
    if (options.missingNormalizer && file === 'row-normalizer.js') continue;
    vm.runInContext(readFileSync(`reader/${file}`, 'utf8'), context);
  }
  context.Tai888SeenStorage = { persist(input) {
    saved.push(plain(input));
    if (options.holdLocal) return new Promise(resolve => { resolveLocal = resolve; });
    if (fail) return Promise.reject(new Error('synthetic quota failure'));
    return Promise.resolve(ack);
  } };
  let normalizations = 0;
  if (!options.missingNormalizer) {
    const original = context.Tai888RowNormalizer;
    context.Tai888RowNormalizer = { ...original, normalizeRowRecords(...args) {
      normalizations += 1;
      assert.ok(saved.length > 0, 'raw persistence is initiated before the live normalizer');
      if (options.throwNormalizer) throw Error('synthetic parse exception');
      return original.normalizeRowRecords(...args);
    } };
  }
  vm.runInContext(readFileSync('reader/tai888-content.js', 'utf8'), context);
  return { context, document, saved, messages, intervals, timeouts,
    capture() { let response; handler({ type: 'TAI888_CAPTURE_BASEBALL_TABLE' }, {}, value => { response = value; }); return response; },
    mutate() { clock += 1; observer([{ type: 'characterData', target: document.documentElement }]); },
    advance(milliseconds) { clock += milliseconds; },
    retry() { clock += 6000; for (const item of intervals.filter(row => row.delay === 5000)) item.callback(); },
    recover() { fail = false; }, resolveLocal() { resolveLocal?.(ack); }, normalizations: () => normalizations };
}
const settle = async () => { for (let count = 0; count < 6; count += 1) await new Promise(resolve => setImmediate(resolve)); };
const real = content();
assert.ok(real.saved.length > 0, 'initial frame content is archived without waiting for worker selection');
const capture = real.capture(); assert.equal(capture.ok, true); assert.equal(capture.capture.seenCaptureVersion, 'READER-SEEN-CAPTURE-v1');
assert.ok(real.normalizations() > 0);
const initialSeen = real.saved.map(item => ({ observedAt: item.observedAt, tables: JSON.stringify(item.tables) }));
const beforeRepeatedScan = real.saved.length;
real.advance(61000); assert.equal(real.capture().ok, true);
const repeatedScan = real.saved.slice(beforeRepeatedScan);
assert.ok(repeatedScan.length > 0, 'an explicit scan persists a new observation when all displayed odds remain unchanged');
assert.ok(repeatedScan.some(item => initialSeen.some(old => old.tables === JSON.stringify(item.tables)
  && Date.parse(item.observedAt) - Date.parse(old.observedAt) === 61000)), 'same-price scan preserves its actual later source timestamp');
const beforeMutationNoise = real.saved.length;
real.mutate(); assert.equal(real.saved.length, beforeMutationNoise, 'unchanged mutation notifications remain deduplicated');
const rawText = JSON.stringify(real.saved);
assert.ok(rawText.includes('UNKNOWN'), 'malformed alternative water survives before normalizer rejection');
assert.ok(rawText.includes('角球數') && rawText.includes('罰牌數'), 'raw sport-only evidence is not limited by live goal-market selection');
for (const item of real.saved) buildReaderSeenCapture({ schema: 'READER-SEEN-CAPTURE-v1', evidence: item }, { deviceId: 'seen-evidence-fixture', headerVersion: version });
const price = real.document.querySelectorAll('*').find(element => element.fragments.some(fragment => fragment.text === '1-50'));
assert.ok(price);
const originalPrice = price.fragments.find(fragment => fragment.text === '1-50');
originalPrice.text = ' 3+50  0.950\n1.5 ';
const exactDOMStart = real.saved.length; real.mutate();
assert.ok(real.saved.slice(exactDOMStart).some(item => item.tables.some(table => table.rows.some(row => row.cells.some(cell => cell.pair.includes(exact))))),
  'the actual DOM archive preserves safe sport whitespace/newlines without using the live parser cleaner');
const beforeMutation = real.saved.length;
originalPrice.text = '3+50'; real.mutate();
assert.ok(real.saved.length > beforeMutation, 'mutation evidence is queued before the live debounce fires');
const afterA = real.saved.length;
originalPrice.text = '1.5'; real.mutate(); originalPrice.text = '3+50'; real.mutate();
assert.ok(real.saved.length > afterA);
assert.ok(JSON.stringify(real.saved.slice(beforeMutation)).includes('1.5'));
assert.equal(real.timeouts.some(item => item.delay === 2500), true, 'existing live-analysis debounce remains separate');
await settle();
const missing = content({ missingNormalizer: true });
assert.ok(missing.saved.length > 0); assert.deepEqual(plain(missing.capture().capture.captures), [], 'missing live normalizer cannot stop raw capture or grant live authority');
const throwing = content({ throwNormalizer: true });
assert.ok(throwing.saved.length > 0); assert.equal(throwing.capture().ok, false, 'raw persistence precedes thrown live parser failures');
const failed = content({ fail: true }); await settle();
assert.ok(failed.messages.some(message => message.type === 'SEEN_CAPTURE_FAILURE' && message.code === 'SEEN_LOCAL_SAVE_FAILED'));
const originals = failed.saved.map(item => item.observedAt), failedCount = failed.saved.length;
failed.recover(); failed.retry(); await settle();
assert.ok(failed.saved.length > failedCount, 'unconfirmed content evidence retries after quota/background failure');
assert.ok(failed.saved.slice(failedCount).every(item => originals.includes(item.observedAt)), 'retry never freshens the source observation');
const concurrent = content({ holdLocal: true });
assert.ok(concurrent.messages.some(message => message.type === 'TAI888_SEEN_CAPTURE'), 'worker receives full evidence before direct local hashing/storage resolves');
concurrent.resolveLocal(); await settle();
const inherited = content({ aboutBlank: true });
assert.ok(inherited.saved.length > 0);
assert.ok(inherited.saved.every(item => item.pageUrl === 'https://www1.tai888.in/newapp/#/FT' && item.sourceHost === 'www1.tai888.in' && !Object.hasOwn(item, 'frameUrl')));
assert.equal(JSON.stringify(inherited.saved).includes('private'), false);
const unknownSource = content({ aboutBlank: true, noOwner: true }); await settle();
assert.equal(unknownSource.saved.length, 0);
assert.ok(unknownSource.messages.some(message => message.type === 'SEEN_CAPTURE_FAILURE' && message.code === 'SEEN_SOURCE_INVALID'), 'unknown frame source is an explicit save failure, never a silent empty capture');
console.log('PASS shipped raw content capture: pre-normalization conflicting/partial/locked evidence, exact sport strings, account isolation, >60 rows, immediate initial/mutation A-B-A retention, missing/throwing normalizer isolation, concurrent worker handoff, durable-ACK retries and observed about:blank parent source; no Production claims');
