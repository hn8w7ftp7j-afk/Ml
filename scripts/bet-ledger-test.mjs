import assert from 'node:assert/strict';
import {
  betIdentity,
  betMatches,
  betPositionIdentity,
  betPriceIdentity,
  betPriceMatches,
  canonicalBetPick,
  canonicalBetPosition,
} from '../lib/bet-ledger.js';

const base = { market: '全場大小', pick: '大8平', water: 0.94 };
const identity = betIdentity('2026-08-15', 777001, base);
const stored = { identity, date: '2026-08-15', gamePk: 777001, league: 'MLB', ...base };
assert.match(identity, /^MLB\|\|\|/, '未指定league的新版下注識別只可預設為MLB');

assert.equal(canonicalBetPick('大8'), canonicalBetPick(' 大 8 平 '), '平尾與省略平尾應視為相同盤口');
assert.equal(canonicalBetPick('大8'), canonicalBetPick('大8.0'), '整數與等值小數盤線應視為相同合約');
assert.notEqual(canonicalBetPick('大8+10'), canonicalBetPick('大8-10'), '+/-尾碼不可混用');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, water: 0.82 }), true, '水位更新仍是同一下注方向');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, pick: '大8+10' }), true, '尾碼變化後仍須保留已下注方向');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, pick: '小8平' }), false, '方向變化必須視為不同盤口');
assert.equal(betMatches(stored, '2026-08-15', 777001, { ...base, pick: '大8.5平' }), true, '盤線變化後仍須保留已下注方向');
assert.equal(canonicalBetPosition('大8+10'), canonicalBetPosition('大9-30'));
assert.notEqual(betPositionIdentity('2026-08-15', 777001, base), betPositionIdentity('2026-08-15', 777001, { ...base, pick: '小8平' }));
assert.equal(betMatches(stored, '2026-08-15', 777002, base), false, '雙重賽不同gamePk不可互相標記');
assert.equal(betMatches(stored, '2026-08-16', 777001, base), false, '不同日期不可互相標記');
assert.equal(betMatches(stored, '2026-08-15', 777001, base, 'NPB'), false, '不同聯盟不可共用下注標記');

assert.equal(betPriceMatches(stored, '2026-08-15', 777001, base, 'MLB'), true, '盤口與水位完全相同時只顯示已下注');
assert.equal(betPriceMatches(stored, '2026-08-15', 777001, { ...base, water: 0.95 }, 'MLB'), false, '同盤不同水可新增獨立下注單');
assert.equal(betPriceMatches(stored, '2026-08-15', 777001, { ...base, pick: '大8+10' }, 'MLB'), false, '同方向不同尾碼可新增獨立下注單');
assert.notEqual(
  betPriceIdentity('2026-08-15', 777001, base, 'MLB'),
  betPriceIdentity('2026-08-15', 777001, { ...base, water: 0.95 }, 'MLB'),
);

const npbIdentity = betIdentity('2026-08-15', 777001, base, 'NPB');
const npbStored = { identity: npbIdentity, league: 'NPB', date: '2026-08-15', gamePk: 777001, ...base };
assert.equal(betMatches(npbStored, '2026-08-15', 777001, base, 'NPB'), true);
assert.equal(betMatches(npbStored, '2026-08-15', 777001, base, 'MLB'), false);

const legacy = { gamePk: 777001, market: '全場大小', pick: '大8', water: 0.95 };
assert.equal(betMatches(legacy, '2026-08-15', 777001, base), true, '舊版無identity紀錄仍須相容');
assert.equal(betMatches(legacy, '2026-08-15', 777001, base, 'NPB'), false, '舊版無league紀錄不得流入NPB');
assert.equal(betMatches(legacy, '2026-08-15', 777001, base, 'KBO'), false, '舊版無league紀錄不得流入KBO');
assert.equal(betMatches(legacy, '2026-08-15', 777001, base, 'CPBL'), false, '舊版無league紀錄不得流入CPBL');
assert.equal(betMatches({ ...legacy, date: '2026-08-14' }, '2026-08-15', 777001, base), false, '舊版紀錄若已有日期仍須隔離');

const legacyIdentity = identity.split('|||').slice(1).join('|||');
assert.equal(betMatches({ ...stored, identity: legacyIdentity }, '2026-08-15', 777001, base, 'MLB'), true, '舊版MLB identity必須相容');
assert.equal(betMatches({ ...stored, identity: legacyIdentity }, '2026-08-15', 777001, base, 'KBO'), false, '舊版identity不得流入其他聯盟');

console.log('Bet ledger: position tracking, exact-price suppression, multi-ticket pricing and league isolation PASS');
