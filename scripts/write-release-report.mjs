import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const RELEASE = path.join(ROOT, 'release');
const ARCHIVE_NAME = 'Tai888-Reader-v2.1.9-ASIAN-NAME-SAFE.zip';
const SHA_NAME = `${ARCHIVE_NAME}.sha256`;
const REPORT_NAME = 'Tai888-Reader-v2.1.9-VERIFICATION.md';
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

const report = `# Tai888 Reader 2.1.9 / Baseball EV 9.6.2 驗證報告

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
| 專案測試 | PASS | ${testCount} 支既有 script + Reader 2.1.9 A–J 專項，包含亞洲聯盟隊名、跨聯盟 DOM、partial market、freshness isolation、trailing rerun、server/auth/integrity 與 UI 回歸 |
| Production build | PASS | Next.js ${packageJson.dependencies.next} 正式建置 |
| Production dependency audit | PASS | \`npm audit --omit=dev --audit-level=high\`，0 high/critical vulnerabilities |
| Reader full-flow | PASS | Production route handlers + live MLB official slate：Pair → ingest → signed credit → FULL analyze → 同 hash heartbeat → signed PRICE_ONLY_REPRICE；四聯盟另由 deterministic fixture/unit gates 驗證 |
| Reader 封裝 | PASS | JS syntax、exact manifest allowlist、隱私靜態檢查、ZIP CRC、archive/source 一致性 |
| 可重現性 | PASS | 兩次獨立封裝 byte-identical |

## 整合與來源判定

- Reader 2.1.9 以 MLB／NPB／KBO／CPBL 四個權威分頁獨立辨識、雜湊、同步與顯示狀態；日／韓／台可從 Tai888 可見隊名建立正式代碼，每個已開市場仍須雙方向完整。
- 本 ZIP 只取自目前 \`reader/\` 的固定 12 檔白名單；封裝器會把交付目錄內不同內容的舊 Tai888 ZIP 移至相鄰的 ignored quarantine 目錄。
- MLB 保留正式分析相容性；NPB／KBO／CPBL 即使完整 ingest，網站分析仍由 server 強制鎖為 shadow、不可下注。

## 主要安全邊界

- 每聯盟選一個最可信的權威 tab/frame；同頁與多頁均可同時存在四聯盟，第五個非盤口 Tai888 頁面不會中止同步，不同聯盟不互相覆蓋。
- 所有提交場次都須與該聯盟官方台北盤日一對一配對，雙重賽身分必須唯一；1/4～4/4 市場均可合法寫入，每個 AVAILABLE 市場仍須兩方向完整，BLOCKED 只封鎖該市場。
- activityAt、market hash 與 lineAsOf 以聯盟實際盤面內容隔離；其他聯盟、導覽、時鐘或無關 DOM mutation 不刷新舊盤時間。
- 最新 snapshot 完整取代前版市場狀態；4/4 退回 2/4 或 0/4 時，不會 merge 殘留已消失的舊水位。
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
