import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const route = read('../app/api/analyze/route.js');
const reprice = read('../app/api/reprice/route.js');
const health = read('../app/api/health/route.js');
const provider = read('../lib/league-provider.js');
const analysis = read('../lib/analysis-v11.js');
const context = read('../lib/mlb-context-v13.js');
const score = read('../lib/joint-score-v13.js');

assert.match(route, /from ['"]\.\.\/\.\.\/\.\.\/lib\/analysis-v11\.js['"]/);
assert.match(reprice, /from ['"]\.\.\/\.\.\/\.\.\/lib\/analysis-v11\.js['"]/);
assert.match(health, /from ['"]\.\.\/\.\.\/\.\.\/lib\/analysis-v11\.js['"]/);
assert.match(provider, /buildGameContextV13/);
assert.match(provider, /from ['"]\.\/mlb-context-v13\.js['"]/);
assert.match(analysis, /buildJointScoreSnapshotV13/);
assert.match(analysis, /from ['"]\.\/joint-score-v13\.js['"]/);
assert.doesNotMatch(analysis, /buildJointScoreSnapshotV12/);
assert.match(analysis, /jointPortfolioDistribution: false/);
assert.match(analysis, /stateAwareBottomNinth/);

for (const required of ['starterExpectedInnings', 'starterHandedness', 'officialOrProjectedLineup', 'teamPlatoonSplits', 'reliefOnlyBullpen']) {
  assert.match(context, new RegExp(`${required}: true`), `context feature contract missing ${required}`);
}
for (const required of ['applyBottomNinthStateV13', 'extraInningsKernelV13', 'linkedPathMomentsForScenarioV13', 'stateAwareBottomNinth: true']) {
  assert.match(score, new RegExp(required.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `score path missing ${required}`);
}
assert.match(score, /targetMarketCalibrationApplied: false/);

console.log(JSON.stringify({ ok: true, productionRoute: 'analysis-v11 -> joint-score-v13', contextRoute: 'league-provider -> mlb-context-v13' }, null, 2));
