import assert from 'node:assert/strict';
import { prepareLeagueReaderPreflight } from '../lib/all-league-reader-preflight.js';

const oldSchedule = [{ gamePk: 1 }];
const newSchedule = [{ gamePk: 2 }];
const ready = { blocked: false, readerFresh: true, games: [{ gamePk: 2 }] };
const blocked = { blocked: true, code: 'READER_STALE', message: '盤口已過期' };
let schedules = 0;
const submitted = [], waits = [], messages = [];
const recovered = await prepareLeagueReaderPreflight({
  loadSchedule: async () => ++schedules === 1 ? oldSchedule : newSchedule,
  loadCredit: async games => { submitted.push(games); return submitted.length === 1 ? blocked : ready; },
  onWaiting: message => messages.push(message), wait: async ms => waits.push(ms),
});
assert.deepEqual(submitted, [oldSchedule, newSchedule]);
assert.equal(recovered.credit, ready);
assert.equal(recovered.games, newSchedule);
assert.deepEqual(waits, [5000]);
assert.equal(messages[0].code, 'READER_STALE');

let attempts = 0;
await assert.rejects(prepareLeagueReaderPreflight({
  loadSchedule: async () => oldSchedule,
  loadCredit: async () => { attempts += 1; return blocked; }, wait: async () => {},
}), error => error.code === 'READER_STALE' && error.stage === 'reader_preflight' && error.message === '盤口已過期');
assert.equal(attempts, 4, 'offline Reader must stop after bounded retries');

let scheduleCalls = 0, creditCalls = 0;
const startedDuringWait = await prepareLeagueReaderPreflight({
  loadSchedule: async () => ++scheduleCalls === 1 ? oldSchedule : [],
  loadCredit: async () => { creditCalls += 1; return blocked; }, wait: async () => {},
});
assert.equal(startedDuringWait.emptyReason, 'no_games');
assert.equal(creditCalls, 1, 'do not resubmit a game that started during the wait');

const identityError = Object.assign(new Error('官方識別不符'), { code: 'OFFICIAL_IDENTITY_MISMATCH' });
let identityCalls = 0;
await assert.rejects(prepareLeagueReaderPreflight({
  loadSchedule: async () => oldSchedule,
  loadCredit: async () => { identityCalls += 1; throw identityError; },
  wait: async () => { throw new Error('must not retry hard identity errors'); },
}), error => error === identityError);
assert.equal(identityCalls, 1);

const mixed = await Promise.allSettled(['NPB', 'KBO', 'CPBL'].map(league => prepareLeagueReaderPreflight({
  loadSchedule: async () => oldSchedule,
  loadCredit: async () => league === 'NPB' ? blocked : ready,
  wait: async () => {},
})));
assert.deepEqual(mixed.map(row => row.status), ['rejected', 'fulfilled', 'fulfilled']);
const noMarkets = { blocked: false, readerFresh: true, games: [] };
assert.equal((await prepareLeagueReaderPreflight({ loadSchedule: async () => oldSchedule, loadCredit: async () => noMarkets })).credit, noMarkets);
console.log('Reader preflight: fresh recovery, refreshed schedule, bounded offline wait, started-game exclusion, identity safety and league isolation PASS');
