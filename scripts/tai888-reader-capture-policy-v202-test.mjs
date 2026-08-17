import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../reader/capture-policy.js', import.meta.url), 'utf8');
const context = { globalThis: {} };
vm.createContext(context);
vm.runInContext(source, context);
const policy = context.globalThis.Tai888CapturePolicy;
assert.ok(policy);
assert.equal(policy.version, 'TAI888-DOM-CAPTURE-POLICY-v2.1.0');

assert.equal(policy.shouldKeepRecord(1, '聯盟：MLB 美國職棒(8)'), true);
assert.equal(policy.shouldKeepRecord(1, '聯盟：MLB 美國職棒-主隊總得分(9)'), true);
assert.equal(policy.shouldKeepRecord(1, 'BAL-金鶯[主] 投手[右]'), true);
assert.equal(policy.shouldKeepRecord(2, '08-13 BAL-金鶯 投手[右] 0.950'), true);
assert.equal(policy.shouldKeepRecord(4, '時間 主客隊伍 讓球 大小盤'), true);

assert.equal(policy.shouldInspectFallback({
  text: '聯盟：MLB 美國職棒(8)', childCount: 1, hasRowDescendant: false,
}), true);
assert.equal(policy.shouldInspectFallback({
  text: 'BAL-金鶯 投手[右] 0.950', childCount: 6, hasRowDescendant: false,
}), true);
assert.equal(policy.shouldInspectFallback({
  text: 'BAL-金鶯[主] 投手[右]', childCount: 1, hasRowDescendant: false,
}), true);
assert.equal(policy.shouldInspectFallback({
  text: 'BAL-金鶯 投手[右] 0.950', childCount: 6, hasRowDescendant: true,
}), false);

const content = fs.readFileSync(new URL('../reader/tai888-content.js', import.meta.url), 'utf8');
assert.match(content, /shouldKeepRecord/);
assert.match(content, /Always inspect div\/li grids/);
assert.doesNotMatch(content, /primary\.length\s*<\s*6/);
assert.match(content, /if \(!cells\.length\) cells = \[cellRecord\(element\)\]/);

console.log('Tai888 Reader 2.0.3 capture policy: one-cell league markers and div grids PASS');
