import assert from 'node:assert/strict';
import {
  clearGameDistributionCacheForTest,
  GAME_DISTRIBUTION_CACHE_VERSION,
  getOrBuildGameDistribution,
} from '../lib/game-distribution-cache-v1.js';

clearGameDistributionCacheForTest();
let builds = 0;
const input = {
  league: 'MLB',
  gamePk: 123,
  coreFingerprint: 'core-a',
  modelVersion: 'model-a',
  rulesVersion: 'rules-a',
};
const build = () => {
  builds += 1;
  return {
    gamePk: 123,
    modelVersion: 'model-a',
    rulesVersion: 'rules-a',
    distributionId: `distribution-${builds}`,
    distributionHash: `hash-${builds}`,
  };
};

const first = getOrBuildGameDistribution({ ...input, build, now: 1_000, ttlMs: 100 });
const oppositeDirection = getOrBuildGameDistribution({ ...input, build, now: 1_050, ttlMs: 100 });
assert.equal(first.cacheStatus, 'MISS');
assert.equal(oppositeDirection.cacheStatus, 'HIT');
assert.equal(first.snapshot, oppositeDirection.snapshot, '同場正反方向必須共用同一份比分分布');
assert.equal(builds, 1);

const changedCore = getOrBuildGameDistribution({ ...input, coreFingerprint: 'core-b', build, now: 1_060, ttlMs: 100 });
assert.equal(changedCore.cacheStatus, 'MISS', '核心資料改變必須重建分布');
assert.equal(builds, 2);

const expired = getOrBuildGameDistribution({ ...input, build, now: 1_101, ttlMs: 100 });
assert.equal(expired.cacheStatus, 'MISS', '過期分布不得沿用');
assert.equal(builds, 3);
assert.equal(GAME_DISTRIBUTION_CACHE_VERSION, 'BASEBALL-GAME-DISTRIBUTION-CACHE-v1.1.0');

console.log('Game distribution cache: same-game directions share one core distribution; core changes and TTL rebuild PASS');
