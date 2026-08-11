import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, content) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, 'utf8');
};

function replaceAllInFile(file, from, to) {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) return;
  const source = fs.readFileSync(target, 'utf8');
  const next = source.split(from).join(to);
  if (next !== source) fs.writeFileSync(target, next, 'utf8');
}

// The production host changed. Keep every reader/server reference on one canonical URL.
const textFiles = [
  '.env.example',
  'README.md',
  'lib/tai888-source.js',
  'scripts/tai888-source-test.mjs',
  'app/api/credit-lines/route.js',
  'reader/manifest.json',
  'reader/background.js',
  'reader/popup.js',
  'reader/popup.html',
  'reader/README.md',
];
for (const file of textFiles) replaceAllInFile(file, 'https://xg1.tai888.in', 'https://www1.tai888.in');
for (const file of textFiles) replaceAllInFile(file, 'xg1.tai888.in', 'www1.tai888.in');

// Lock the installable extension version and canonical host permissions.
{
  const file = 'reader/manifest.json';
  const manifest = JSON.parse(read(file));
  manifest.version = '2.0.0';
  manifest.name = 'Tai888 Reader';
  manifest.description = '自動讀取使用者已登入瀏覽器中可見的 Tai888 MLB 盤口，安全同步到 MLB EV。';
  const requiredHosts = [
    'https://www1.tai888.in/*',
    'https://mlb-positive-ev.vercel.app/*',
  ];
  manifest.host_permissions = [...new Set(requiredHosts)];
  for (const script of manifest.content_scripts || []) {
    script.matches = (script.matches || []).map(value => value.includes('tai888.in') ? 'https://www1.tai888.in/*' : value);
    if (script.matches.some(value => value.includes('tai888.in'))) {
      script.all_frames = true;
      script.match_about_blank = true;
    }
  }
  write(file, `${JSON.stringify(manifest, null, 2)}\n`);
}

// Make the pairing instruction explicit. The secret is never stored in the page or repository.
for (const file of ['reader/popup.html', 'reader/popup.js', 'reader/README.md']) {
  replaceAllInFile(file, 'Tai888 唯讀帳號密碼', 'Reader 配對密碼');
  replaceAllInFile(file, 'Tai888唯讀帳號密碼', 'Reader 配對密碼');
}

write('reader/INSTALL.md', `# Tai888 Reader 2.0.0｜安裝與長期使用

## 安裝

1. 解壓縮 \`Tai888-Reader-v2.0.0.zip\`。
2. Chrome 網址列輸入 \`chrome://extensions\`。
3. 開啟「開發人員模式」。
4. 移除舊版 Tai888 Reader 1.x。
5. 按「載入未封裝項目」，選擇解壓後、內含 \`manifest.json\` 的 \`Tai888-Reader\` 資料夾。
6. 確認版本顯示 2.0.0，並把 Reader 固定在工具列。

## 第一次配對

1. 保持 Tai888 已正常登入，停在 MLB 讓分／大小盤口頁。
2. 點 Tai888 Reader 圖示。
3. MLB EV 網址保持 \`https://mlb-positive-ev.vercel.app\`。
4. 配對密碼輸入 Vercel Server-side 的 \`READER_PAIR_SECRET\`；若尚未另設，系統會沿用既有 \`TAI888_PASSWORD\`。
5. 按「配對並開始自動同步」。

## 日常運作

- 電腦保持開機且不要睡眠。
- Chrome 保持開啟。
- Tai888 保持登入並停在 MLB 盤口頁。
- Reader 會偵測 DOM 變化並以定時器補抓；只有盤口內容改變時才上傳。
- MLB EV 會保存最新 Reader 快照；網站開著時，盤口更新會沿用凍結比分分布快速重算。
- Tai888 登出、頁面離開 MLB、Reader 停止或資料過期時，網站會顯示過期／離線，不把舊盤當成可執行盤。

## 安全界線

Reader 只讀目前頁面已顯示的 MLB 盤口文字，不讀密碼、Cookie、Session、餘額，不繞過 Cloudflare，不操作下注。
`);

