import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync('app/analysis-notification-control.js', 'utf8')
  .replace(/^import .*;$/m, '').split('  return <section')[0]
  + '\nreturn null; }); globalThis.Control = AnalysisNotificationControl;';
function setup({ permission = 'default', answer = 'granted', off = false, fail = false } = {}) {
  const calls = [], messages = [];
  const storage = new Map(off ? [['analysis-notifications-off-v1', '1']] : []);
  const ref = {};
  const registration = { pushManager: {
    getSubscription: async () => null,
    subscribe: async () => { calls.push('subscribe'); return { toJSON: () => ({ endpoint: 'test' }) }; },
  } };
  const context = {
    forwardRef: f => f, useEffect: () => {}, useRef: value => ({ current: value }),
    useImperativeHandle: (r, f) => { r.current = f(); },
    useState: value => [value, next => messages.push(next)],
    Notification: { permission, requestPermission: () => { calls.push('permission'); return Promise.resolve(answer); } },
    navigator: { serviceWorker: { register: async () => registration, ready: Promise.resolve(registration) } },
    window: { PushManager: {}, Notification: {} },
    localStorage: { getItem: key => storage.get(key), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    fetch: async (_, options) => {
      calls.push(options?.method === 'POST' ? 'saved' : 'key');
      return { ok: !fail, json: async () => fail ? { ok: false, error: 'offline' } : { ok: true, publicKey: 'AA' } };
    }, AbortSignal, setTimeout, clearTimeout, atob, Uint8Array, Promise,
  };
  vm.runInNewContext(source, context);
  context.Control({}, ref);
  return { prepare: ref.current.prepare, calls, messages };
}
let test = setup();
const first = test.prepare();
assert.deepEqual(test.calls, ['permission'], 'permission starts synchronously inside the click');
const second = test.prepare();
await Promise.all([first, second]);
assert.deepEqual(test.calls, ['permission', 'key', 'subscribe', 'saved'], 'duplicate clicks coalesce and resolve after persistence');
test = setup({ permission: 'granted' }); await test.prepare();
assert.deepEqual(test.calls, ['key', 'subscribe', 'saved'], 'existing permission repairs subscription without prompting');
test = setup({ permission: 'denied' }); await test.prepare();
assert.deepEqual(test.calls, []); assert.ok(test.messages.some(v => typeof v === 'string' && v.includes('尚未允許')));
test = setup({ answer: 'default' }); await test.prepare(); await test.prepare();
assert.deepEqual(test.calls, ['permission'], 'dismissal is not repeatedly prompted in the session');
test = setup({ off: true }); await test.prepare(); assert.deepEqual(test.calls, [], 'explicit opt-out is respected');
test = setup({ fail: true }); await test.prepare();
assert.ok(test.messages.some(v => typeof v === 'string' && v.includes('offline')));
assert.ok(!test.calls.includes('saved'), 'failure never claims successful subscription');
const page = fs.readFileSync('app/page.js', 'utf8');
assert.equal((page.match(/onClick=\{\(\) => startWithCompletionNotification/g) || []).length, 3);
assert.ok(page.indexOf('await notificationControlRef.current?.prepare()') < page.indexOf('return start();'));
assert.equal((page.match(/<AnalysisNotificationControl/g) || []).length, 1);
console.log('PASS: synchronous permission, saved subscription before analysis, duplicate clicks, denied/dismissed/opt-out/failure and all three analysis buttons');
