import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildAsianGameContext } from '../lib/asian-baseball.js';
import { buildDistributionSnapshot } from '../lib/analysis-v11.js';
import {
  compactAnalysisContext,
  compactRepriceSnapshot,
  initialAnalysisConcurrency,
} from '../lib/analysis-transport-v1.js';

const league = 'KBO';
const game = {
  league, leagueId: league, gamePk: 880601, gameDate: '2099-08-23T09:00:00.000Z',
  officialDate: '2099-08-23', taipeiDate: '2099-08-23', statusCode: 'S', scheduledInnings: 9,
  venue: '測試球場', away: 'KIA虎', home: 'LG雙子', awayTeamId: 601, homeTeamId: 603,
};
const historyGames = Array.from({ length: 18 }, (_, index) => ({
  ...game, gamePk: game.gamePk + index + 1,
  gameDate: `2099-08-${String(index + 1).padStart(2, '0')}T09:00:00.000Z`,
  statusCode: 'F', awayScore: 2 + (index % 4), homeScore: 1 + (index % 5), innings: 9,
}));

const frozenContext = await buildAsianGameContext(league, game, { historyGames });
assert.equal(frozenContext.coreModelable, false);
assert.throws(
  () => buildDistributionSnapshot({ context: frozenContext }),
  error => error?.code === 'ASIAN_DISTRIBUTION_INPUT_GATE_BLOCKED',
  'mobile transport must not rebuild an Asian distribution with an incomplete PIT gate',
);
const compactContext = compactAnalysisContext(frozenContext);
assert.ok(Buffer.byteLength(JSON.stringify(compactContext)) < 5_000, 'blocked Asian context response must stay phone-safe');
assert.equal(compactContext.game.gamePk, game.gamePk);
const compact = compactRepriceSnapshot({ frozenContext, inputHash: 'x'.repeat(64) });
assert.equal(compact.distributionSnapshot, undefined);

assert.equal(initialAnalysisConcurrency('MLB'), 2);
assert.equal(initialAnalysisConcurrency('NPB'), 1);
assert.equal(initialAnalysisConcurrency('KBO'), 1);
assert.equal(initialAnalysisConcurrency('CPBL'), 1);

const pageSource = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');
const analyzeRouteSource = fs.readFileSync(new URL('../app/api/analyze/route.js', import.meta.url), 'utf8');
const workflowSource = fs.readFileSync(new URL('../workflows/analyze-board.js', import.meta.url), 'utf8');
assert.match(pageSource, /ANALYSIS_REQUEST_TIMEOUT_MS = 120_000/);
assert.match(pageSource, /requestJSON\('\/api\/analysis-jobs'/);
assert.match(pageSource, /伺服器背景分析中｜可離開App/);
assert.match(pageSource, /pollBackgroundJob\(job\.runId, generation, targetDate\)/);
assert.match(workflowSource, /'use workflow'/);
assert.match(workflowSource, /'use step'/);
assert.match(workflowSource, /analyzeGameStep\.maxRetries = 2/);
assert.match(pageSource, /'Idempotency-Key': requestId/);
assert.match(analyzeRouteSource, /requestResultCache\.get\(requestKey\)/);
assert.match(analyzeRouteSource, /requestCacheSet\(requestKey, requestBodyHash, safePayload\)/);

console.log('Mobile transport stays compact and incomplete Asian PIT inputs fail closed PASS');
