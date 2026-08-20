import fs from 'node:fs';

function replace(path, before, after) {
  const source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before)) {
    if (source.includes(after)) return;
    throw new Error(`${path}: replacement anchor missing: ${before}`);
  }
  fs.writeFileSync(path, source.replaceAll(before, after));
}

replace('lib/league-provider.js', "import { buildGameContextV10 } from './mlb-data-v10.js';", "import { buildGameContextV11 } from './mlb-context-v11.js';");
replace('lib/league-provider.js', "} from './analysis-v10.js';", "} from './analysis-v11.js';");
replace('lib/league-provider.js', 'buildGameContextV10(game, options)', 'buildGameContextV11(game, options)');
replace('app/api/analyze/route.js', "../../../lib/analysis-v10.js", "../../../lib/analysis-v11.js");
replace('app/api/reprice/route.js', "../../../lib/analysis-v10.js", "../../../lib/analysis-v11.js");
replace('app/api/health/route.js', "../../../lib/analysis-v10.js", "../../../lib/analysis-v11.js");
replace('app/api/health/route.js', "version: '10.0.0'", "version: '10.1.0'");
replace('lib/deterministic-finalizer-v10.js', "BASEBALL-DETERMINISTIC-SHADOW-2026-08-v10.0.0", "BASEBALL-DETERMINISTIC-SHADOW-2026-08-v10.1.0");
replace('lib/deterministic-finalizer-v10.js', "BASEBALL-SCENARIO-Q10-NUMERICAL-LB-v1.0.0", "BASEBALL-GH27-Q10-DATA-MARGIN-EXACT-v1.0.0");
replace('lib/deterministic-finalizer-v10.js', "SHADOW_VALIDATED_NOT_FORMAL", "SHADOW_EXACT_MODEL_NOT_FORMAL");

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '10.1.0';
if (!pkg.scripts.test.includes('node scripts/analysis-v11-test.mjs')) {
  pkg.scripts.test = pkg.scripts.test.replace('node scripts/analysis-v10-test.mjs', 'node scripts/analysis-v10-test.mjs && node scripts/analysis-v11-test.mjs');
}
fs.writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`);

fs.writeFileSync('DEPLOYMENT_VERSION', 'v10.1.0 FULL-STANDALONE-EXACT-JOINT-MODEL\n');
console.log('V10.1 standalone exact joint model integrated');
