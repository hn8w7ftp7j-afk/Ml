import fs from 'node:fs';

function replaceOnce(path, before, after, label) {
  let source = fs.readFileSync(path, 'utf8');
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${path} ${label}: expected once, found ${count}`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

replaceOnce(
  'lib/deterministic-finalizer.js',
`  const complementError = Number.isFinite(Number(left.modelProbability)) && Number.isFinite(Number(right.modelProbability))
    ? Math.abs(Number(left.modelProbability) + Number(right.modelProbability) - 1)
    : null;`,
`  const leftProbability = left.modelProbability;
  const rightProbability = right.modelProbability;
  const complementError = leftProbability != null && rightProbability != null
    && Number.isFinite(Number(leftProbability)) && Number.isFinite(Number(rightProbability))
    ? Math.abs(Number(leftProbability) + Number(rightProbability) - 1)
    : null;`,
  'ignore missing-side probability in complement QA',
);

replaceOnce(
  'package.json',
  '"version": "9.3.0"',
  '"version": "9.3.1"',
  'package version',
);
replaceOnce(
  'package.json',
  'node scripts/tai888-source-test.mjs && node scripts/deterministic-v9-test.mjs',
  'node scripts/tai888-source-test.mjs && node scripts/single-side-water-test.mjs && node scripts/deterministic-v9-test.mjs',
  'test command',
);
replaceOnce(
  'app/api/health/route.js',
  "version: '9.3.0'",
  "version: '9.3.1'",
  'health version',
);
replaceOnce(
  'app/page.js',
  "const VERSION = '9.3.0';",
  "const VERSION = '9.3.1';",
  'page version',
);
fs.writeFileSync('DEPLOYMENT_VERSION', '9.3.1-single-side-water-pair-qa-fix\n');
console.log('v9.3.1 patch applied');
