import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { betDisplayMatches, betPriceMatches, betPositionIdentity } from '../lib/bet-ledger.js';
import { bindVerifiedReaderContractsForItem, readerPitMatchesGameRevision } from '../lib/client-analysis-state.js';
import { evaluateBetAction } from '../lib/bet-action-state-v118.js';
import { createBetRecordQueue } from '../lib/bet-record-queue.js';
import { BET_ATTEMPT_JOURNAL_KEY, loadBetAttemptJournal, saveBetAttemptJournal } from '../lib/bet-attempt-journal.js';

const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const start = page.indexOf('  function getBetState(');
const end = page.indexOf('\n  function updateBoard(', start);
assert.ok(start > 0 && end > start);
const now = Date.parse('2026-09-27T12:46:00Z');
const date = '2026-09-28';
const oldHash = 'a'.repeat(64), newHash = 'b'.repeat(64);
const row = { market: '全場大小', pick: '大8+50', water: 0.94,
  sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO', executable: true,
  readerGameMarketHash: oldHash, evCalibration: { actualReaderEligible: true } };
const candidate = { league: 'MLB', date, gamePk: 822679, ...row, stake: 10000 };
const key = betPositionIdentity(date, candidate.gamePk, candidate, 'MLB');
const savedBet = { ...candidate, id: 'server-original-ticket', placedAt: '2026-09-27T12:41:00Z',
  status: 'OPEN', pitSnapshotId: 'original-pit', readerEvidenceStatus: 'SERVER_VERIFIED_CURRENT_READER',
  pitEvidenceVerified: true, pitPredictionStatus: 'IMMUTABLE_PIT_VERIFIED' };
const originalTicket = JSON.stringify(savedBet);
const item = { status: 'done', game: { gamePk: candidate.gamePk, gameDate: '2026-09-27T17:05:00Z' },
  actualSource: { provider: 'TAI888_READER_AUTO' }, readerPayloadHash: 'board-current',
  readerProvenance: { provider: 'TAI888_READER_AUTO', payloadHash: 'board-current', readerGameMarketHash: newHash },
  customMarkets: [{ ...row, readerGameMarketHash: newHash }],
  customData: { pitPersistence: { confirmed: true }, analysis: { pitSnapshotId: 'old-pit', results: [row] } },
  pendingReaderAnalysis: true };
const context = vm.createContext({ bets: [savedBet], date, league: 'MLB', betQueueEntries: [],
  betDisplayMatches, betPriceMatches, betPositionIdentity, Date });
vm.runInContext(page.slice(start, end), context);

// Same selected price, but a different market in this game has moved. The
// existing ticket stays visible while the old analysis cannot create a new one.
const [staleRow] = bindVerifiedReaderContractsForItem(item, [row]);
assert.equal(staleRow.readerGameMarketHash, oldHash);
assert.equal(readerPitMatchesGameRevision(item, newHash), false);
assert.equal(evaluateBetAction({ item, row: staleRow, now }).recordable, false);
assert.equal(evaluateBetAction({ item, row: staleRow, now, ...context.getBetState(item, staleRow) }).kind, 'cancel');

const newRow = { ...row, pick: '大9-20', water: 0.96, readerGameMarketHash: newHash };
const reanalysed = { ...item, pendingReaderAnalysis: false, customMarkets: [newRow],
  customData: { pitPersistence: { confirmed: true }, analysis: { pitSnapshotId: 'new-pit', results: [newRow] } } };
const stateAfterReanalysis = context.getBetState(reanalysed, newRow);
assert.equal(stateAfterReanalysis.latest.id, savedBet.id);
assert.equal(stateAfterReanalysis.exact, null, 'new price must not rewrite the placed contract');
assert.equal(evaluateBetAction({ item: reanalysed, row: newRow, now, ...stateAfterReanalysis }).kind, 'cancel');
assert.equal(JSON.stringify(savedBet), originalTicket);
context.league = 'KBO';
assert.equal(context.getBetState(reanalysed, newRow).latest, null, 'same numeric game id in another league is isolated');
context.league = 'MLB';
context.bets = [JSON.parse(originalTicket)];
assert.equal(context.getBetState(reanalysed, newRow).latest.id, savedBet.id, 'fresh server ledger read preserves the exact original ticket');