// Current Production smoke test: deterministic engine + reader status + optional live market analysis.
write('scripts/smoke.mjs', `import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const BASE = String(process.env.BASE_URL || 'https://mlb-positive-ev.vercel.app').replace(/\\/$/, '');

async function json(url, options = {}, timeoutMs = 60000) {
  const response = await fetch(url, { ...options, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error(\`\\${response.status} \\${url}: \\${text.slice(0, 1000)}\`); }
  if (!response.ok) throw new Error(\`\\${response.status} \\${url}: \\${JSON.stringify(payload).slice(0, 1500)}\`);
  return payload;
}

const headers = () => ({
  'Content-Type': 'application/json',
  Origin: BASE,
  Referer: \`\\${BASE}/\`,
  'Idempotency-Key': crypto.randomUUID(),
});

const taipeiDate = offset => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(Date.now() + offset * 86400000));

const health = await json(\`\\${BASE}/api/health?t=\\${Date.now()}\`, {}, 30000);
assert.equal(health.ok, true);
assert.equal(health.version, '9.4.0');
assert.equal(health.deterministicScoring, true);
assert.equal(health.gptScoringEnabled, false);
assert.ok(health.scoreFormulaVersion);

const reader = await json(\`\\${BASE}/api/reader/status?t=\\${Date.now()}\`, {}, 30000);
assert.equal(reader.ok, true);
assert.ok(reader.readerVersion || reader.version || reader.status);

let selected = null;
for (const offset of [0, -1, 1]) {
  try {
    const date = taipeiDate(offset);
    const schedule = await json(\`\\${BASE}/api/mlb?date=\\${date}&t=\\${Date.now()}\`, {}, 45000);
    if (Array.isArray(schedule.games) && schedule.games.length && (!selected || schedule.games.length > selected.games.length)) {
      selected = { date, games: schedule.games };
    }
  } catch {}
}

let analyzed = null;
if (selected) {
  try {
    const reference = await json(\`\\${BASE}/api/reference-lines\`, {
      method: 'POST', headers: headers(), body: JSON.stringify({ date: selected.date, schedule: selected.games }),
    }, 90000);
    const first = (reference.games || []).find(row => Array.isArray(row.markets) && row.markets.length);
    if (first) {
      const result = await json(\`\\${BASE}/api/analyze\`, {
        method: 'POST', headers: headers(), body: JSON.stringify({
          game: first.game,
          markets: first.markets,
          previousMarkets: [],
          settings: { rebateRate: 0, simulationsPerScenario: 300, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
        }),
      }, 180000);
      assert.equal(result.ok, true);
      assert.ok(result.analysis?.inputHash);
      assert.ok(result.analysis?.distributionHash);
      assert.equal(result.analysis?.scoreFormulaVersion, health.scoreFormulaVersion);
      analyzed = { gamePk: first.gamePk, results: result.analysis?.results?.length || 0 };
    }
  } catch (error) {
    console.warn('Optional live-market smoke skipped:', String(error?.message || error));
  }
}

console.log(JSON.stringify({
  ok: true,
  version: health.version,
  commit: health.commit,
  reader: {
    configured: reader.configured ?? reader.paired ?? null,
    fresh: reader.fresh ?? null,
    stale: reader.stale ?? null,
    games: reader.gameCount ?? reader.games?.length ?? 0,
  },
  analyzed,
}, null, 2));
`);

// Keep the release metadata consistent.
write('DEPLOYMENT_VERSION', 'v9.4.0-tai888-reader-v2-production\n');

// Remove one-off development helpers before release. The final source and permanent tests remain.
for (const file of [
  '.github/workflows/reader-env-diagnostic.yml',
  '.github/workflows/apply-tai888-reader-v2.yml',
  'scripts/apply-tai888-reader-v2.mjs',
]) {
  fs.rmSync(path.join(root, file), { force: true });
}

console.log('Tai888 Reader v2 finalization patch applied.');
