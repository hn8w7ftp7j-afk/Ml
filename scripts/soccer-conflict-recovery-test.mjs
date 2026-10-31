import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const event = { addListener() {} };
const workerSource = fs.readFileSync('reader/background.js', 'utf8').replace(/^import .*?;\n/gm, '');
function loadRecovery() {
  const worker = vm.createContext({ URL, chrome: {
    runtime: { onInstalled: event, onStartup: event, onMessage: event },
    alarms: { onAlarm: event }, tabs: { onUpdated: event },
  } });
  vm.runInContext(workerSource, worker);
  return vm.runInContext('recoverSoccerConflict', worker);
}
const recover = loadRecovery();
const plain = value => JSON.parse(JSON.stringify(value));
let state = {}, calls = [];
const storage = { get: async () => structuredClone(state), set: async value => Object.assign(state, value) };
const tabs = [1, 2, 3].map(id => ({ id, url: 'https://www.tai888.in/newapp/#/BS' }));
const selection = { error: 'conflicting-duplicate-tabs', boardDate: '2026-11-01', period: 'HT',
  conflictingTabIds: [1, 2, 2, 999], assessed: [1, 2, 3, 999].map(tabId => ({ ok: true,
    candidate: { tabId, parsed: { league: tabId === 3 ? 'UCL' : 'EPL' } } })) };
const original = structuredClone(selection);
const options = { league: 'EPL', tabs, storage, reload: async id => calls.push(id), now: 100000 };
assert.deepEqual(plain(await recover(selection, options)), {
  version: 'SOCCER-CONFLICT-RECOVERY-v1', state: 'REQUESTED', attemptedAt: new Date(100000).toISOString(),
  attemptedTabCount: 2, refreshedTabCount: 2,
});
assert.deepEqual(calls, [1, 2], 'refresh only real implicated soccer tabs; never unrelated dates/periods or unknown IDs');
assert.deepEqual(selection, original, 'recovery cannot change any captured contract, selector result or upload authority');
assert.equal((await recover(selection, { ...options, now: 900000 })).state, 'ALREADY_ATTEMPTED');
assert.deepEqual(calls, [1, 2], 'automatic alarms cannot loop through reloads during a persistent conflict');
assert.equal((await recover(selection, { ...options, now: 120000, manual: true })).state, 'ALREADY_ATTEMPTED');
assert.equal((await recover(selection, { ...options, now: 200000, manual: true })).state, 'REQUESTED');
assert.deepEqual(calls, [1, 2, 1, 2], 'explicit manual retry remains limited to once per 90 seconds');

// A new worker must honor the already persisted incident.
assert.equal((await loadRecovery()(selection, { ...options, now: 9999999 })).state, 'ALREADY_ATTEMPTED');
for (const different of [{ ...selection, period: 'FT' }, { ...selection, boardDate: '2026-11-02' }]) {
  assert.equal((await recover(different, options)).state, 'REQUESTED', 'date/period incidents are independent');
}
const ucl = { ...selection, assessed: selection.assessed.map(row => ({ ...row,
  candidate: { ...row.candidate, parsed: { league: 'UCL' } } })) };
assert.equal((await recover(ucl, { ...options, league: 'UCL' })).state, 'REQUESTED', 'EPL recovery never suppresses UCL recovery');
assert.equal(Object.keys(state).length, 4, 'each league/date/period owns a separate persistent incident');

state = {}; calls = [];
const frames = { ...selection, error: 'conflicting-duplicate-frames', authorityTabId: 1, conflictingFrameIds: [0, 2, 3] };
assert.equal((await recover(frames, options)).refreshedTabCount, 1);
assert.deepEqual(calls, [1], 'several disagreeing frames refresh their one top-level tab once');
for (const error of ['conflicting-duplicate-rows', 'no-complete-tab', 'no-board-candidates']) {
  assert.equal(await recover({ ...selection, error }, options), null, 'unrelated selection failures cannot trigger refresh');
}
assert.equal(await recover(selection, { ...options, league: 'NBA' }), null, 'NBA retains its existing isolated recovery');
for (const url of ['https://tai888.in.attacker.test/', 'https://secret@www.tai888.in/', 'https://www.tai888.in:444/', 'http://www.tai888.in/']) {
  assert.equal(await recover(selection, { ...options, tabs: [tabs[0], { id: 2, url }] }), null);
}
assert.equal(await recover({ ...selection, period: 'UNTRUSTED' }, options), null);
assert.equal(await recover({ ...selection, boardDate: 'private-url-token' }, options), null);

state = {}; calls = [];
const failed = await recover(selection, { ...options, reload: async () => { throw Error('closed'); } });
assert.equal(failed.state, 'FAILED'); assert.equal(failed.refreshedTabCount, 0);
assert.equal((await recover(selection, { ...options, now: 9999999 })).state, 'ALREADY_ATTEMPTED', 'failed reload cannot create an automatic retry storm');
console.log('PASS actual Reader worker recovery: bounded persistent soccer incidents, league/date/period isolation, same-page frame dedup, allowlisted sources, manual cooldown and unchanged prices/authority');
