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

patch('lib/mlb.js', [
  ['starter warning',
`  if (!awayStarter.available || !homeStarter.available) warnings.push('先發投手資料未完整；只有雙方核心球隊資料仍可信時才繼續建模');`,
`  if (!awayStarter.available || !homeStarter.available) warnings.push('先發投手尚未完整確認，已使用中性先發分布、候選局數範圍與較大不確定性建模');`],
  ['core modelability',
`  const coreTeamData = away.seasonHitting.available && home.seasonHitting.available && away.seasonPitching.available && home.seasonPitching.available;
  const coreStarterData = awayStarter.available && homeStarter.available;
  const coreModelable = Boolean(game?.awayTeamId && game?.homeTeamId && coreTeamData && coreStarterData);`,
`  const coreTeamData = away.seasonHitting.available && home.seasonHitting.available && away.seasonPitching.available && home.seasonPitching.available;
  const coreStarterData = awayStarter.available && homeStarter.available;
  // Unknown starters are not an automatic blocker. The scoring model has a
  // neutral starter distribution with wider uncertainty and expected-innings
  // ranges; only missing core team baselines block a credible early analysis.
  const coreModelable = Boolean(game?.awayTeamId && game?.homeTeamId && coreTeamData);
  const starterModelingMode = coreStarterData ? 'CONFIRMED_OR_ESTIMATED_STARTERS' : 'NEUTRAL_STARTER_UNCERTAINTY';`],
  ['return starter modeling mode',
`    featureProvenance,
    coreModelable,
    fetchedAt: new Date().toISOString(),`,
`    featureProvenance,
    coreModelable,
    coreTeamData,
    coreStarterData,
    starterModelingMode,
    fetchedAt: new Date().toISOString(),`],
]);

patch('package.json', [
  ['package version', '"version": "9.3.1"', '"version": "9.3.2"'],
  ['snapshot regression test',
`node scripts/single-side-water-test.mjs && node scripts/deterministic-v9-test.mjs`,
`node scripts/single-side-water-test.mjs && node scripts/snapshot-isolation-test.mjs && node scripts/deterministic-v9-test.mjs`],
]);

patch('app/api/health/route.js', [
  ['analysis cache import',
`import { TAI888_SOURCE_VERSION, tai888SourceStatus } from '../../../lib/tai888-source.js';`,
`import { TAI888_SOURCE_VERSION, tai888SourceStatus } from '../../../lib/tai888-source.js';
import { ANALYSIS_CACHE_VERSION } from '../../../lib/analysis-cache-v9.js';`],
  ['health version', "version: '9.3.1'", "version: '9.3.2'"],
  ['health cache version',
`    repriceVersion: REPRICE_VERSION,
    referenceLinesVersion: REFERENCE_LINES_VERSION,`,
`    repriceVersion: REPRICE_VERSION,
    analysisCacheVersion: ANALYSIS_CACHE_VERSION,
    referenceLinesVersion: REFERENCE_LINES_VERSION,`],
]);

patch('app/page.js', [
  ['page version', "const VERSION = '9.3.1';", "const VERSION = '9.3.2';"],
  ['storage namespace',
`const STORAGE = 'mlb-positive-ev-v9-3';
const LEGACY_KEYS = ['mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];`,
`const STORAGE = 'mlb-positive-ev-v9-3-2';
const LEGACY_KEYS = ['mlb-positive-ev-v9-3', 'mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];`],
  ['blocked state',
`    } catch (cause) {
      updateBoard(game.gamePk, item => ({ ...item, status: 'failed', statusLabel: '分析失敗', error: String(cause?.message || cause) }));
    } finally {`,
`    } catch (cause) {
      const message = String(cause?.message || cause);
      const blocked = /資料不足｜不評分|比賽已開打或結束/.test(message);
      updateBoard(game.gamePk, item => ({
        ...item,
        status: blocked ? 'blocked' : 'failed',
        statusLabel: blocked ? '資料不足｜不評分' : '分析失敗',
        error: message,
      }));
    } finally {`],
]);

fs.writeFileSync('DEPLOYMENT_VERSION', '9.3.2-input-hash-game-isolation-tbd-model\n');
console.log('v9.3.2 patch applied');
