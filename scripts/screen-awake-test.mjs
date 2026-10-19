import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createScreenAwake, SCREEN_AWAKE_MS } from '../lib/screen-awake.js';

const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture({ supported = true, request } = {}) {
  let clock = 0, nextId = 0, status, requests = 0;
  const timers = new Map(), locks = [];
  const doc = { visibilityState: 'visible' };
  const makeLock = () => {
    const listeners = [];
    const lock = { released: false, addEventListener: (_type, fn) => listeners.push(fn), release() {
      this.released = true; listeners.forEach(fn => fn()); return Promise.resolve();
    } };
    locks.push(lock); return lock;
  };
  const nav = supported ? { wakeLock: { request: type => {
    assert.equal(type, 'screen'); requests++;
    return request ? request(makeLock) : Promise.resolve(makeLock());
  } } } : {};
  const controller = createScreenAwake({ doc, nav, now: () => clock,
    schedule: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: clock + ms }); return id; },
    cancel: id => timers.delete(id), onStatus: value => { status = value; },
  });
  return { controller, doc, locks, get status() { return status; }, get requests() { return requests; },
    async advance(ms) { clock += ms; for (const [id, t] of timers) if (t.at <= clock) { timers.delete(id); t.fn(); } await flush(); },
  };
}

assert.equal(SCREEN_AWAKE_MS, 300000);
const f = fixture(); f.controller.renew(); await flush();
assert.equal(f.status, 'active'); assert.equal(f.requests, 1);
await f.advance(240000); f.controller.renew(); await flush();
await f.advance(299999); assert.equal(f.locks[0].released, false);
await f.advance(1); assert.equal(f.locks[0].released, true); assert.equal(f.status, 'idle');
f.controller.renew(); await flush(); assert.equal(f.requests, 2);
f.doc.visibilityState = 'hidden'; f.controller.visibility(); await flush();
assert.equal(f.locks[1].released, true);
f.doc.visibilityState = 'visible'; f.controller.visibility(); await flush(); assert.equal(f.status, 'active');
f.controller.pause(); await flush(); f.controller.renew(); f.controller.visibility(); await flush();
assert.equal(f.status, 'paused'); assert.equal(f.requests, 3);
f.controller.resume(); await flush(); assert.equal(f.requests, 4);
f.controller.suspend(); await flush(); f.controller.visibility(); await flush(); assert.equal(f.requests, 5, 'BFCache restoration reacquires');
await f.locks.at(-1).release(); assert.equal(f.status, 'blocked');
await flush(); assert.equal(f.requests, 5, 'OS release does not cause retry loop');
f.controller.renew(); await flush(); assert.equal(f.requests, 6);
f.controller.dispose(); await flush(); assert.equal(f.locks.at(-1).released, true);

const unsupported = fixture({ supported: false }); unsupported.controller.renew(); assert.equal(unsupported.status, 'unsupported');
unsupported.doc.visibilityState = 'hidden'; unsupported.controller.visibility(); unsupported.controller.suspend();
unsupported.doc.visibilityState = 'visible'; unsupported.controller.visibility(); await unsupported.advance(SCREEN_AWAKE_MS);
assert.equal(unsupported.status, 'unsupported'); unsupported.controller.dispose();
const denied = fixture({ request: () => Promise.reject(new Error('NotAllowedError')) });
denied.controller.renew(); await flush(); assert.equal(denied.status, 'blocked'); assert.equal(denied.requests, 1); denied.controller.dispose();

for (const reason of ['expiry', 'dispose', 'pause', 'hidden']) {
  let resolve;
  const slow = fixture({ request: make => new Promise(done => { resolve = () => done(make()); }) });
  slow.controller.renew(); slow.controller.renew(); assert.equal(slow.requests, 1, 'deduplicates pending requests');
  if (reason === 'expiry') await slow.advance(SCREEN_AWAKE_MS);
  if (reason === 'dispose') slow.controller.dispose();
  if (reason === 'pause') slow.controller.pause();
  if (reason === 'hidden') { slow.doc.visibilityState = 'hidden'; slow.controller.visibility(); }
  resolve(); await flush(); assert.equal(slow.locks[0].released, true, `late ${reason} lock released`);
  slow.controller.dispose();
}
let resolveFirst;
let count = 0;
const race = fixture({ request: make => ++count === 1 ? new Promise(done => { resolveFirst = () => done(make()); }) : Promise.resolve(make()) });
race.controller.renew(); race.doc.visibilityState = 'hidden'; race.controller.visibility();
race.doc.visibilityState = 'visible'; race.controller.visibility(); resolveFirst(); await flush();
assert.equal(race.locks[0].released, true); assert.equal(race.status, 'active'); assert.equal(race.requests, 2);
race.controller.dispose();

const component = fs.readFileSync('app/screen-awake.js', 'utf8');
assert.match(component, /pathname !== '\/login'/);
for (const event of ['pointerdown', 'keydown', 'visibilitychange', 'pageshow', 'pagehide']) {
  assert.ok(component.includes(`addEventListener('${event}'`));
  assert.ok(component.includes(`removeEventListener('${event}'`));
}
assert.match(component, /current\.dispose\(\)/);
assert.match(fs.readFileSync('app/layout.js', 'utf8'), /<ScreenAwake\/>/);
console.log('PASS five-minute renewal, visibility/BFCache, pause/retry, unsupported/denied, expiry/disposal races, OS release and global authenticated-page wiring');
