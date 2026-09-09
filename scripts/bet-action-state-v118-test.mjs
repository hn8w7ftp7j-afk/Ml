import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bindVerifiedReaderContractsForItem } from '../lib/client-analysis-state.js';
import { BET_ACTION_STATE_VERSION, evaluateBetAction } from '../lib/bet-action-state-v118.js';

const now = Date.parse('2026-09-03T00:00:00.000Z');
const baseRow = {
  market: '全場大小', pick: '大8+50', water: 0.95,
  sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO',
  readerGameMarketHash: 'game-market-hash',
  evCalibration: { actualReaderEligible: false },
};
const baseItem = {
  status: 'done', analysisFailure: null,
  game: { gameDate: '2026-09-03T10:00:00.000Z' },
  actualSource: { provider: 'TAI888_READER_AUTO' },
  readerPayloadHash: 'reader-board-hash',
  readerProvenance: { provider: 'TAI888_READER_AUTO', payloadHash: 'reader-board-hash', readerGameMarketHash: 'game-market-hash' },
  customMarkets: [{ ...baseRow, executable: true }],
  customData: { pitPersistence: { confirmed: true } },
};

assert.equal(BET_ACTION_STATE_VERSION, '11.8.44');
const [boundRow] = bindVerifiedReaderContractsForItem(baseItem, [baseRow]);
assert.equal(boundRow.clientVerifiedReaderContract, true, 'exact current signed Reader contract must bind to an immutable legacy PIT row');

const advancedBoardItem = {
  ...baseItem,
  readerPayloadHash: 'new-board-hash',
  readerProvenance: { ...baseItem.readerProvenance, payloadHash: 'old-board-hash' },
};
const [sameGameBoundRow] = bindVerifiedReaderContractsForItem(advancedBoardItem, [baseRow]);
assert.equal(sameGameBoundRow.clientVerifiedReaderContract, true, 'an unrelated league-board revision must not lock an unchanged signed game contract');
assert.equal(evaluateBetAction({ item: advancedBoardItem, row: sameGameBoundRow, now }).recordable, true);

const [changedGameRow] = bindVerifiedReaderContractsForItem({
  ...advancedBoardItem,
  customMarkets: [{ ...baseRow, readerGameMarketHash: 'changed-game-market-hash' }],
}, [baseRow]);
assert.notEqual(changedGameRow.clientVerifiedReaderContract, true, 'a changed game-market revision must remain blocked until the new analysis is bound');

for (const context of ['GAME_CARD', 'RANKING', 'BET_ORDER', 'RECORD_BET']) {
  const action = evaluateBetAction({ item: baseItem, row: boundRow, now, betsEnabled: true, cloudLedgerState: 'ready' });
  assert.equal(action.recordable, true, `${context} must expose the same enabled record action`);
  assert.equal(action.disabled, false, `${context} record action must be clickable`);
  assert.equal(action.text, '紀錄實際下注');
}

assert.equal(evaluateBetAction({ item: baseItem, row: boundRow, now, cloudLedgerState: 'loading' }).reasonCode, 'LEDGER_LOADING');
assert.equal(evaluateBetAction({ item: { ...baseItem, customData: { pitPersistence: { confirmed: false } } }, row: boundRow, now }).reasonCode, 'PIT_UNCONFIRMED');
assert.equal(evaluateBetAction({ item: baseItem, row: baseRow, now }).reasonCode, 'READER_UNVERIFIED');
assert.equal(evaluateBetAction({ item: { ...baseItem, game: { gameDate: '2026-09-02T10:00:00.000Z' } }, row: boundRow, now }).reasonCode, 'GAME_STARTED');

const [unboundRow] = bindVerifiedReaderContractsForItem(baseItem, [{ ...baseRow, water: 0.94 }]);
assert.notEqual(unboundRow.clientVerifiedReaderContract, true, 'a different Reader price must remain blocked');
assert.equal(evaluateBetAction({ item: baseItem, row: unboundRow, now }).reasonCode, 'READER_UNVERIFIED');

const currentAuthority = {
  fresh: true,
  boardDate: '2026-09-03',
  expectedBoardDate: '2026-09-03',
  payloadHash: 'reader-board-hash',
};
assert.equal(evaluateBetAction({ item: baseItem, row: boundRow, now, readerAuthority: currentAuthority }).recordable, true,
  'the current server Reader payload must keep an exactly-bound contract recordable');
