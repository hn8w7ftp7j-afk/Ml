import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { completionMessage, deviceHash, seal, unseal, validateSubscription } from '../lib/analysis-push.js';

process.env.SESSION_SECRET = 'push-unit-test-only-not-a-production-secret';
const value = { endpoint: 'https://web.push.apple.com/Q/test', keys: { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) } };
assert.deepEqual(validateSubscription(value), value);
for (const endpoint of ['http://web.push.apple.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://web.push.apple.com.evil.test/a', 'https://user@web.push.apple.com/a', 'https://fcm.googleapis.com:8443/a']) {
  assert.throws(() => validateSubscription({ ...value, endpoint }));
}
assert.throws(() => validateSubscription({ ...value, keys: {} }));
assert.equal(deviceHash('invalid'), null);
assert.equal(deviceHash('a'.repeat(64)).length, 64);
const encrypted = seal(value);
assert.ok(!encrypted.includes(value.endpoint));
assert.deepEqual(unseal(encrypted), value);
const damaged = Buffer.from(encrypted, 'base64'); damaged[30] ^= 1;
assert.throws(() => unseal(damaged.toString('base64')));
const success = { ok: true, league: 'MLB', total: 2, completed: 2 };
assert.equal(completionMessage('run-test', success).title, '分析完成');
assert.match(completionMessage('run-test', success, 1).title, /部分/);
assert.match(completionMessage('run-test', { ...success, ok: false, completed: 1 }).title, /部分/);
assert.equal(completionMessage('run-test', success).url, '/?analysisRun=run-test');

const source = fs.readFileSync('workflows/analyze-board.js', 'utf8').replace(/^import .*;\n/gm, '').replace(/export async function/g, 'async function');
const notifications = [];
let deliveryFails = false;
const context = vm.createContext({
  FatalError: Error, RetryableError: Error, Request,
  getWorkflowMetadata: () => ({ workflowRunId: 'run-test' }),
  createBackgroundAnalysisAuthorization: async () => ({ timestamp: '1', signature: 'test' }),
  analyzeRequest: async () => Response.json({ ok: true }),
  completionMessage,
  sendPush: async (device, message) => { if (deliveryFails) throw new Error('offline'); notifications.push({ device, message }); return { status: 'sent' }; },
});
vm.runInContext(source + '\nthis.board=analyzeBoardWorkflow; this.all=analyzeAllLeaguesWorkflow;', context);
const task = { requestId: 'test', body: {}, game: { gamePk: 1 } };
await context.board({ league: 'MLB', date: '2026-09-22', tasks: [task] });
assert.equal(notifications.length, 0, 'unsubscribed device receives nothing');
const complete = await context.all({ date: '2026-09-22', pushDevice: 'device1', preflightFailures: 2, batches: [{ league: 'KBO', date: '2026-09-22', tasks: [task] }] });
assert.equal(complete.completed, 1);
assert.equal(notifications.length, 1);
assert.match(notifications[0].message.title, /部分/);
deliveryFails = true;
const retained = await context.board({ league: 'MLB', date: '2026-09-22', tasks: [task], pushDevice: 'device1' });
assert.equal(retained.completed, 1, 'push failure never loses analysis');
assert.equal(retained.notification.status, 'failed');

const handlers = {};
const opened = [];
const shown = [];
vm.runInNewContext(fs.readFileSync('public/sw.js', 'utf8'), { URL, self: {
  location: { origin: 'https://example.test' },
  addEventListener: (name, callback) => { handlers[name] = callback; },
  registration: { showNotification: async (...args) => shown.push(args) },
  clients: { openWindow: async url => opened.push(url) },
} });
let pending;
handlers.push({ data: { json: () => completionMessage('run-test', success) }, waitUntil: p => { pending = p; } });
await pending;
assert.equal(shown[0][0], '分析完成');
for (const target of ['/?analysisRun=run-test', 'https://evil.test/', '/api/bets']) {
  handlers.notificationclick({ notification: { close() {}, data: { url: target } }, waitUntil: p => { pending = p; } });
  await pending;
}
assert.deepEqual(opened, ['https://example.test/?analysisRun=run-test', 'https://example.test/', 'https://example.test/']);
const page = fs.readFileSync('app/page.js', 'utf8');
assert.match(page, /get\('analysisRun'\)/);
assert.match(page, /materializeAllLeagueResult\(batch, \[\], compactAnalysisData\)/);
const route = fs.readFileSync('app/api/analysis-notifications/route.js', 'utf8');
assert.match(route, /requireApiAuth/);
assert.match(route, /validateSameOrigin/);
assert.match(route, /httpOnly: true, secure: true, sameSite: 'strict'/);
console.log('PASS push: authenticated device binding, encryption, endpoint allowlist, partial failure, no-subscription, retained results, service-worker delivery and safe result links');
