import fs from 'node:fs';

function replace(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`${path}: anchor missing`);
  fs.writeFileSync(path, source.replace(before, after));
}

replace('lib/analysis-v11.js',
  "import { buildJointScoreSnapshotV11, scoreDistributionForScenario, JOINT_SCORE_V11_VERSION } from './joint-score-v11.js';",
  "import { buildJointScoreSnapshotV12, scoreDistributionForScenario, JOINT_SCORE_V12_VERSION } from './joint-score-v12.js';");
replace('lib/analysis-v11.js',
  "export const DEFAULT_MODEL_CONFIG = Object.freeze({ engine: JOINT_SCORE_V11_VERSION, exactDistribution: true, targetMarketCalibration: false });",
  "export const DEFAULT_MODEL_CONFIG = Object.freeze({ engine: JOINT_SCORE_V12_VERSION, exactDistribution: true, extraInnings: true, targetMarketCalibration: false });");
replace('lib/analysis-v11.js',
  "return buildJointScoreSnapshotV11({ context, modelVersion: contract.modelVersion, rulesVersion: contract.rulesVersion });",
  "return buildJointScoreSnapshotV12({ context, modelVersion: contract.modelVersion, rulesVersion: contract.rulesVersion });");

replace('lib/mlb-context-v11.js',
`  const roster = Array.isArray(response.data?.roster) ? response.data.roster : [];
  response.data = { roster: roster.filter(row => /injur|il|disabled/i.test(clean(row?.status?.description || row?.rosterStatus))) };
  return response;`,
`  const roster = Array.isArray(response.data?.roster) ? response.data.roster : [];
  const hasStatusMetadata = roster.some(row => clean(row?.status?.description || row?.status?.code || row?.rosterStatus));
  if (!hasStatusMetadata) return { ...response, ok: false, data: null, error: '官方roster未提供可驗證傷停狀態欄位' };
  response.data = { roster: roster.filter(row => /injur|il|disabled/i.test(clean(row?.status?.description || row?.status?.code || row?.rosterStatus))) };
  return response;`);

replace('scripts/analysis-v10-test.mjs',
  "assert.equal(SCORE_RELEASE_STATUS, 'SHADOW_VALIDATED_NOT_FORMAL');",
  "assert.equal(SCORE_RELEASE_STATUS, 'SHADOW_EXACT_MODEL_NOT_FORMAL');");

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '10.1.1';
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
replace('app/api/health/route.js', "version: '10.1.0'", "version: '10.1.1'");
fs.writeFileSync('DEPLOYMENT_VERSION', 'v10.1.1 FULL-STANDALONE-EXACT-JOINT-MODEL-EXTRAS\n');
console.log('V10.1.1 completion patch applied');
