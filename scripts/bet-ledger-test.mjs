import assert from 'node:assert/strict';
import { betIdentity, betMatches, canonicalBetPick } from '../lib/bet-ledger.js';

const base = { market: '全場大小', pick: '大8平', water: 0.94 };
const identity = betIdentity('2026-08-15', 777001, base);
const stored = { identity, date: '2026-08-15', gamePk: 777001, ...base };

assert.equal(canonicalBetPick('大8'), canonicalBetPick(' 大 8 平 '), '平尾與省略平尾應視為相同盤口');
assert.equal(canonicalBetPick('大8'), canonicalBetPick('大8.0'), '整數與等值小數盤線應視為相同合約');
assert.notEqual(canonicalBetPick('大8+10'), canonicalBetPick('大8-10'), '+/-尾碼不可混用');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, water: 0.82 }), true, '水位更新不應移除已下注標記');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, pick: '大8+10' }), false, '尾碼變化必須視為不同盤口');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, pick: '小8平' }), false, '方向變化必須視為不同盤口');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, pick: '大8.5平' }), false, '盤線變化必須視為不同盤口');
assert.equal(betMatches(stored, '2026-08-15', 777002, base), false, '雙重賽不同gamePk不可互相標記');
assert.equal(betMatches(stored, '2026-08-16', 777001, base), false, '不同日期不可互相標記');

const legacy = { gamePk: 777001, market: '全場大小', pick: '大8', water: 0.95 };
assert.equal(betMatches(legacy, '2026-08-15', 777001, base), true, '舊版無identity紀錄仍須相容');
assert.equal(betMatches({ ...legacy, date: '2026-08-14' }, '2026-08-15', 777001, base), false, '舊版紀錄若已有日期仍須隔離');

console.log('Bet ledger identity: canonical line, water-stable matching, direction/tail/doubleheader isolation and legacy compatibility PASS');
