import assert from 'node:assert/strict';
import fs from 'node:fs';

const page = fs.readFileSync(new URL('../app/page.js', import.meta.url), 'utf8');

assert.doesNotMatch(
  page,
  /Promise\.resolve\(oneClickAnalyze\(key\)\)|void oneClickAnalyze\(key\)/,
  'opening the app or restoring cached scores must not automatically start MLB analysis',
);
assert.match(
  page,
  /onClick=\{\(\) => oneClickAnalyze\(\)\}/,
  'single-league analysis must remain a manual button action',
);
assert.match(
  page,
  /onClick=\{\(\) => oneClickAnalyzeAll\(\)\}/,
  'all-league analysis must remain a manual button action',
);
assert.match(
  page,
  /manualAnalysisScopesRef\.current\.add\(`\$\{league\}:\$\{date\}`\)/,
  'manual single-league analysis must enable Reader follow-up for that league and date',
);
assert.match(
  page,
  /for \(const id of LEAGUE_IDS\) manualAnalysisScopesRef\.current\.add\(`\$\{id\}:\$\{targetDate\}`\)/,
  'manual all-league analysis must enable Reader follow-up for all four leagues',
);

console.log('Initial entry is manual-only while both analysis buttons remain available PASS');
