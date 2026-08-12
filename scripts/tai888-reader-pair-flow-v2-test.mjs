import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

let source = fs.readFileSync(new URL('../reader/background.js', import.meta.url), 'utf8');
source = source.replace(/^import[^;]+;\s*/m, '');

const storage = {};
let messageListener = null;
const chrome = {
  runtime: {
    onInstalled: { addListener() {} },
    onStartup: { addListener() {} },
    onMessage: { addListener(listener) { messageListener = listener; } },
  },
  alarms: {
    onAlarm: { addListener() {} },
    async clear() { return true; },
    create() {},
  },
  tabs: {
    onUpdated: { addListener() {} },
    async query() { return []; },
  },
  webNavigation: {
    async getAllFrames() { return []; },
  },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === 'string') return { [keys]: storage[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, storage[key]]));
        return { ...storage };
      },
      async set(value) { Object.assign(storage, value); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      },
    },
  },
};

const fetch = async url => {
  assert.match(String(url), /\/api\/reader\/pair$/);
  return new Response(JSON.stringify({ ok: true, token: 'signed-reader-token', message: 'paired' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const context = vm.createContext({
  chrome,
  fetch,
  crypto: webcrypto,
  Response,
  URL,
  TextEncoder,
  setTimeout,
  clearTimeout,
  console,
  parseTai888Capture() { throw new Error('not used'); },
  canonicalReaderPayload() { return ''; },
});
vm.runInContext(source, context);
assert.equal(typeof messageListener, 'function');

const response = await new Promise(resolve => {
  const keepOpen = messageListener({
    type: 'PAIR_READER',
    password: 'pair-secret',
    deviceName: 'audit-device',
  }, {}, resolve);
  assert.equal(keepOpen, true);
});

assert.equal(response.ok, true);
assert.equal(response.paired, true);
assert.match(response.syncWarning, /找不到已開啟的 Tai888 分頁/);
assert.equal(storage.readerToken, 'signed-reader-token');
assert.equal(storage.autoEnabled, true);
assert.equal(Object.prototype.hasOwnProperty.call(storage, 'password'), false);
assert.equal(Object.values(storage).includes('pair-secret'), false);
assert.equal(storage.readerStatus.state, 'error');
assert.match(storage.readerStatus.message, /找不到已開啟的 Tai888 分頁/);

console.log('Tai888 Reader pairing flow: token persists and UI can leave pairing panel even when first sync fails');