// A favorite flip changes the contract price, not the selected team's existing
// historical ticket. Display matching must not rewrite server position keys.
const oldRunline = { ...savedBet, id: 'original-runline-ticket', market: '全場讓分',
  pick: '洋基讓0.5', away: '洋基', home: '紅襪' };
const currentRunline = { ...newRow, market: '全場讓分', pick: '洋基受讓0.5', water: 0.96 };
const frozenRunline = JSON.stringify(oldRunline);
context.bets = [oldRunline];
const flippedState = context.getBetState(reanalysed, currentRunline);
assert.equal(flippedState.latest.id, oldRunline.id, 'same selected team retains its original ticket across giving/receiving changes');
assert.equal(flippedState.latest.pick, '洋基讓0.5');
assert.equal(flippedState.latest.water, oldRunline.water);
assert.equal(flippedState.exact, null, 'a favorite flip must never be shown as the exact placed contract');
assert.equal(evaluateBetAction({ item: reanalysed, row: currentRunline, now, ...flippedState }).recordable, false);
assert.notEqual(betPositionIdentity(date, candidate.gamePk, oldRunline, 'MLB'),
  betPositionIdentity(date, candidate.gamePk, currentRunline, 'MLB'), 'display recovery must leave canonical write identities unchanged');
for (const changedRow of [
  { ...currentRunline, pick: '紅襪讓0.5' },
  { ...currentRunline, market: '上半讓分' },
  { ...currentRunline, pick: '大8.5' },
]) assert.equal(context.getBetState(reanalysed, changedRow).latest, null);
assert.equal(betDisplayMatches(oldRunline, '2026-09-29', candidate.gamePk, currentRunline, 'MLB'), false);
assert.equal(betDisplayMatches(oldRunline, date, candidate.gamePk + 1, currentRunline, 'MLB'), false);
assert.equal(betDisplayMatches(oldRunline, date, candidate.gamePk, currentRunline, 'NPB'), false);
assert.equal(betDisplayMatches({ ...oldRunline, date: undefined }, date, candidate.gamePk, currentRunline, 'MLB'), false,
  'legacy records without a date cannot expand into a role-flip display match');
assert.equal(betDisplayMatches({ ...oldRunline, pick: '讓0.5' }, date, candidate.gamePk, { ...currentRunline, pick: '受讓0.5' }, 'MLB'), false,
  'missing selected teams cannot match across roles');
context.bets = [{ ...oldRunline, status: 'CANCELLED' }];
const cancelledFlip = context.getBetState(reanalysed, currentRunline);
assert.equal(cancelledFlip.latest, null);
assert.equal(cancelledFlip.cancelled.id, oldRunline.id);
const flippedReadyItem = { ...reanalysed, customMarkets: [currentRunline],
  customData: { pitPersistence: { confirmed: true }, analysis: { pitSnapshotId: 'new-pit', results: [currentRunline] } } };
assert.equal(evaluateBetAction({ item: flippedReadyItem, row: currentRunline, now, ...cancelledFlip }).recordable, true,
  'a cancelled historical display match must not block a verified current contract');
assert.equal(JSON.stringify(oldRunline), frozenRunline);
context.bets = [savedBet];

// A rejected click remains a rejected click after reanalysis and reload. Its
// restored metadata never executes the writer or claims a completed ticket.
const memory = new Map();
const storage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
let entries = [], writes = 0;
const queue = createBetRecordQueue(value => { entries = value; assert.equal(saveBetAttemptJournal(value, storage).ok, true); });
queue.enqueue(key, 'Test game｜大8+50', async () => {
  writes += 1;
  return { status: 'failed', requiresRecheck: true, rejectedPitSnapshotId: 'old-pit', message: 'PIT與Reader版本不符' };
}, candidate);
while (queue.running) await new Promise(setImmediate);
assert.equal(entries[0].status, 'failed');
const restored = createBetRecordQueue(value => { entries = value; });
assert.equal(restored.restore(loadBetAttemptJournal(storage).entries).ok, true);
assert.equal(restored.running, false);
assert.equal(writes, 1, 'reload never resubmits');
const action = evaluateBetAction({ item: reanalysed, row: newRow, now, queued: entries[0] });
assert.equal(action.recordable, true);
assert.equal(action.text, '記錄未成功｜重試');
assert.match(action.failureMessage, /版本不符/);
assert.notEqual(action.text, '已下注 ✓');
assert.equal(restored.confirm(key, { ok: true, bets: [] }), false);

