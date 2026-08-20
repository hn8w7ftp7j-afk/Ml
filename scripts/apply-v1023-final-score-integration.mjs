import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, value) {
  fs.writeFileSync(path, value);
}

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

// 1) User-facing score language: one fixed S-score policy, with Shadow only
// controlling recommendation/Unit release. Keep internal compatibility fields.
{
  const path = 'app/page.js';
  let source = read(path);
  source = replaceExact(source, "const VERSION = '10.2.2';", "const VERSION = '10.2.3';", 'app version');
  source = replaceCount(source, '固定雙EV公式診斷分', '固定雙EV公式 S 分數', 3, 'score tooltip wording');
  source = replaceExact(source, '｜Raw W EV {pct(row.weightedEV)}｜保守 R EV {pct(row.robustEV)}', '｜加權EV {pct(row.weightedEV)}｜穩健EV {pct(row.robustEV)}', 'EV labels');
  source = replaceExact(source, 'Raw W EV未大於0', '加權EV未大於0', 'weighted EV verdict reason');
  source = replaceExact(source, '保守 R EV未大於0', '穩健EV未大於0', 'robust EV verdict reason');
  source = replaceExact(source, '<small>W EV {pct(entry.weightedEV)}｜R EV {pct(entry.robustEV)}｜資料QA PASS｜影子候選、非正式推薦</small>', '<small>加權EV {pct(entry.weightedEV)}｜穩健EV {pct(entry.robustEV)}｜資料QA PASS｜影子候選、非正式推薦</small>', 'ranking EV labels');
  source = replaceExact(source, '公式診斷分啟用', '固定 S 分數啟用', 'provider status wording');
  source = replaceCount(source, 'V10影子分數', 'V10影子 S 分數', 2, 'header and hero shadow wording');
  source = replaceExact(source, '影子分數可見', '影子 S 分數可見', 'settings wording');
  write(path, source);
}

// 2) Server result tags use the same visible language. Internal field names are
// retained to avoid breaking stored snapshots and API clients.
{
  const path = 'lib/deterministic-finalizer-v10.js';
  let source = read(path);
  source = replaceExact(source, "if (score == null) return '⛔ 無法建立公式診斷分｜不下注';", "if (score == null) return '⛔ 無法建立固定 S 分數｜不下注';", 'missing score tag');
  source = replaceExact(source, '｜聯盟模型未驗證診斷分｜不列排名｜不可下注', '｜聯盟模型未驗證｜固定 S 分數僅供檢查｜不列排名｜不可下注', 'league validation tag');
  source = replaceExact(source, '｜QA BLOCK診斷分｜不列排名｜不可下注', '｜QA BLOCK｜固定 S 分數僅供檢查｜不列排名｜不可下注', 'QA block tag');
  write(path, source);
}

// 3) Release identity stays consistent across UI, API and package metadata.
{
  const path = 'package.json';
  let source = read(path);
  source = replaceExact(source, '"version": "10.2.2",', '"version": "10.2.3",', 'package version');
  write(path, source);
}

{
  const path = 'package-lock.json';
  let source = read(path);
  source = replaceCount(source, '"version": "10.2.2",', '"version": "10.2.3",', 2, 'package lock versions');
  write(path, source);
}

{
  const path = 'app/api/health/route.js';
  let source = read(path);
  source = replaceExact(source, "version: '10.2.2',", "version: '10.2.3',", 'health version');
  write(path, source);
}

write('DEPLOYMENT_VERSION', 'v10.2.3 FIXED-S-SCORE-SHADOW-INTEGRATED\n');

// 4) Regression test: the website may keep internal diagnostic field names,
// but must not present a second user-facing "diagnostic score" language.
{
  const path = 'scripts/page-reader-automation-v941-test.mjs';
  let source = read(path);
  source = replaceExact(source, "mustMatch(/const VERSION = '10\\.2\\.2'/, 'UI must expose the v10.2.2 release');", "mustMatch(/const VERSION = '10\\.2\\.3'/, 'UI must expose the v10.2.3 release');", 'page release assertion');
  source = replaceExact(source, "mustMatch(/formulaScore\\.toFixed\\(1\\)/, 'diagnostic score must always render as a number');", "mustMatch(/formulaScore\\.toFixed\\(1\\)/, 'fixed S score must always render as a number');", 'score render assertion text');
  source = replaceExact(source, "assert.doesNotMatch(page, /Number\\(row\\?\\.weightedEV\\) <= 0 \\? 'PASS'/, 'negative EV must display its numeric diagnostic score');", "assert.doesNotMatch(page, /Number\\(row\\?\\.weightedEV\\) <= 0 \\? 'PASS'/, 'negative EV must still display the fixed numeric S score');", 'negative EV assertion text');
  const anchor = "mustMatch(/資料QA：PASS/, 'data QA must be presented separately from ranking qualification');\n";
  const addition = `${anchor}mustMatch(/固定雙EV公式 S 分數/, 'user-facing score label must use the single fixed S-score language');\nmustMatch(/加權EV \\{pct\\(row\\.weightedEV\\)\\}/, 'weighted EV label must be clear');\nmustMatch(/穩健EV \\{pct\\(row\\.robustEV\\)\\}/, 'robust EV label must be clear');\nmustMatch(/固定 S 分數啟用/, 'provider status must report fixed S-score mode');\nassert.doesNotMatch(page, /公式診斷分/, 'website must not expose a second diagnostic-score language');\nassert.doesNotMatch(page, /Raw W EV|保守 R EV/, 'website must use the agreed weighted/robust EV labels');\n`;
  source = replaceExact(source, anchor, addition, 'UI terminology regression block');
  write(path, source);
}

console.log('v10.2.3 final fixed-S-score integration applied');
