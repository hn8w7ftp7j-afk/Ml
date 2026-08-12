import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = file => fs.readFileSync(file, 'utf8');
const packageJson = JSON.parse(read('package.json'));
const manifest = JSON.parse(read('reader/manifest.json'));
const markets = read('lib/markets.js');
const settlement = read('lib/taiwan-settlement-v9.js');
const analysis = read('lib/analysis.js');
const score = read('lib/deterministic-score.js');
const finalizer = read('lib/deterministic-finalizer.js');
const analyzeRoute = read('app/api/analyze/route.js');
const repriceRoute = read('app/api/reprice/route.js');
const page = read('app/page.js');
const readerParser = read('lib/tai888-reader-parser-v2.js');
const readerIngest = read('app/api/reader/ingest/route.js');
const security = read('lib/security.js');

assert.equal(packageJson.version, '9.4.0');
assert.equal(manifest.version, '2.0.2');

for (const market of ['全場讓分', '全場大小', '上半讓分', '上半大小']) {
  assert.match(markets, new RegExp(market));
}
assert.match(markets, /MARKET_ORDER/);
assert.match(markets, /validateMarketPair/);
assert.match(markets, /mirrorTaiwanLineToken/);

assert.match(analyzeRoute, /candidateThreshold:\s*7\.2/);
assert.match(analyzeRoute, /strongestThreshold:\s*8\.5/);
assert.match(analyzeRoute, /rebateRate:[\s\S]*0\.015/);
assert.match(repriceRoute, /repriceMarkets/);
assert.match(repriceRoute, /distributionSnapshot/);
assert.match(analysis, /凍結聯合比分分布/);
assert.match(analysis, /目標盤口只用於逐結果結算與價格EV，不回寫比分分布/);
assert.match(analysis, /minimumWaterThresholds/);
assert.match(analysis, /holeAuditForRow/);
assert.match(analysis, /逐比分與結果桶/);
assert.match(analysis, /robustEV/);
assert.match(analysis, /weightedEV/);

assert.match(settlement, /Decimal/);
assert.match(settlement, /settledPrincipal/);
assert.match(settlement, /rebateRate/);
assert.match(settlement, /push/);
assert.match(score, /DUAL-EV-BOTTLENECK/);
assert.match(score, /GENERAL_SINGLE_BET_MAX_8_9/);
assert.doesNotMatch(score, /openai|chatgpt|gpt-/i);
assert.match(finalizer, /noGptScoring:\s*true/);
assert.match(finalizer, /crossMarketVerified/);
assert.match(finalizer, /8\.4/);
assert.match(finalizer, /8\.5/);

assert.match(readerParser, /ACTUAL_TW_CREDIT/);
assert.match(readerParser, /waterEstimated:\s*false/);
assert.match(readerParser, /waterMissing/);
assert.match(readerParser, /TAI888_READER_AUTO/);
assert.match(readerIngest, /payloadHash/);
assert.match(readerIngest, /storeReaderSnapshot/);
assert.match(readerIngest, /scheduleWindow/);
assert.match(page, /\/api\/reader\/status/);
assert.match(page, /\/api\/credit-lines/);
assert.match(page, /\/api\/reprice/);
assert.match(page, /creditHashRef/);
assert.match(page, /Tai888盤口已自動更新/);

assert.match(security, /APP_PASSWORD/);
assert.match(security, /SESSION_SECRET/);
assert.match(security, /requireApiAuth/);
assert.match(security, /checkRateLimit/);
assert.match(security, /validateSameOrigin/);
assert.equal((manifest.permissions || []).includes('cookies'), false);
assert.equal((manifest.permissions || []).includes('webRequest'), false);
assert.equal((manifest.permissions || []).includes('scripting'), false);

console.log(JSON.stringify({
  ok: true,
  websiteVersion: packageJson.version,
  readerVersion: manifest.version,
  markets: ['全場讓分', '全場大小', '上半讓分', '上半大小'],
  candidateThreshold: 7.2,
  strongestThreshold: 8.5,
  rebateRate: 0.015,
  deterministicScoring: true,
  gptNumericScoring: false,
  frozenDistributionRepricing: true,
  actualCreditSourceRequired: true,
  securityGatesPresent: true,
}, null, 2));
