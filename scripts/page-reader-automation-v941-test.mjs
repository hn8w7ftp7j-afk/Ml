import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('app/page.js', 'utf8');
assert.match(page, /const VERSION = '9\.4\.1'/);
assert.match(page, /mlb-positive-ev-v9-4-1/);
assert.match(page, /setInterval\(refreshReader, 30000\)/);
assert.match(page, /readerStatus\?\.payloadHash/);
assert.match(page, /autoAnalyzeHashRef/);
assert.match(page, /30 \* 60 \* 1000/);
assert.match(page, /lastFullAnalysisAtRef/);
assert.match(page, /verificationMarkets: referenceMarkets/);
assert.match(page, /verificationMarkets: item\.referenceMarkets/);
assert.match(page, /Tai888實際盤已下架/);
assert.match(page, /customMarkets: \[\]/);
assert.match(page, /if \(skipped\) window\.setTimeout\(\(\) => oneClickAnalyze\(\), 800\)/);
assert.match(page, /row\.executable !== false/);
assert.match(page, /row\.lineFresh !== false/);
assert.match(page, /readerFresh=\{readerStatus\?\.fresh === true\}/);
assert.match(page, /盤口已過期｜不下注/);

const analyze = fs.readFileSync('app/api/analyze/route.js', 'utf8');
const reprice = fs.readFileSync('app/api/reprice/route.js', 'utf8');
for (const source of [analyze, reprice]) {
  assert.match(source, /applyMarketFreshness/);
  assert.match(source, /applyIndependentMarketVerification/);
  assert.match(source, /verificationMarkets/);
  assert.match(source, /sourceTemplateVersion/);
  assert.match(source, /authorizationStatus/);
}

const finalizer = fs.readFileSync('lib/deterministic-finalizer.js', 'utf8');
assert.match(finalizer, /盤口已過期｜不評分｜不下注/);
assert.match(finalizer, /!executable/);

const credit = fs.readFileSync('app/api/credit-lines/route.js', 'utf8');
assert.match(credit, /limit: 180/);

console.log('MLB EV v9.4.1 Reader automation audit: empty-board polling, 30-minute core refresh, stale gating, delisting and reprice fallback PASS');
