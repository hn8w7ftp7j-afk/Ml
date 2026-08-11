import fs from 'node:fs';

function patch(path, edits) {
  let source = fs.readFileSync(path, 'utf8');
  for (const [label, before, after] of edits) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error(`${path} ${label}: expected once, found ${count}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}

patch('app/api/analyze/route.js', [
  ['cache namespace',
`const responseCache = globalThis.__MLB_V932_ANALYSIS_CACHE__ || new Map();
globalThis.__MLB_V932_ANALYSIS_CACHE__ = responseCache;`,
`const responseCache = globalThis.__MLB_V933_ANALYSIS_CACHE__ || new Map();
globalThis.__MLB_V933_ANALYSIS_CACHE__ = responseCache;`],
  ['rate id', "id: 'analyze-v9-3-2-deterministic'", "id: 'analyze-v9-3-3-deterministic'"],
  ['complete fingerprint input',
`    const fingerprints = buildSnapshotFingerprints({ context: frozenContext, markets: activeMarkets, versions });`,
`    const fingerprints = buildSnapshotFingerprints({
      context: frozenContext,
      markets: activeMarkets,
      versions,
      calculationSettings: settings,
      auxiliaryInput: { previousMarkets },
    });`],
  ['snapshot complete calculation input',
`      inputHash: fingerprints.inputHash, contractSignature: signature,
      distributionId: finalized.distributionId, distributionHash: finalized.distributionHash,`,
`      inputHash: fingerprints.inputHash, contractSignature: signature,
      calculationSettings: fingerprints.calculationPayload,
      auxiliaryInput: fingerprints.auxiliaryPayload,
      distributionId: finalized.distributionId, distributionHash: finalized.distributionHash,`],
]);

patch('app/api/reprice/route.js', [
  ['preserve actual missing water metadata',
`    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),`,
`    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),`],
  ['rate id', "id: 'reprice-v9-2'", "id: 'reprice-v9-3-3'"],
  ['complete reprice fingerprint input',
`    const fingerprints = buildSnapshotFingerprints({ context, markets, versions });`,
`    const fingerprints = buildSnapshotFingerprints({
      context,
      markets,
      versions,
      calculationSettings: settings,
      auxiliaryInput: { previousMarkets },
    });`],
  ['persist reprice calculation input',
`      ...snapshot, priceFingerprint: fingerprints.priceFingerprint, inputHash: fingerprints.inputHash,
      distributionId: snapshot.distributionId, distributionHash: snapshot.distributionHash, versions,`,
`      ...snapshot,
      priceFingerprint: fingerprints.priceFingerprint,
      calculationFingerprint: fingerprints.calculationFingerprint,
      auxiliaryFingerprint: fingerprints.auxiliaryFingerprint,
      inputHash: fingerprints.inputHash,
      calculationSettings: fingerprints.calculationPayload,
      auxiliaryInput: fingerprints.auxiliaryPayload,
      distributionId: snapshot.distributionId,
      distributionHash: snapshot.distributionHash,
      versions,`],
]);

patch('lib/analysis-cache-v9.js', [
  ['cache version',
`export const ANALYSIS_CACHE_VERSION = 'MLB-ANALYSIS-CACHE-GAME-CONTRACT-v2.0.0';`,
`export const ANALYSIS_CACHE_VERSION = 'MLB-ANALYSIS-CACHE-GAME-CONTRACT-v2.1.0';`],
]);

patch('package.json', [
  ['package version', '"version": "9.3.2"', '"version": "9.3.3"'],
]);

patch('app/api/health/route.js', [
  ['health version', "version: '9.3.2'", "version: '9.3.3'"],
]);

patch('app/page.js', [
  ['page version', "const VERSION = '9.3.2';", "const VERSION = '9.3.3';"],
  ['storage namespace',
`const STORAGE = 'mlb-positive-ev-v9-3-2';
const LEGACY_KEYS = ['mlb-positive-ev-v9-3', 'mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];`,
`const STORAGE = 'mlb-positive-ev-v9-3-3';
const LEGACY_KEYS = ['mlb-positive-ev-v9-3-2', 'mlb-positive-ev-v9-3', 'mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];`],
]);

fs.writeFileSync('DEPLOYMENT_VERSION', '9.3.3-complete-calculation-input-hash\n');
console.log('v9.3.3 patch applied');
