import fs from 'node:fs';
import path from 'node:path';

function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, value) { ensureDir(file); fs.writeFileSync(file, value); }
function replaceOnce(source, before, after, label) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) throw new Error(`Patch anchor not found: ${label}`);
  return source.replace(before, after);
}

// package.json
{
  const file = 'package.json';
  const pkg = JSON.parse(read(file));
  pkg.version = '9.4.0';
  pkg.dependencies = { ...(pkg.dependencies || {}), '@vercel/functions': '^3.7.6' };
  const extra = [
    'node scripts/tai888-reader-dom-v2-test.mjs',
    'node scripts/tai888-reader-parser-v2-test.mjs',
    'node scripts/reader-auth-v2-test.mjs',
    'node scripts/reader-store-v2-test.mjs',
  ];
  const current = String(pkg.scripts?.test || '');
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.test = [current, ...extra.filter(row => !current.includes(row))].filter(Boolean).join(' && ');
  write(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// Environment example
{
  const file = '.env.example';
  let source = read(file);
  source = source.replace('TAI888_BASE_URL=https://xg1.tai888.in', 'TAI888_BASE_URL=https://www1.tai888.in');
  if (!source.includes('READER_PAIR_SECRET=')) source += '\n# Optional: separate pairing password for Tai888 Reader. Falls back to TAI888_PASSWORD.\nREADER_PAIR_SECRET=\n';
  write(file, source);
}

// Middleware: Reader pairing/ingest/status must be reachable from the paired Chrome extension.
{
  const file = 'middleware.js';
  let source = read(file);
  source = replaceOnce(
    source,
    "const PUBLIC_PATHS = new Set(['/login', '/api/auth', '/api/health']);",
    "const PUBLIC_PATHS = new Set(['/login', '/api/auth', '/api/health', '/api/reader/pair', '/api/reader/ingest', '/api/reader/status']);",
    'middleware public reader routes',
  );
  write(file, source);
}

// Health endpoint
{
  const file = 'app/api/health/route.js';
  let source = read(file);
  source = replaceOnce(
    source,
    "import { ANALYSIS_CACHE_VERSION } from '../../../lib/analysis-cache-v9.js';",
    "import { ANALYSIS_CACHE_VERSION } from '../../../lib/analysis-cache-v9.js';\nimport { readerPairingConfigured } from '../../../lib/reader-auth-v2.js';\nimport { loadReaderSnapshot, readerSnapshotStatus, READER_STORE_VERSION } from '../../../lib/reader-store-v2.js';",
    'health reader imports',
  );
  source = replaceOnce(
    source,
    "export async function GET() {\n  const referenceLines = referenceProviderStatus();\n  const creditLines = tai888SourceStatus();",
    "export async function GET() {\n  const referenceLines = referenceProviderStatus();\n  const creditLines = tai888SourceStatus();\n  const readerSnapshot = await loadReaderSnapshot();\n  const readerStatus = readerSnapshotStatus(readerSnapshot);",
    'health reader state',
  );
  source = source.replace("version: '9.3.4'", "version: '9.4.0'");
  source = replaceOnce(
    source,
    "    creditLinesProvider: creditLines.configured ? creditLines.provider : null,\n    deterministicScoring: true,",
    "    creditLinesProvider: creditLines.configured ? creditLines.provider : null,\n    readerPairingConfigured: readerPairingConfigured(),\n    readerStoreVersion: READER_STORE_VERSION,\n    readerAvailable: readerStatus.available,\n    readerFresh: readerStatus.fresh,\n    readerAgeSeconds: readerStatus.ageSeconds,\n    readerMatchedGameCount: readerSnapshot?.matchedGameCount || 0,\n    readerPayloadHash: readerSnapshot?.payloadHash || null,\n    deterministicScoring: true,",
    'health reader fields',
  );
  write(file, source);
}

// Credit-line provider: prefer the fresh browser Reader snapshot, then retain the old server-side fallback.
{
  const file = 'app/api/credit-lines/route.js';
  let source = read(file);
  source = replaceOnce(
    source,
    "import {\n  TAI888_SOURCE_VERSION,\n  loadTai888VisibleText,\n  tai888SourceStatus,\n} from '../../../lib/tai888-source.js';",
    "import {\n  TAI888_SOURCE_VERSION,\n  loadTai888VisibleText,\n  tai888SourceStatus,\n} from '../../../lib/tai888-source.js';\nimport { loadReaderSnapshot, readerSnapshotStatus, READER_STORE_VERSION } from '../../../lib/reader-store-v2.js';\nimport { TAI888_READER_PARSER_VERSION } from '../../../lib/tai888-reader-parser-v2.js';",
    'credit reader imports',
  );
  source = replaceOnce(
    source,
    "export async function GET(request) {\n  const auth = await requireApiAuth(request);\n  if (auth) return auth;\n  return NextResponse.json({\n    ok: true,\n    version: TAI888_SOURCE_VERSION,\n    ...tai888SourceStatus(),\n  }, { headers: { 'Cache-Control': 'no-store' } });\n}",
    "export async function GET(request) {\n  const auth = await requireApiAuth(request);\n  if (auth) return auth;\n  const snapshot = await loadReaderSnapshot();\n  const reader = readerSnapshotStatus(snapshot);\n  return NextResponse.json({\n    ok: true,\n    version: TAI888_SOURCE_VERSION,\n    ...tai888SourceStatus(),\n    readerStoreVersion: READER_STORE_VERSION,\n    readerParserVersion: TAI888_READER_PARSER_VERSION,\n    readerAvailable: reader.available,\n    readerFresh: reader.fresh,\n    readerStale: reader.stale,\n    readerAgeSeconds: reader.ageSeconds,\n    readerMessage: reader.message,\n    payloadHash: snapshot?.payloadHash || null,\n    matchedGameCount: snapshot?.matchedGameCount || 0,\n    observedAt: snapshot?.observedAt || null,\n    receivedAt: snapshot?.receivedAt || null,\n  }, { headers: { 'Cache-Control': 'no-store' } });\n}",
    'credit GET reader status',
  );
  source = replaceOnce(
    source,
    "export async function POST(request) {\n  try {",
    "export async function POST(request) {\n  let readerSnapshot = null;\n  let readerState = readerSnapshotStatus(null);\n  try {",
    'credit POST reader state',
  );
  source = replaceOnce(
    source,
    "    if (!schedule.length) return NextResponse.json({ ok: false, error: '今日賽事清單為空，無法配對信用盤' }, { status: 400 });\n\n    const status = tai888SourceStatus();",
    "    if (!schedule.length) return NextResponse.json({ ok: false, error: '今日賽事清單為空，無法配對信用盤' }, { status: 400 });\n\n    readerSnapshot = await loadReaderSnapshot(date);\n    readerState = readerSnapshotStatus(readerSnapshot);\n    if (readerState.fresh && readerSnapshot?.games?.length) {\n      const scheduleByPk = new Map(schedule.map(game => [Number(game.gamePk), game]));\n      const games = readerSnapshot.games\n        .filter(row => scheduleByPk.has(Number(row.gamePk)) && Array.isArray(row.markets) && row.markets.length)\n        .map(row => ({ ...row, game: scheduleByPk.get(Number(row.gamePk)), source: { ...row.source, observedAt: readerSnapshot.observedAt, receivedAt: readerSnapshot.receivedAt } }));\n      if (games.length) {\n        return NextResponse.json({\n          ok: true, configured: true, blocked: false, readerFresh: true,\n          version: TAI888_READER_PARSER_VERSION, provider: 'TAI888_READER_AUTO',\n          label: 'Tai888 Reader 自動信用盤', games,\n          payloadHash: readerSnapshot.payloadHash, boardDate: readerSnapshot.boardDate,\n          observedAt: readerSnapshot.observedAt, receivedAt: readerSnapshot.receivedAt,\n          rawGameCount: readerSnapshot.rawGameCount, matchedGameCount: games.length,\n          scheduleGameCount: schedule.length, unmatched: readerSnapshot.unmatched || [],\n          readerStatus: readerState, fetchedAt: new Date().toISOString(), cache: 'READER_RUNTIME_CACHE',\n        }, { headers: { 'Cache-Control': 'no-store' } });\n      }\n    }\n\n    const status = tai888SourceStatus();",
    'credit prefer reader snapshot',
  );
  source = replaceOnce(
    source,
    "        importModes: ['clipboard_text', 'screenshot'],",
    "        importModes: ['reader_auto', 'clipboard_text', 'screenshot'],\n        readerFresh: readerState.fresh,\n        readerStale: readerState.stale,\n        readerAgeSeconds: readerState.ageSeconds,\n        readerMessage: readerState.message,\n        payloadHash: readerSnapshot?.payloadHash || null,",
    'credit cloudflare reader fallback fields',
  );
  write(file, source);
}

// Mobile website: auto-run when a fresh Reader board is present and poll/reprice without rebuilding distributions.
{
  const file = 'app/page.js';
  let source = read(file);
  source = source.replace("const VERSION = '9.3.4';", "const VERSION = '9.4.0';");
  source = source.replace("const STORAGE = 'mlb-positive-ev-v9-3-4';", "const STORAGE = 'mlb-positive-ev-v9-4-0';");
  source = source.replace("const LEGACY_KEYS = ['mlb-positive-ev-v9-3-3'", "const LEGACY_KEYS = ['mlb-positive-ev-v9-3-4', 'mlb-positive-ev-v9-3-3'");
  source = replaceOnce(
    source,
    "  const [creditProviderStatus, setCreditProviderStatus] = useState(null);\n  const [busy, setBusy] = useState(false);",
    "  const [creditProviderStatus, setCreditProviderStatus] = useState(null);\n  const [readerStatus, setReaderStatus] = useState(null);\n  const [busy, setBusy] = useState(false);",
    'page reader state',
  );
  source = replaceOnce(
    source,
    "  const [health, setHealth] = useState(null);\n  const snapshots = useRef(new Map());",
    "  const [health, setHealth] = useState(null);\n  const snapshots = useRef(new Map());\n  const creditHashRef = useRef('');\n  const readerPollBusyRef = useRef(false);\n  const autoAnalyzeRef = useRef(false);",
    'page reader refs',
  );
  source = replaceOnce(
    source,
    "    requestJSON('/api/credit-lines', {}, 20000).then(setCreditProviderStatus).catch(cause => setCreditProviderStatus({ configured: false, message: String(cause?.message || cause) }));\n  }, []);",
    "    requestJSON('/api/credit-lines', {}, 20000).then(setCreditProviderStatus).catch(cause => setCreditProviderStatus({ configured: false, message: String(cause?.message || cause) }));\n    requestJSON('/api/reader/status', {}, 20000).then(setReaderStatus).catch(cause => setReaderStatus({ fresh: false, message: String(cause?.message || cause) }));\n  }, []);\n  useEffect(() => {\n    if (!readerStatus?.fresh || board.length || busy || autoAnalyzeRef.current) return;\n    autoAnalyzeRef.current = true;\n    const timer = window.setTimeout(() => oneClickAnalyze(), 600);\n    return () => window.clearTimeout(timer);\n  }, [readerStatus?.fresh, board.length, busy]);\n  useEffect(() => {\n    if (!board.length) return;\n    const timer = window.setInterval(() => pollReaderAndReprice(), 30000);\n    return () => window.clearInterval(timer);\n  }, [board, date, busy]);",
    'page reader effects',
  );
  source = replaceOnce(
    source,
    "      setProviderStatus(reference);\n      setCreditProviderStatus(credit);",
    "      setProviderStatus(reference);\n      setCreditProviderStatus(credit);\n      if (credit?.payloadHash) creditHashRef.current = credit.payloadHash;\n      if (credit?.readerStatus) setReaderStatus({ ...credit.readerStatus, payloadHash: credit.payloadHash, matchedGameCount: credit.matchedGameCount, observedAt: credit.observedAt, receivedAt: credit.receivedAt });",
    'page remember credit hash',
  );
  const pollFunction = `\n  async function pollReaderAndReprice() {\n    if (busy || readerPollBusyRef.current || !board.length) return;\n    readerPollBusyRef.current = true;\n    try {\n      const status = await requestJSON(\`/api/reader/status?date=\${encodeURIComponent(date)}&t=\${Date.now()}\`, {}, 20000);\n      setReaderStatus(status);\n      if (!status.fresh || !status.payloadHash || status.payloadHash === creditHashRef.current) return;\n      const games = schedule.length ? schedule : board.map(item => item.game);\n      const credit = await requestJSON('/api/credit-lines', {\n        method: 'POST',\n        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },\n        body: JSON.stringify({ date, schedule: games }),\n      }, 60000);\n      setCreditProviderStatus(credit);\n      if (!credit.readerFresh || !credit.payloadHash || credit.payloadHash === creditHashRef.current) return;\n      const creditByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));\n      let updated = 0;\n      let skipped = 0;\n      await runPool(board, 2, async item => {\n        const actual = creditByPk.get(Number(item.game.gamePk));\n        if (!actual?.markets?.length) return;\n        const snapshot = snapshots.current.get(item.game.gamePk);\n        if (!snapshot) { skipped += 1; return; }\n        try {\n          const data = await requestJSON('/api/reprice', {\n            method: 'POST',\n            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },\n            body: JSON.stringify({\n              snapshot,\n              markets: actual.markets,\n              previousMarkets: item.customMarkets || [],\n              settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },\n            }),\n          }, 120000);\n          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);\n          updateBoard(item.game.gamePk, current => ({\n            ...current, actualSource: actual.source, customMarkets: actual.markets,\n            customData: compactAnalysisData(data), status: 'done', statusLabel: 'Tai888最新盤快速重算完成', error: '',\n          }));\n          updated += 1;\n        } catch { skipped += 1; }\n      });\n      creditHashRef.current = credit.payloadHash;\n      setReaderStatus(current => ({ ...current, fresh: true, payloadHash: credit.payloadHash, matchedGameCount: credit.matchedGameCount, observedAt: credit.observedAt, receivedAt: credit.receivedAt }));\n      if (updated) setNotice(\`Tai888盤口已自動更新：\${updated}場沿用凍結比分分布快速重算\${skipped ? '｜' + skipped + '場待下次完整分析' : ''}。\`);\n    } catch (cause) {\n      setReaderStatus(current => ({ ...(current || {}), fresh: false, message: String(cause?.message || cause) }));\n    } finally {\n      readerPollBusyRef.current = false;\n    }\n  }\n`;
  source = replaceOnce(
    source,
    "\n  function openEditor(item, row) {",
    `${pollFunction}\n  function openEditor(item, row) {`,
    'page reader polling function',
  );
  source = source.replace(
    '國際參考盤建立模型；Tai888可自動套入，若受瀏覽器驗證限制則可貼文字或截圖匯入。',
    'Tai888 Reader 持續同步實際信用盤；盤口變動自動沿用凍結比分分布快速重算。',
  );
  source = source.replace(
    '先完成全部國際參考盤分析；Tai888可讀取時自動套入，受Cloudflare限制時不會中斷參考盤分析。',
    'Reader有新盤時自動分析；國際參考盤建立模型，Tai888實際盤負責正式信用盤重算。',
  );
  source = replaceOnce(
    source,
    "        <div className={`providerState ${creditProviderStatus?.blocked ? 'missing' : creditProviderStatus?.configured ? 'ready' : 'missing'}`}>\n          <strong>{creditProviderStatus?.blocked ? 'Tai888受Cloudflare瀏覽器驗證保護' : creditProviderStatus?.configured ? 'Tai888唯讀信用盤已連接' : 'Tai888唯讀信用盤待設定'}</strong>\n          <span>{creditProviderStatus?.blocked ? '伺服器端不能直接登入；請到「上傳盤口」貼文字或上傳截圖。' : creditProviderStatus?.configured ? creditProviderStatus.label || creditProviderStatus.provider : '只使用一般帳密表單與可見盤口頁，不繞過驗證或隱藏接口。'}</span>\n        </div>",
    "        <div className={`providerState ${readerStatus?.fresh || creditProviderStatus?.readerFresh ? 'ready' : 'missing'}`}>\n          <strong>{readerStatus?.fresh || creditProviderStatus?.readerFresh ? 'Tai888 Reader 自動同步正常' : readerStatus?.stale ? 'Tai888 Reader 盤口已過期' : 'Tai888 Reader 等待同步'}</strong>\n          <span>{readerStatus?.fresh || creditProviderStatus?.readerFresh ? `最後同步：${localTime(readerStatus?.receivedAt || creditProviderStatus?.receivedAt)}｜${readerStatus?.matchedGameCount || creditProviderStatus?.matchedGameCount || 0}場｜每60秒更新` : readerStatus?.message || creditProviderStatus?.readerMessage || '保持讀盤電腦、Chrome與Tai888 MLB頁面開啟。'}</span>\n        </div>",
    'page reader provider card',
  );
  write(file, source);
}

// Deployment markers and docs.
if (fs.existsSync('DEPLOYMENT_VERSION')) write('DEPLOYMENT_VERSION', '9.4.0-tai888-reader-v2\n');
{
  const file = 'README.md';
  let source = read(file);
  const note = '\n\n## Tai888 Reader v2\n\nChrome Reader 只讀使用者已登入後可見的 MLB 盤口表格，自動同步至 `/api/reader/ingest`。Production 使用 Vercel Runtime Cache 保存最新盤口；網站偵測價格指紋變動後只走 `/api/reprice`，不重建比分分布。\n';
  if (!source.includes('## Tai888 Reader v2')) source += note;
  write(file, source);
}

console.log('Tai888 Reader v2.0.0 + MLB EV v9.4.0 patch applied.');
