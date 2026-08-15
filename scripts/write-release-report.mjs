import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const RELEASE = path.join(ROOT, 'release');
const ARCHIVE_NAME = 'Tai888-Reader-v2.0.10-PARTIAL-MARKET-FIX.zip';
const SHA_NAME = `${ARCHIVE_NAME}.sha256`;
const REPORT_NAME = 'Tai888-Reader-v2.0.10-VERIFICATION.md';
const requiredGates = ['tests', 'audit', 'build', 'e2e', 'package'];
const flags = new Map(process.argv.slice(2).map(argument => {
  const [name, ...rest] = argument.replace(/^--/, '').split('=');
  return [name, rest.join('=') || ''];
}));

for (const gate of requiredGates) {
  assert.equal(flags.get(gate), 'passed', `release report requires --${gate}=passed after that gate succeeds`);
}

const archive = path.join(RELEASE, ARCHIVE_NAME);
const shaFile = path.join(RELEASE, SHA_NAME);
assert.equal(fs.existsSync(archive), true, 'Reader archive is missing');
assert.equal(fs.existsSync(shaFile), true, 'Reader SHA-256 file is missing');
execFileSync('unzip', ['-tq', archive], { cwd: ROOT, stdio: 'pipe' });

const bytes = fs.readFileSync(archive);
const digest = createHash('sha256').update(bytes).digest('hex');
const declared = fs.readFileSync(shaFile, 'utf8').trim().split(/\s+/)[0];
assert.equal(declared, digest, 'SHA-256 sidecar does not match the archive');
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'reader/manifest.json'), 'utf8'));
const testCount = String(packageJson.scripts.test || '').split(' && ').filter(Boolean).length;
const archiveEntries = execFileSync('unzip', ['-Z1', archive], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim());
const sourceRef = process.env.GITHUB_SHA || `${commit}${dirty ? '+working-tree' : ''}`;
const generatedAt = new Date().toISOString();

const report = `# Tai888 Reader 2.0.10 / MLB EV 9.4.4 驗證報告

- 產生時間：${generatedAt}
- 原始碼基線：\`${sourceRef}\`
- 網站版本：\`${packageJson.version}\`
- Next.js：\`${packageJson.dependencies.next}\`
- Reader：\`${manifest.version_name}\`
- ZIP：\`${ARCHIVE_NAME}\`
- 檔案大小：\`${bytes.length} bytes\`
- SHA-256：\`${digest}\`
- ZIP 來源檔案：\`${archiveEntries.length}\`

## Release gates

| Gate | 結果 | 範圍 |
|---|---:|---|
| 專案測試 | PASS | ${testCount} 支 script，包含 Reader DOM/parser/frame/tab authority、server/auth/integrity、UI stale/hash/activity/date 與攻擊回歸 |
| Production build | PASS | Next.js ${packageJson.dependencies.next} 正式建置 |
| Production dependency audit | PASS | \`npm audit --omit=dev --audit-level=high\`，0 high/critical vulnerabilities |
| Reader full-flow | PASS | Production route handlers + deterministic official fixture：Pair → 完整 slate ingest → signed credit → FULL analyze → 同 hash heartbeat → signed PRICE_ONLY_REPRICE |
| Reader 封裝 | PASS | JS syntax、exact manifest allowlist、隱私靜態檢查、ZIP CRC、archive/source 一致性 |
| 可重現性 | PASS | 兩次獨立封裝 byte-identical |

## 整合與來源判定

- 未採納對話中宣稱的 \`79,725 bytes / 43d328d4…\` 套件：目前 Git 物件、遠端分支、workflow 與可取得檔案均無相符成品或驗證報告。
- 實際找到的同名舊 ZIP 為 \`20,898 bytes\`、SHA-256 \`68aab832c9b8254fda72fbdd6cf64c1bb1ccd5d20fb355cb95ea65e0055080c5\`，內容僅近似 Reader 2.0.2 的版本字串更新，未含本版 hardening；它未列入交付目錄。
- 本 ZIP 只取自目前 \`reader/\` 的固定 11 檔白名單；封裝器會把交付目錄內不同內容的舊 Tai888 ZIP 移至相鄰的 ignored quarantine 目錄。

## 主要安全邊界

- 單一權威 tab/frame；不再合併不同頁籤或 iframe 的盤面；同盤日完整分頁衝突或超過四個 Tai888 分頁時 fail-closed。
- 每個官方台北盤日必須全場次、逐場 4 市場／8 方向完整，含雙重賽唯一配對。
- URL 中繼資料只保留 Tai888 origin/path 與固定 \`#/BS\`；query、任意 hash、頁面標題與原始 frame URL 不保存也不上傳。
- Server 自算盤面雜湊；精確 \`boardDate + hash + pageActivityAt\` 版本只在全部分析成功後才被畫面承認，同 hash 心跳仍會重簽並快速重算。
- 盤口、快照與官方賽事身分均由 Server HMAC 綁定；偽造／竄改 fail-closed。
- 正式下注當下重驗 Reader 版本、水位時效、完整 QA 與官方預定開打時間。
- \`APP_PASSWORD\`、\`SESSION_SECRET\`、\`READER_PAIR_SECRET\` 各自獨立；不得回退使用 Tai888 帳密。

## 已知架構風險與部署狀態

Vercel Runtime Cache 是區域性、暫時性快取，沒有可用的原子 compare-and-swap。極端跨區並行仍可能舊盤覆蓋新盤。因此目前只能運行一台 Reader；徹底解法是改用支援條件寫入／交易的持久資料庫。

本報告只證明目前來源樹與本機／CI gates；不代表已 push、部署或啟用正式環境變數。部署後仍須另做 production smoke 與單 Reader 操作確認。
`;

fs.mkdirSync(RELEASE, { recursive: true });
fs.writeFileSync(path.join(RELEASE, REPORT_NAME), report, 'utf8');
process.stdout.write(`${JSON.stringify({
  ok: true,
  report: path.join(RELEASE, REPORT_NAME),
  bytes: bytes.length,
  sha256: digest,
  testCount,
  sourceRef,
})}\n`);
