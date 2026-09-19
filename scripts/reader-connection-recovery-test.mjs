import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const background = fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*;\n/gm, '');
function harness(tabs, replies = {}) {
  const events = {}, reloads = [], stored = { readerToken: 'test', readerStatuses: { MLB: { ok: true, state: 'synced' } } };
  const event = key => ({ addListener: fn => { events[key] = fn; } });
  const context = vm.createContext({ console, URL, setTimeout, clearTimeout, queueMicrotask,
    chrome: { runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message') },
      alarms: { onAlarm: event('alarm') }, webNavigation: { getAllFrames: async () => [{ frameId: 0 }] },
      tabs: { onUpdated: event('updated'), query: async () => tabs, sendMessage: async id => { if (!replies[id]) throw Error('no receiver'); return replies[id]; }, reload: async id => reloads.push(id) },
      storage: { local: { get: async () => stored, set: async value => Object.assign(stored, value) } } } });
  vm.runInContext(background, context);
  return { context, reloads, stored };
}
const absent = harness([]);
const missing = await vm.runInContext("performSync('manual', null)", absent.context);
assert.equal(missing.ok, false);
assert.equal(Object.keys(absent.stored.readerStatuses).length, 4);
assert.equal(absent.stored.readerStatuses.MLB.ok, false, 'missing tabs must clear stale healthy state');
const disconnected = harness([{ id: 1 }, { id: 2 }], { 2: { ok: true, capture: { captures: [] } } });
const repaired = await vm.runInContext('repairReader()', disconnected.context);
assert.equal(repaired.ok, true);
assert.deepEqual(disconnected.reloads, [1], 'repair reloads only unresponsive tabs');
assert.match(repaired.message, /載入完成後/);
const popup = fs.readFileSync('reader/popup.js', 'utf8');
function element() { return { value: '', checked: false, classList: { hidden: true, toggle(_, state) { this.hidden = state; }, contains() { return this.hidden; } }, addEventListener() {}, replaceChildren() {}, append() {}, textContent: '' }; }
async function popupCase(paired) {
  const elements = {}, calls = [];
  const context = vm.createContext({ console, Date, setTimeout, clearTimeout,
    document: { getElementById: id => elements[id] ||= element(), createElement: element },
    chrome: { runtime: { sendMessage: async request => { calls.push(request.type); return request.type === 'GET_READER_STATUS' ? { ok: true, paired, statuses: {} } : { ok: false, message: '找不到 Tai888 分頁' }; } }, storage: { onChanged: { addListener() {} } } } });
  vm.runInContext(popup, context);
  await new Promise(resolve => setImmediate(resolve));
  return { elements, calls };
}
const paired = await popupCase(true);
assert.deepEqual(paired.calls, ['GET_READER_STATUS', 'SYNC_NOW', 'GET_READER_STATUS']);
assert.equal(paired.elements.message.textContent, '找不到 Tai888 分頁');
const unpaired = await popupCase(false);
assert.deepEqual(unpaired.calls, ['GET_READER_STATUS']);
assert.match(unpaired.elements.message.textContent, /配對密碼/);
console.log('Reader connection recovery: missing tabs, silent receiver repair, paired popup scan, unpaired startup PASS');
