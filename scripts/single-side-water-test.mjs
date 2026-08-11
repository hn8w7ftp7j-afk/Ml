import assert from 'node:assert/strict';
import { finalizeDeterministicAnalysis } from '../lib/deterministic-finalizer.js';

const analysis = {
  results: [
    {
      market: '全場大小',
      pick: '大8.5',
      water: 0.95,
      waterEstimated: false,
      sourceType: 'ACTUAL_TW_CREDIT',
      executable: true,
      weightedEV: -0.02,
      robustEV: -0.03,
      modelProbability: 0.40,
      distributionCoverage: 1,
      integrityWarning: false,
      integrityMessage: '',
      evDoubleCheck: { passed: true },
    },
    {
      market: '全場大小',
      pick: '小8.5',
      water: null,
      waterEstimated: false,
      waterMissing: true,
      sourceType: 'ACTUAL_TW_CREDIT',
      executable: false,
      weightedEV: null,
      robustEV: null,
      modelProbability: null,
      distributionCoverage: 1,
      integrityWarning: false,
      integrityMessage: '',
      evDoubleCheck: { passed: true, skipped: true },
    },
  ],
};

const finalized = finalizeDeterministicAnalysis({
  analysis,
  game: { away: '波士頓紅襪', home: '多倫多藍鳥' },
  settings: { candidateThreshold: 7.2, strongestThreshold: 8.5 },
});

const [provided, missing] = finalized.results;
assert.equal(provided.score, 6.6);
assert.equal(provided.tag, 'PASS');
assert.equal(provided.scoreAudit?.ok, true);
assert.equal(provided.pairAudit?.passed, true);
assert.equal(missing.score, null);
assert.match(String(missing.tag), /水位未提供/);
assert.equal(missing.pairAudit?.passed, true);

console.log(JSON.stringify({
  ok: true,
  provided: { pick: provided.pick, water: provided.water, score: provided.score, tag: provided.tag },
  missing: { pick: missing.pick, water: missing.water, score: missing.score, tag: missing.tag },
  pairAudit: provided.pairAudit,
}, null, 2));
