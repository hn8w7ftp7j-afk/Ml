import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { readLedgerAfterSettlement } from '../lib/ledger-settlement-refresh.js';
import { summarizeBetLedger } from '../lib/bet-stats.js';

const ledger = { ok: true, bets: [{ id: 'saved', league: 'MLB', status: 'OPEN', stake: 10000 }] };
const failure = new TypeError('Load failed');
let writes = 0;
const recovered = await readLedgerAfterSettlement(async () => { writes++; throw failure; }, async () => ledger);
assert.equal(writes, 1, 'a lost response must never replay a possibly committed write');
assert.equal(recovered.ledger, ledger);
assert.equal(recovered.settlementError, failure);
assert.equal(recovered.settlement, null, 'do not claim the settlement completed');
assert.deepEqual(summarizeBetLedger(recovered.ledger.bets), summarizeBetLedger(ledger.bets));

// A response can be lost after a durable change. Use the actual readback, not
// the old page, to show the current status and never guess the write outcome.
const afterCommit = { ok: true, bets: [{ ...ledger.bets[0], status: 'CANCELLED' }] };
const committed = await readLedgerAfterSettlement(async () => { throw failure; }, async () => afterCommit);
assert.equal(committed.ledger.bets[0].status, 'CANCELLED');
const readFailure = Object.assign(new Error('partial page failed'), { code: 'LEDGER_RESPONSE_INVALID' });
await assert.rejects(readLedgerAfterSettlement(async () => ledger, async () => { throw readFailure; }), error => error === readFailure);
await assert.rejects(readLedgerAfterSettlement(async () => { throw failure; }, async () => ({ ok: false, bets: [] })), { code: 'LEDGER_RESPONSE_INVALID' });
const malformedSettlement = await readLedgerAfterSettlement(async () => ({ ok: true }), async () => ledger);
assert.equal(malformedSettlement.settlementError.code, 'LEDGER_RESPONSE_INVALID');
const success = await readLedgerAfterSettlement(async () => ledger, async () => afterCommit);
assert.equal(success.settlement, ledger);
assert.equal(success.ledger, afterCommit);
assert.equal(success.settlementError, null);

// Exercise the real price-feed callback: DB errors and browser transport errors
// must not invalidate an independently completed ledger or erase its totals.
const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const dashboard = page.slice(page.indexOf('function BetLedgerDashboard('), page.indexOf('function ScorePerformanceDashboard('));
const start = dashboard.indexOf('    const refresh = async () => {');
const end = dashboard.indexOf('\n    refresh();', start);
assert.ok(start >= 0 && end > start);
for (const error of [failure, Object.assign(new Error('DB unavailable'), { status: 503, code: 'DATABASE_UNAVAILABLE' })]) {
  let ledgerFailures = 0;
  let priceError = '';
  let checked = false;
  const context = {
    disposed: false, document: { visibilityState: 'visible' }, Date,
    cloudLedgerAutomaticRefreshAllowed: () => true,
    priceFeedBusyRef: { current: false }, priceFeedRetryAtRef: { current: 0 }, priceBetIds: ['saved'],
    requestJSON: async () => { throw error; }, cloudLedgerRetryDelay: () => 300000,
    setPriceFeed: () => { throw Error('failed price request must not replace data'); },
    setPriceFeedError: value => { priceError = value; },
    setPriceFeedChecked: value => { checked = value; },
    reportCloudLedgerFailure: () => { ledgerFailures++; },
  };
  vm.createContext(context);
  vm.runInContext(`${dashboard.slice(start, end)}\nthis.run = refresh;`, context);
  await context.run();
  assert.equal(ledgerFailures, 0);
  assert.match(priceError, /盤口比較/);
  assert.equal(checked, true);
  assert.equal(context.priceFeedBusyRef.current, false);
}
assert.match(dashboard, /onClick=\{onRetryLedger\}/, 'failed ledger can be retried directly from the performance page');

// A new device can still have legacy records awaiting an acknowledged merge.
// The actual recovery handler must not replace them after that merge fails.
const probeStart = page.indexOf('  async function probeCloudLedgerRecovery()');
const probeEnd = page.indexOf('\n  async function refreshSettlements(', probeStart);
const probeSource = page.slice(probeStart, probeEnd);
for (const mergeFails of [true, false]) {
  const events = [];
  const local = [{ id: 'unmerged-local' }];
  const context = {
    document: { visibilityState: 'visible' },
    cloudSyncBusyRef: { current: false }, betMutationBusyRef: { current: false },
    cloudLedgerGenerationRef: { current: 0 }, cloudSyncRetryAtRef: { current: 100 },
    betsRef: { current: local },
    cloudBetMigrationComplete: () => false, migrateLegacyLocalBets: bets => bets,
    requestJSON: async (_url, options) => {
      events.push('merge');
      assert.equal(JSON.parse(options.body).bets[0].id, 'unmerged-local');
      if (mergeFails) throw failure;
      return ledger;
    },
    requireCloudLedgerResponse: value => {
      if (value?.ok !== true || !Array.isArray(value.bets)) throw Error('invalid ledger');
      return value;
    },
    loadCompactCloudLedger: async () => { events.push('read'); return ledger; },
    markCloudBetMigrationComplete: () => events.push('marked'),
    setCloudLedgerBusy: () => {}, setCalibrationStatus: () => {},
    setBets: () => events.push('replace'),
    setCloudLedgerStatus: () => events.push('ready'),
    reportCloudLedgerFailure: () => events.push('failure'),
  };
  vm.createContext(context);
  vm.runInContext(`${probeSource}\nthis.run = probeCloudLedgerRecovery;`, context);
  await context.run();
  assert.deepEqual(events, mergeFails ? ['merge', 'failure'] : ['merge', 'read', 'marked', 'replace', 'ready']);
  assert.equal(context.betsRef.current, mergeFails ? local : ledger.bets);
}
console.log('PASS ledger refresh isolation: independent complete readback, no replayed writes, no partial success, price outages preserve statistics');
