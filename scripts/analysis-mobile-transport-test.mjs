import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAsianGameContext } from '../lib/asian-baseball.js';
import { buildDistributionSnapshot } from '../lib/analysis-v11.js';
import {
  compactRepriceSnapshot,
  initialAnalysisConcurrency,
  resolveRepriceDistribution,
} from '../lib/analysis-transport-v1.js';

const league = 'KBO';
const game = {
  league,
  leagueId: league,
  gamePk: 880601,
  gameDate: '2099-08-23T09:00:00.000Z',
  officialDate: '2099-08-23',
  taipeiDate: '2099-08-23',
  statusCode: 'S',
  scheduledInnings: 9,
  venue: '測試球場',
  away: 'KIA虎',
  home: 'LG雙子',
  awayTeamId: 601,
  homeTeamId: 603,
};
const historyGames = Array.from({ length: 18 }, (_, index) => ({
  ...game,
  gamePk: game.gamePk + index + 1,
  gameDate: `2099-08-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
  officialDate: `2099-08-${String(index + 1).padStart(2, '0')}`,
  statusCode: 'F',
  awayScore: [2, 5, 1, 4, 3, 6][index % 6],
  homeScore: [3, 1, 5, 2, 4, 2][index % 6],
  innings: index % 7 === 0 ? 10 : 9,
}));

const frozenContext = await buildAsianGameContext(league, game, { historyGames });
const distributionSnapshot = buildDistributionSnapshot({ context: frozenContext });
const full = {
  frozenContext,
  distributionSnapshot,
  distributionId: distributionSnapshot.distributionId,
  distributionHash: distributionSnapshot.distributionHash,
  coreFingerprint: 'transport-test-core',
};
const compact = compactRepriceSnapshot(full);
assert.equal(compact.distributionSnapshot, undefined);
assert.ok(Buffer.byteLength(JSON.stringify(full)) > 600_000, 'fixture must reproduce the large mobile payload');
assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 30_000, 'compact signed snapshot must remain phone-safe');

const rebuilt = resolveRepriceDistribution(compact, buildDistributionSnapshot);
assert.equal(rebuilt.rebuilt, true);
assert.equal(rebuilt.matches, true);
assert.equal(rebuilt.distributionSnapshot.distributionHash, distributionSnapshot.distributionHash);
assert.equal(initialAnalysisConcurrency('MLB'), 2);
assert.equal(initialAnalysisConcurrency('NPB'), 1);
assert.equal(initialAnalysisConcurrency('KBO'), 1);
assert.equal(initialAnalysisConcurrency('CPBL'), 1);

const pageSource = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
assert.match(pageSource, /ANALYSIS_REQUEST_TIMEOUT_MS = 120_000/);
assert.match(pageSource, /runPool\(tasks, analysisConcurrency/);
assert.match(pageSource, /runPool\(retryIndexes, 1/);

console.log('MLB/NPB/KBO/CPBL mobile analysis transport, compact snapshot and deterministic reprice rebuild PASS');