const advancedAuthority = { ...currentAuthority, payloadHash: 'newer-server-reader-hash' };
const staleBrowserAction = evaluateBetAction({ item: baseItem, row: boundRow, now, readerAuthority: advancedAuthority });
assert.equal(staleBrowserAction.reasonCode, 'READER_UNVERIFIED',
  'a row bound to an older browser payload must be blocked when the server Reader payload advances');
assert.equal(staleBrowserAction.text, '盤口版本待複核');
assert.equal(staleBrowserAction.readerReasonCode, 'READER_REVISION_MISMATCH');
assert.equal(staleBrowserAction.canRecheck, true);
assert.equal(staleBrowserAction.disabled, true);
assert.equal(evaluateBetAction({
  item: baseItem,
  row: boundRow,
  now,
  readerAuthority: { ...currentAuthority, fresh: false },
}).recordable, false, 'a stale Reader authority must never expose a clickable record button');

const open = evaluateBetAction({ item: baseItem, row: boundRow, now, latest: { status: 'OPEN' } });
assert.equal(open.kind, 'cancel');
assert.equal(open.disabled, false);
assert.equal(evaluateBetAction({ item: baseItem, row: boundRow, now, latest: { status: 'WON' } }).text, '已下注 ✓');
const rebet = evaluateBetAction({ item: baseItem, row: boundRow, now, cancelled: { status: 'CANCELLED' } });
assert.equal(rebet.text, '重新紀錄下注');
assert.equal(rebet.recordable, true);

for (const [authority, code] of [
  [{ ...currentAuthority, payloadHash: null }, 'READER_MISSING'],
  [{ ...currentAuthority, fresh: false }, 'READER_NOT_FRESH'],
  [{ ...currentAuthority, boardDate: '2026-09-02' }, 'READER_DATE_MISMATCH'],
]) {
  const action = evaluateBetAction({ item: baseItem, row: boundRow, now, readerAuthority: authority });
  assert.equal(action.readerReasonCode, code);
  assert.equal(action.disabled, true);
  assert.equal(action.canRecheck, true);
  assert.doesNotMatch(action.title, /自動開放/);
}
for (const [patch, code] of [
  [{ water: null }, 'READER_WATER_UNVERIFIED'],
  [{ waterEstimated: true }, 'READER_WATER_UNVERIFIED'],
  [{ provider: 'OTHER' }, 'READER_SOURCE_UNVERIFIED'],
]) {
  const action = evaluateBetAction({ item: baseItem, row: { ...boundRow, ...patch }, now, readerAuthority: currentAuthority });
  assert.equal(action.readerReasonCode, code);
  assert.equal(action.recordable, false);
}
const running = evaluateBetAction({ item: { ...baseItem, status: 'running' }, row: boundRow, now });
assert.equal(running.readerReasonCode, 'ANALYSIS_NOT_READY');
assert.equal(running.canRecheck, false);
const inactive = evaluateBetAction({ item: { ...baseItem, statusLabel: '目前已不在官方賽前清單' }, row: boundRow, now });
assert.equal(inactive.canRecheck, false);
assert.equal(inactive.recordable, false);
// All three UI surfaces expose explicit user-triggered recovery, never a bet mutation.
const page = readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
assert.equal((page.match(/<ReaderRecovery action=/g) || []).length, 3);
const recovery = page.slice(page.indexOf('function ReaderRecovery('), page.indexOf('function ResultRow('));
assert.match(recovery, /onClick=\{onRecheck\}/);
assert.match(recovery, /disabled=\{busy\}/);
assert.match(recovery, /action.canRecheck/);
assert.doesNotMatch(recovery, /recordBet|cancelBet|useEffect/);
const recheck = page.slice(page.indexOf('  function recheckReaderItem('), page.indexOf('  async function oneClickAnalyze('));
assert.match(recheck, /Number.isSafeInteger\(gamePk\)/);
assert.match(recheck, /return oneClickAnalyze\('', gamePk\)/);
assert.doesNotMatch(recheck, /recordBet|cancelBet/);
console.log('bet action state v11.8.44 tests passed');
