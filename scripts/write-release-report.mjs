import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readerArtifactNames, READER_PACKAGE_FILES } from '../lib/reader-artifact-names.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'reader/manifest.json'), 'utf8'));
const { archiveName: ARCHIVE_NAME, shaName: SHA_NAME, reportName: REPORT_NAME } = readerArtifactNames(manifest);
const requiredGates = ['tests', 'audit', 'build', 'e2e', 'package'];
const flags = new Map(process.argv.slice(2).map(argument => {
  const [name, ...rest] = argument.replace(/^--/, '').split('=');
  return [name, rest.join('=') || ''];
}));
for (const gate of requiredGates) {
  assert.equal(flags.get(gate), 'passed', `release report requires --${gate}=passed after that gate succeeds`);
}
const RELEASE = path.resolve(ROOT, flags.get('output-dir') || 'release');
const relative = path.relative(ROOT, RELEASE);
assert.ok(!relative.startsWith('..') && !path.isAbsolute(relative), 'release report must stay inside the project');
const archive = path.join(RELEASE, ARCHIVE_NAME);
const shaFile = path.join(RELEASE, SHA_NAME);
assert.equal(fs.existsSync(archive), true, 'Reader archive is missing');
assert.equal(fs.existsSync(shaFile), true, 'Reader SHA-256 file is missing');
execFileSync('unzip', ['-tq', archive], { cwd: ROOT, stdio: 'pipe' });
const bytes = fs.readFileSync(archive);
const digest = createHash('sha256').update(bytes).digest('hex');
const declared = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/);
assert.equal(declared[0], digest, 'SHA-256 sidecar does not match the archive');
assert.equal(declared[1], ARCHIVE_NAME, 'SHA-256 sidecar names another archive');
const archiveEntries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
assert.deepEqual(archiveEntries, READER_PACKAGE_FILES.map(file => `Tai888-Reader/${file}`), 'Reader archive file allow-list mismatch');
for (const file of READER_PACKAGE_FILES) {
  const archived = execFileSync('unzip', ['-p', archive, `Tai888-Reader/${file}`]);
  assert.deepEqual(archived, fs.readFileSync(path.join(ROOT, 'reader', file)), `archive/source mismatch: ${file}`);
}
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim());
const sourceRef = `${commit}${dirty ? '+working-tree' : ''}`;
const workflowUrl = process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
  ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
const report = `# Tai888 Reader ${manifest.version_name} / 網站 ${packageJson.version} 交付核對

- 產生時間：${new Date().toISOString()}
- 原始碼：\`${sourceRef}\`
- ZIP：\`${ARCHIVE_NAME}\`
- 檔案大小：${bytes.length} bytes
- SHA-256：\`${digest}\`
- 來源檔案：${archiveEntries.length}
${workflowUrl ? `- CI 執行紀錄：[查看工作流程](${workflowUrl})` : '- CI 執行紀錄：未提供'}

## 本腳本直接核對

| 項目 | 結果 | 證據 |
|---|---|---|
| ZIP 完整性 | PASS | unzip CRC 核對 |
| SHA-256 | PASS | ZIP 位元組與 sidecar 的雜湊、檔名一致 |
| 版本與來源檔案 | PASS | ZIP 白名單與目前 reader/ 逐檔位元組一致 |

## 呼叫者回報的前置檢查

| 檢查 | 狀態 |
|---|---|
${requiredGates.map(gate => `| ${gate} | REPORTED_PASS |`).join('\n')}

上述狀態來自呼叫參數。本腳本沒有重跑測試、建置、依賴稽核、E2E 或兩次封裝；實際執行範圍與結果須查看對應執行紀錄。E2E 參數不代表正式站操作成功，也不證明依賴完全沒有漏洞。

## 正式站驗證

Production 部署、API、Reader 真實盤面、UI 與實際帳本功能：NOT_VERIFIED。本腳本未連線查核正式站，不由旗標推定部署或功能已通過。
`;
fs.writeFileSync(path.join(RELEASE, REPORT_NAME), report, 'utf8');
process.stdout.write(`${JSON.stringify({ ok: true, report: path.join(RELEASE, REPORT_NAME), bytes: bytes.length, sha256: digest, sourceRef })}\n`);
