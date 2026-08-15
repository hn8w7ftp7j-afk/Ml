import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync('app/page.js', 'utf8');
assert.match(page, /const VERSION = '9\.4\.2'/);
assert.match(page, /mlb-positive-ev-v9-4-2/);
assert.match(page, /setInterval\(refreshReader, 30000\)/);
assert.match(page, /readerStatus\?\.payloadHash/);
assert.match(page, /autoAnalyzeHashRef/);
assert.match(page, /autoAnalyzePendingRef/);
assert.match(page, /shouldAcknowledgeReaderHash/);
assert.match(page, /30 \* 60 \* 1000/);
assert.match(page, /lastFullAnalysisAtRef/);
assert.match(page, /verificationMarkets: referenceMarkets/);
assert.match(page, /verificationMarkets: item\.referenceMarkets/);
assert.match(page, /Tai888實際盤已下架/);
assert.match(page, /customMarkets: \[\]/);
assert.match(page, /if \(!acknowledged\) window\.setTimeout\(\(\) => \{/);
assert.match(page, /row\.executable === true/);
assert.match(page, /actualLineFreshNow\(row, clockNow\)/);
assert.match(page, /gameIsPrestartNow\(item\.game, Date\.now\(\)\)/);
assert.match(page, /!snapshot \|\| !item\.referenceData/);
assert.match(page, /formalBetEligibility/);
assert.match(page, /mergeRecognizedGameInputs/);
assert.match(page, /readerExecutable=\{readerExecutable\}/);
assert.match(page, /acknowledgedReaderKey\.startsWith\(`\$\{currentReaderHashKey\}:`\)/);
assert.match(page, /confirmLiveReaderHash/);
assert.match(page, /readerRevisionKey/);
assert.match(page, /creditRevisionRef/);
assert.match(page, /pageActivityAt: credit\.pageActivityAt/);
assert.match(page, /statusRevision === creditRevisionRef\.current/);
assert.match(page, /creditRevision === creditRevisionRef\.current/);
assert.match(page, /readerStatusRef/);
assert.match(page, /readerStatusHighWaterRef/);
assert.match(page, /operationBusyRef/);
assert.match(page, /operationBusyRef\.current \|\| readerPollBusyRef\.current/);
assert.match(page, /Reader 最新盤面版本尚未承認/);
assert.match(page, /disabled=\{busy\} onChange=\{event => setDate/);
assert.match(page, /Tai888 Reader 新盤已同步｜等待分析驗證/);
assert.doesNotMatch(page, /readerStatus\?\.fresh \|\| creditProviderStatus\?\.readerFresh/);
assert.doesNotMatch(page, /currentStatus\.payloadHash === creditHashRef\.current/);

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
assert.match(credit, /readerSnapshotMatchesFullOfficialSlate/);
assert.match(credit, /games\.length === schedule\.length/);

console.log('MLB EV v9.4.2 Reader automation audit: empty-board polling, 30-minute core refresh, stale gating, delisting and reprice fallback PASS');
