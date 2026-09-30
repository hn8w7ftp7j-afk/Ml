import assert from 'node:assert/strict';
import { moneyText } from '../lib/money-display.js';

const marketTotals = [-168667.5, -114365, -192137.5, -209475];
const displayedAmount = value => Number(moneyText(value).replaceAll(',', '').replace('元', ''));
assert.equal(marketTotals.map(displayedAmount).reduce((sum, value) => sum + value, 0), displayedAmount(-684645), 'displayed market amounts must reconcile with the displayed ledger total');
assert.equal(moneyText(-7387.5), '-7,387.5元');
assert.equal(moneyText(915), '+915元');
assert.equal(moneyText(0), '+0元');
assert.equal(moneyText('9.25'), '+9.25元');
for (const value of [null, undefined, NaN, Infinity, 'invalid']) assert.equal(moneyText(value), '—');
console.log('PASS fractional settlement amounts reconcile in the ledger display');