// Execute the actual page initialization and effects, including the callback
// that writes the journal. Module-only tests cannot catch incorrect restore
// conditions, local-ledger confirmation, or overwriting partial corruption.
const restoreStart = page.indexOf('  if (!betQueueRef.current) betQueueRef.current = createBetRecordQueue(');
const restoreEnd = page.indexOf('  const betQueueActive =', restoreStart);
const reconcileStart = page.indexOf("  useEffect(() => {\n    if (cloudLedgerStatus.state !== 'ready') return;");
const reconcileEndToken = '  }, [bets, betQueueEntries, cloudLedgerStatus.state]);';
const reconcileEnd = page.indexOf(reconcileEndToken, reconcileStart);
assert.ok(restoreStart > 0 && restoreEnd > restoreStart && reconcileStart > restoreEnd && reconcileEnd > reconcileStart);
function pageJournalHarness(raw) {
  const values = new Map([[BET_ATTEMPT_JOURNAL_KEY, raw]]);
  const state = { entries: [], warning: '', publications: 0, saves: 0, effects: [] };
  const local = { getItem: value => values.get(value) ?? null, setItem: (value, data) => { state.saves += 1; values.set(value, data); } };
  const env = vm.createContext({
    betQueueRef: { current: null }, betAttemptJournalWritableRef: { current: false },
    createBetRecordQueue,
    loadBetAttemptJournal: () => loadBetAttemptJournal(local),
    saveBetAttemptJournal: entries => saveBetAttemptJournal(entries, local),
    setBetQueueEntries: entries => { state.entries = entries; state.publications += 1; },
    setBetAttemptStorageWarning: warning => { state.warning = warning; },
    useEffect: setup => { state.effects.push(setup); },
    cloudLedgerStatus: { state: 'loading' }, bets: [savedBet], betQueueEntries: [],
  });
  vm.runInContext(page.slice(restoreStart, restoreEnd), env);
  vm.runInContext(page.slice(reconcileStart, reconcileEnd + reconcileEndToken.length), env);
  assert.equal(state.effects.length, 2);
  state.effects[0]();
  state.effects[0](); // React StrictMode repeats effect setup.
  return { state, env, values, sync: state.effects[1] };
}
const confirmedEntry = { ...loadBetAttemptJournal(storage).entries[0], status: 'confirmed', confirmedBetId: savedBet.id };
const healthyPage = pageJournalHarness(JSON.stringify({ version: 1, entries: [confirmedEntry] }));
assert.equal(healthyPage.state.entries.length, 1, 'StrictMode must not duplicate restored attempts');
assert.equal(healthyPage.state.entries[0].status, 'uncertain', 'local confirmed state is not a cloud receipt');
assert.equal(healthyPage.env.betQueueRef.current.running, false, 'restored attempts have no runners');
healthyPage.sync();
assert.equal(healthyPage.state.entries[0].status, 'uncertain', 'cached local bets cannot confirm during cloud loading');
healthyPage.env.cloudLedgerStatus = { state: 'unavailable' };
healthyPage.sync();
assert.equal(healthyPage.state.entries[0].status, 'uncertain');
healthyPage.env.cloudLedgerStatus = { state: 'ready' };
healthyPage.sync();
assert.equal(healthyPage.state.entries[0].status, 'confirmed');
assert.equal(healthyPage.state.entries[0].confirmedBetId, savedBet.id);
healthyPage.env.bets = [{ ...savedBet, status: 'CANCELLED' }];
healthyPage.sync();
assert.equal(healthyPage.state.entries[0].status, 'failed', 'exact cloud cancellation permits a manual new attempt');
const publicationsAfterCancel = healthyPage.state.publications;
healthyPage.sync();
assert.equal(healthyPage.state.publications, publicationsAfterCancel, 'stable reconciliation cannot trigger an effect publication loop');

