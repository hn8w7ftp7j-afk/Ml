import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const queue = page.split('aria-label="下注紀錄隊列"')[1].split('{cloudLedgerStatus')[0];
assert.match(queue, /failed: '記錄失敗'/);
assert.match(queue, /uncertain: '結果待確認，請先回讀帳本，勿重複新增'/);
assert.match(queue, /資料時間驗證未通過/);
assert.match(queue, /<details><summary>詳細資訊<\/summary><p[^>]*>\{entry.message\}<\/p><\/details>/);
assert.doesNotMatch(queue, /<details\s+open/);
assert.doesNotMatch(queue, /`｜\$\{entry.message\}`/);
console.log('PASS queue copy: failure visible, raw evidence collapsed, long codes wrap');

assert.match(page, /<details className="panel queueSummary" aria-label="下注紀錄隊列">/);
assert.match(queue, /紀錄狀態/);
