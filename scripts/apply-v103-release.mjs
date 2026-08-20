import fs from 'node:fs';

function read(path) { return fs.readFileSync(path, 'utf8'); }
function write(path, value) { fs.writeFileSync(path, value); }
function replaceExact(source, before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label}: expected exactly one match, found ${count}`);
  return source.replace(before, after);
}
function replaceCount(source, before, after, expected, label) {
  const count = source.split(before).length - 1;
  if (count !== expected) throw new Error(`${label}: expected ${expected} matches, found ${count}`);
  return source.split(before).join(after);
}

// 7) Release identity and regression coverage.
{
  const path = 'package.json';
  let source = read(path);
  source = replaceExact(source, '"version": "10.2.3",', '"version": "10.3.0",', 'package version');
  source = replaceExact(source, 'node scripts/analysis-v11-test.mjs && node scripts/score-model-integrity-v102-test.mjs', 'node scripts/analysis-v11-test.mjs && node scripts/ev-calibration-v103-test.mjs && node scripts/score-model-integrity-v102-test.mjs', 'new regression test');
  write(path, source);
}
{
  const path = 'package-lock.json';
  let source = read(path);
  source = replaceCount(source, '"version": "10.2.3",', '"version": "10.3.0",', 2, 'package lock versions');
  write(path, source);
}
{
  const path = 'app/api/health/route.js';
  let source = read(path);
  source = replaceExact(source, "version: '10.2.3',", "version: '10.3.0',", 'health version');
  write(path, source);
}
{
  const path = 'scripts/page-reader-automation-v941-test.mjs';
  let source = read(path);
  source = replaceExact(source, "mustMatch(/const VERSION = '10\\.2\\.3'/, 'UI must expose the v10.2.3 release');", "mustMatch(/const VERSION = '10\\.3\\.0'/, 'UI must expose the v10.3.0 release');", 'page test release');
  source = replaceExact(source, "mustMatch(/加權EV \\{pct\\(row\\.weightedEV\\)\\}/, 'weighted EV label must be clear');", "mustMatch(/加權EV \\${pct\\(row\\.weightedEV\\)\\}/, 'weighted EV label must be clear');", 'weighted label template test');
  source = replaceExact(source, "mustMatch(/穩健EV \\{pct\\(row\\.robustEV\\)\\}/, 'robust EV label must be clear');", "mustMatch(/穩健EV \\${pct\\(row\\.robustEV\\)\\}/, 'robust EV label must be clear');", 'robust label template test');
  const anchor = "assert.doesNotMatch(page, /Raw W EV|保守 R EV/, 'website must use the agreed weighted/robust EV labels');\n";
  source = replaceExact(source, anchor, `${anchor}mustMatch(/EV校準未通過，不建立加權EV／穩健EV/, 'unqualified extreme EV must not be presented as valid W/R');\nmustMatch(/聯盟模型重建中｜EV與S分數暫停顯示/, 'unvalidated Asian leagues must hide misleading EV/S values');\n`,'page calibration regression');
  write(path, source);
}

write('DEPLOYMENT_VERSION', 'v10.3.0 EV-CALIBRATION-SAFETY\n');

console.log('v10.3.0 EV calibration safety patch applied');