const damagedRaw = JSON.stringify({ version: 1, entries: [confirmedEntry, { key: 'damaged-entry' }] });
const damagedPage = pageJournalHarness(damagedRaw);
assert.equal(damagedPage.state.entries.length, 1, 'valid entries in a partially damaged journal must still restore');
assert.equal(damagedPage.state.entries[0].status, 'uncertain');
assert.equal(damagedPage.state.saves, 0, 'restoring a valid subset must not overwrite the damaged original');
assert.match(damagedPage.state.warning, /無法驗證/);
assert.equal(damagedPage.env.betAttemptJournalWritableRef.current, false);
damagedPage.env.cloudLedgerStatus = { state: 'ready' };
damagedPage.sync();
assert.equal(damagedPage.state.entries[0].status, 'confirmed', 'validated subset can still reconcile with the real ledger');
const warningBeforeClick = damagedPage.state.warning;
const anotherCandidate = { ...candidate, gamePk: candidate.gamePk + 1 };
let explicitWrites = 0;
assert.equal(damagedPage.env.betQueueRef.current.enqueue(
  betPositionIdentity(date, anotherCandidate.gamePk, anotherCandidate, 'MLB'), 'another explicit click',
  async () => { explicitWrites += 1; return { status: 'failed', message: 'explicit rejection' }; }, anotherCandidate,
), true);
while (damagedPage.env.betQueueRef.current.running) await new Promise(setImmediate);
assert.equal(explicitWrites, 1, 'only the new explicit click can execute a writer');
assert.equal(damagedPage.state.saves, 0);
assert.equal(damagedPage.values.get(BET_ATTEMPT_JOURNAL_KEY), damagedRaw, 'later clicks and reconciliation must preserve the damaged original');
assert.equal(damagedPage.state.warning, warningBeforeClick, 'the storage warning must survive later queue events');
console.log('Bet reanalysis recovery: immutable tickets, stale PIT, rejected reload, actual page StrictMode/readiness effects and partial-corruption preservation PASS');

// Read-only historical labels survive reanalysis, game start and sync outages.
// These labels cannot grant a new recording or cancellation action.
for (const pending of [false, true]) {
  for (const ledgerState of ['ready', 'loading', 'unavailable']) {
    for (const afterStart of [false, true]) {
      const recorded = evaluateBetAction({ item: { ...reanalysed, pendingReaderAnalysis: pending },
        row: newRow, latest: savedBet, cloudLedgerState: ledgerState,
        now: afterStart ? Date.parse('2026-09-28T00:00:00Z') : now });
      assert.match(recorded.text, /已下注/, 'a saved original ticket must not become only an availability gate label');
      assert.equal(recorded.recordable, false);
      assert.equal(recorded.kind, !afterStart && ledgerState === 'ready' ? 'cancel' : 'none');
      const readOnly = evaluateBetAction({ item: reanalysed, row: newRow, latest: savedBet,
        now, betsEnabled: false, cloudLedgerState: ledgerState });
      assert.match(readOnly.text, /已下注/);
      assert.equal(readOnly.kind, 'none');
      assert.equal(readOnly.recordable, false);
      assert.equal(readOnly.disabled, true);
    }
  }
}
assert.doesNotMatch(evaluateBetAction({ item: reanalysed, row: newRow, now, cloudLedgerState: 'loading' }).text, /已下注/,
  'a missing record cannot be promoted to a successful saved ticket');
const scopeStart = page.indexOf('  const recordedScopeBets = useMemo(');
const scopeEnd = page.indexOf('\n\n  function getBetState(', scopeStart);
assert.ok(scopeStart > 0 && scopeEnd > scopeStart);
const scopeContext = vm.createContext({ date, visibleBets: [savedBet,
  { ...savedBet, id: 'cancelled', status: 'CANCELLED' },
  { ...savedBet, id: 'other-day', date: '2026-10-01' }], useMemo: fn => fn(), Date });
vm.runInContext(page.slice(scopeStart, scopeEnd) + '\nglobalThis.scope = recordedScopeBets;', scopeContext);
assert.deepEqual(Array.from(scopeContext.scope, bet => bet.id), [savedBet.id]);
assert.match(page, /\['board', 'ranking', 'betOrder'\]\.includes\(tab\) && recordedScopeBets.length/);
assert.match(page, /保留上次取得的紀錄；目前雲端狀態尚待確認/);
assert.doesNotMatch(page, /const betState = (?:betsEnabled|bettingEnabled) \? getBetState/,
  'historical record visibility must not depend on permissions to create new records');
console.log('Read-only historical labels across reanalysis/start/outage and date-scoped known ledger PASS');
