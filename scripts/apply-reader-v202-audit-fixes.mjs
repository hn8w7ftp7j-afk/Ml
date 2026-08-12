import fs from 'node:fs';

const files = [
  '.env.example',
  'README.md',
  'reader/README.md',
  'lib/tai888-source.js',
  'scripts/tai888-source-test.mjs',
  'app/api/credit-lines/route.js',
];

for (const file of files) {
  if (!fs.existsSync(file)) continue;
  const source = fs.readFileSync(file, 'utf8');
  const next = source
    .replaceAll('https://xg1.tai888.in', 'https://www1.tai888.in')
    .replaceAll('xg1.tai888.in', 'www1.tai888.in')
    .replaceAll('Tai888 Reader v2.0.0', 'Tai888 Reader v2.0.2')
    .replaceAll('Tai888 Reader v2.0.1', 'Tai888 Reader v2.0.2');
  if (next !== source) fs.writeFileSync(file, next);
}

const packageFile = 'package.json';
const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
const requiredTests = [
  'node scripts/tai888-reader-split-row-v2-test.mjs',
  'node scripts/tai888-reader-content-integration-v2-test.mjs',
];
const existing = String(pkg.scripts?.test || '').split(' && ').filter(Boolean);
pkg.scripts = pkg.scripts || {};
pkg.scripts.test = [...new Set([...existing, ...requiredTests])].join(' && ');
fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);

fs.writeFileSync('docs/READER_V2_0_2_AUDIT.md', `# Tai888 Reader 2.0.2 audit\n\n- Canonical top-level board: https://www1.tai888.in/newapp/#/BS\n- Split away/home rows are merged by visible column geometry.\n- One-cell colspan league rows are retained, so later special sections can be explicitly disabled.\n- Standard MLB four-market section is accepted; team-total/special sections are excluded.\n- Content-script integration fixture runs the actual normalizer and capture script against a DOM table.\n- Pairing success is separate from first-sync success, preventing repeated password entry after a parser error.\n- Reader scans all Tai888 child frames but does not request cookie, webRequest, debugger, native messaging, or bet-action permissions.\n`);

fs.rmSync('scripts/apply-reader-v202-audit-fixes.mjs', { force: true });
fs.rmSync('.github/workflows/apply-reader-v202-audit-fixes.yml', { force: true });
console.log('Reader 2.0.2 audit normalization applied.');
