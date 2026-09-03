import assert from 'node:assert/strict';
import { bindVerifiedReaderContractsForItem } from '../lib/client-analysis-state.js';
import { BET_ACTION_STATE_VERSION, evaluateBetAction } from '../lib/bet-action-state-v118.js';

const now = Date.parse('2026-09-03T00:00:00.000Z');
const baseRow = {
  market: '全場大小', pick: '大8+50', water: 0.95,
  sourceType: 'ACTUAL_TW_CREDIT', provider: 'TAI888_READER_AUTO',
  evCalibration: { actualReaderEligible: false },
};
const baseItem = {
  status: 'done', analysisFailure: null,
  game: { gameDate: '2026-09-03T10:00:00.000Z' },
  actualSource: { provider: 'TAI888_READER_AUTO' },
  readerPayloadHash: 'reader-board-hash',
  readerProvenance: { provider: 'TAI888_READER_AUTO', payloadHash: 'reader-board-hash' },
  customMarkets: [{ ...baseRow, executable: true }],
  customData: { pitPersistence: { confirmed: true } },
};

assert.equal(BET_ACTION_STATE_VERSION, '11.8.38');
const [boundRow] = bindVerifiedReaderContractsForItem(baseItem, [baseRow]);
assert.equal(boundRow.clientVerifiedReaderContract, true, 'exact current signed Reader contract must bind to an immutable legacy PIT row');

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

const open = evaluateBetAction({ item: baseItem, row: boundRow, now, latest: { status: 'OPEN' } });
assert.equal(open.kind, 'cancel');
assert.equal(open.disabled, false);
assert.equal(evaluateBetAction({ item: baseItem, row: boundRow, now, latest: { status: 'WON' } }).text, '已下注 ✓');
const rebet = evaluateBetAction({ item: baseItem, row: boundRow, now, cancelled: { status: 'CANCELLED' } });
assert.equal(rebet.text, '重新紀錄下注');
assert.equal(rebet.recordable, true);

console.log('bet action state v11.8.38 tests passed');
