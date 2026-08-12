import fs from 'node:fs';

function read(file) { return fs.readFileSync(file, 'utf8'); }
function write(file, value) { fs.writeFileSync(file, value); }
function replaceRequired(file, before, after, label) {
  const source = read(file);
  if (source.includes(after)) return;
  if (!source.includes(before)) throw new Error(`${file}: missing ${label}`);
  write(file, source.replace(before, after));
}
function replaceSection(file, startMarker, endMarker, replacement, label) {
  const source = read(file);
  if (source.includes(replacement)) return;
  const start = source.indexOf(startMarker);
  const end = start >= 0 ? source.indexOf(endMarker, start) : -1;
  if (start < 0 || end < 0) throw new Error(`${file}: missing section ${label}`);
  write(file, source.slice(0, start) + replacement + source.slice(end));
}
function replaceOptional(file, before, after) {
  const source = read(file);
  if (source.includes(after) || !source.includes(before)) return false;
  write(file, source.replace(before, after));
  return true;
}

// Version alignment.
{
  const pkg = JSON.parse(read('package.json'));
  pkg.version = '9.4.1';
  const requiredTests = [
    'node scripts/tai888-reader-capture-policy-v202-test.mjs',
    'node scripts/tai888-reader-split-row-v202-test.mjs',
    'node scripts/reader-heartbeat-v202-test.mjs',
    'node scripts/market-freshness-v1-test.mjs',
    'node scripts/market-verification-v1-test.mjs',
    'node scripts/reader-static-security-v202-test.mjs',
    'node scripts/page-reader-automation-v941-test.mjs',
  ];
  const existing = String(pkg.scripts?.test || '').split(' && ').filter(Boolean);
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.test = [...new Set([...existing, ...requiredTests])].join(' && ');
  write('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
}
replaceRequired('app/page.js', "const VERSION = '9.4.0';", "const VERSION = '9.4.1';", 'page version');
replaceRequired('app/page.js', "const STORAGE = 'mlb-positive-ev-v9-4-0';", "const STORAGE = 'mlb-positive-ev-v9-4-1';", 'storage version');
replaceRequired('app/page.js', "const LEGACY_KEYS = ['mlb-positive-ev-v9-3-4'", "const LEGACY_KEYS = ['mlb-positive-ev-v9-4-0', 'mlb-positive-ev-v9-3-4'", 'legacy storage');
replaceRequired('app/api/health/route.js', "version: '9.4.0'", "version: '9.4.1'", 'health version');
if (fs.existsSync('DEPLOYMENT_VERSION')) write('DEPLOYMENT_VERSION', 'v9.4.1-tai888-reader-v2.0.2-production\n');

// Credit-line endpoint must tolerate 30-second Reader polling and fast repricing.
replaceRequired(
  'app/api/credit-lines/route.js',
  "{ id: 'tai888-credit-lines-v9-3', limit: 6, windowMs: 10 * 60 * 1000 }",
  "{ id: 'tai888-credit-lines-v9-4-1', limit: 180, windowMs: 10 * 60 * 1000 }",
  'credit line rate limit',
);

// Analyze route: enforce line freshness, preserve provenance and verify exact contracts independently.
replaceRequired(
  'app/api/analyze/route.js',
  "import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';",
  "import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';\nimport { applyMarketFreshness } from '../../../lib/market-freshness-v1.js';\nimport { applyIndependentMarketVerification } from '../../../lib/market-verification-v1.js';",
  'analyze imports',
);
replaceSection(
  'app/api/analyze/route.js',
  'function sanitizeMarketRows(rows, maximum = 16) {',
  '\n\nfunction cacheSet',
  `function sanitizeMarketRows(rows, maximum = 16) {
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => applyMarketFreshness({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),
    referenceSide: cleanText(row?.referenceSide, 40), rawText: cleanText(row?.rawText, 300),
    sourceTemplateVersion: cleanText(row?.sourceTemplateVersion, 80), authorizationStatus: cleanText(row?.authorizationStatus, 80),
  }, now)).filter(row => row.market);
}`,
  'analyze sanitizer',
);
replaceRequired(
  'app/api/analyze/route.js',
  "    const markets = sanitizeMarketRows(body.markets, 12);\n    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 24);",
  "    const suppliedMarkets = sanitizeMarketRows(body.markets, 12);\n    const verificationMarkets = sanitizeMarketRows(body.verificationMarkets, 16);\n    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);\n    const previousMarkets = sanitizeMarketRows(body.previousMarkets, 24);",
  'analyze market verification',
);

// Reprice route: same gates must apply to price-only updates.
replaceRequired(
  'app/api/reprice/route.js',
  "import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';",
  "import { MARKET_ORDER, marketIsOpen, validateMarketPair } from '../../../lib/markets.js';\nimport { applyMarketFreshness } from '../../../lib/market-freshness-v1.js';\nimport { applyIndependentMarketVerification } from '../../../lib/market-verification-v1.js';",
  'reprice imports',
);
replaceSection(
  'app/api/reprice/route.js',
  'function sanitizeMarkets(rows, maximum = 16) {',
  '\n\nexport async function POST',
  `function sanitizeMarkets(rows, maximum = 16) {
  const now = Date.now();
  return (Array.isArray(rows) ? rows : []).slice(0, maximum).map(row => applyMarketFreshness({
    market: MARKET_ORDER.includes(row?.market) ? row.market : '', pick: cleanText(row?.pick, 120), water: optionalNumber(row?.water),
    waterEstimated: Boolean(row?.waterEstimated), waterMissing: row?.waterMissing === true,
    confidence: Math.max(0, Math.min(1, Number(row?.confidence) || 0)),
    sourceType: cleanText(row?.sourceType, 40) || (row?.waterEstimated ? 'ESTIMATED' : 'ACTUAL_TW_CREDIT'),
    sourceLabel: cleanText(row?.sourceLabel, 120), provider: cleanText(row?.provider, 80),
    lineAsOf: cleanText(row?.lineAsOf, 40), executable: row?.executable !== false, marketVerification: cleanVerification(row?.marketVerification),
    rawDecimalOdds: optionalNumber(row?.rawDecimalOdds), providerEventId: cleanText(row?.providerEventId, 120),
    referenceSide: cleanText(row?.referenceSide, 40), rawText: cleanText(row?.rawText, 300),
    sourceTemplateVersion: cleanText(row?.sourceTemplateVersion, 80), authorizationStatus: cleanText(row?.authorizationStatus, 80),
  }, now)).filter(row => row.market);
}`,
  'reprice sanitizer',
);
replaceRequired(
  'app/api/reprice/route.js',
  "    const markets = sanitizeMarkets(body.markets, 12);\n    const previousMarkets = sanitizeMarkets(body.previousMarkets, 24);",
  "    const suppliedMarkets = sanitizeMarkets(body.markets, 12);\n    const verificationMarkets = sanitizeMarkets(body.verificationMarkets, 16);\n    const markets = applyIndependentMarketVerification(suppliedMarkets, verificationMarkets);\n    const previousMarkets = sanitizeMarkets(body.previousMarkets, 24);",
  'reprice market verification',
);

// Non-executable or stale prices must never look like normal formal ratings.
replaceRequired(
  'lib/deterministic-finalizer.js',
  "        : row.waterEstimated\n          ? '參考盤篩選評分｜非最終下注評分'\n          : resultTag(score, candidateThreshold, Number(settings.strongestThreshold || 8.5));",
  "        : !executable\n          ? row.executionStatus === 'EXPIRED' ? '盤口已過期｜不評分｜不下注' : '目前不可下注｜非正式評分'\n          : row.waterEstimated\n            ? '參考盤篩選評分｜非最終下注評分'\n            : resultTag(score, candidateThreshold, Number(settings.strongestThreshold || 8.5));",
  'finalizer stale tag',
);

// Website automation and stale-market UI.
replaceRequired(
  'app/page.js',
  "  const autoAnalyzeRef = useRef(false);",
  "  const autoAnalyzeHashRef = useRef('');\n  const lastFullAnalysisAtRef = useRef(0);",
  'reader refs',
);
replaceSection(
  'app/page.js',
  "  useEffect(() => {\n    requestJSON('/api/health'",
  '\n\n  const ranked = useMemo',
  `  useEffect(() => {
    requestJSON('/api/health', {}, 20000).then(setHealth).catch(() => setHealth(null));
    requestJSON('/api/reference-lines', {}, 20000).then(setProviderStatus).catch(cause => setProviderStatus({ configured: false, message: String(cause?.message || cause) }));
    requestJSON('/api/credit-lines', {}, 20000).then(setCreditProviderStatus).catch(cause => setCreditProviderStatus({ configured: false, message: String(cause?.message || cause) }));
  }, []);
  useEffect(() => {
    const refreshReader = () => requestJSON(\`/api/reader/status?date=\${encodeURIComponent(date)}&t=\${Date.now()}\`, {}, 20000)
      .then(setReaderStatus)
      .catch(cause => setReaderStatus(current => ({ ...(current || {}), fresh: false, message: String(cause?.message || cause) })));
    refreshReader();
    const timer = window.setInterval(refreshReader, 30000);
    return () => window.clearInterval(timer);
  }, [date]);
  useEffect(() => {
    const hash = readerStatus?.payloadHash || '';
    const key = \`${date}:\${hash}\`;
    if (!readerStatus?.fresh || !hash || board.length || busy || autoAnalyzeHashRef.current === key) return;
    autoAnalyzeHashRef.current = key;
    const timer = window.setTimeout(() => oneClickAnalyze(), 600);
    return () => window.clearTimeout(timer);
  }, [readerStatus?.fresh, readerStatus?.payloadHash, board.length, busy, date]);
  useEffect(() => {
    if (!board.length) return;
    const timer = window.setInterval(() => pollReaderAndReprice(), 30000);
    return () => window.clearInterval(timer);
  }, [board, date, busy]);
  useEffect(() => {
    if (!board.length) return;
    const timer = window.setInterval(() => {
      if (!busy && readerStatus?.fresh && Date.now() - Number(lastFullAnalysisAtRef.current || 0) > 30 * 60 * 1000) oneClickAnalyze();
    }, 5 * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [board.length, date, busy, readerStatus?.fresh]);`,
  'reader effects',
);
replaceSection(
  'app/page.js',
  '  const ranked = useMemo',
  '\n\n  function updateBoard',
  `  const ranked = useMemo(() => board.flatMap(item => {
    const readerBacked = item.actualSource?.provider === 'TAI888_READER_AUTO';
    const actualAllowed = !readerBacked || readerStatus?.fresh === true;
    const actual = actualAllowed
      ? (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT'
        && hasActualWater(row.water) && row.executable !== false && row.lineFresh !== false)
      : [];
    const actualMarkets = new Set(actual.map(row => row.market));
    const reference = (item.referenceData?.analysis?.results || []).filter(row => !actualMarkets.has(row.market));
    return [...actual, ...reference].map(row => ({ ...row, game: item.game }));
  }).filter(row => Number.isFinite(Number(row.score))).sort((a, b) => Number(b.score) - Number(a.score)), [board, readerStatus?.fresh]);`,
  'ranked stale gating',
);
replaceRequired(
  'app/page.js',
  "  const formal = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water);",
  "  const formal = row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water) && row.executable !== false && row.lineFresh !== false;",
  'result formal gating',
);
replaceRequired(
  'app/page.js',
  'function GameCard({ item, onEdit, onBet, onResetMarket }) {',
  'function GameCard({ item, onEdit, onBet, onResetMarket, readerFresh }) {',
  'game card reader state',
);
replaceRequired(
  'app/page.js',
  "  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT');",
  "  const readerBacked = item.actualSource?.provider === 'TAI888_READER_AUTO';\n  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT').map(row => readerBacked && !readerFresh ? { ...row, executable: false, lineFresh: false, betEligible: false, tag: '盤口已過期｜不下注' } : row);",
  'game card stale rows',
);
replaceRequired(
  'app/page.js',
  "{board.map(item => <GameCard key={item.game.gamePk} item={item} onEdit={openEditor} onBet={recordBet} onResetMarket={resetMarket}/>) }",
  "{board.map(item => <GameCard key={item.game.gamePk} item={item} onEdit={openEditor} onBet={recordBet} onResetMarket={resetMarket} readerFresh={readerStatus?.fresh === true}/>) }",
  'game card reader prop',
);

// Every actual-line analysis/reprice receives the reference contracts for independent verification.
replaceOptional(
  'app/page.js',
  "          markets: baseMarkets,\n          settings:",
  "          markets: baseMarkets,\n          verificationMarkets: referenceMarkets,\n          settings:",
);
replaceOptional(
  'app/page.js',
  "            markets: actualMarkets,\n            previousMarkets: [],\n            settings:",
  "            markets: actualMarkets,\n            previousMarkets: [],\n            verificationMarkets: referenceMarkets,\n            settings:",
);

replaceRequired(
  'app/page.js',
  "      setNotice(`完成 ${tasks.length} 場分析｜參考盤 ${referenceCount} 場｜實際信用盤 ${creditCount} 場${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);",
  "      lastFullAnalysisAtRef.current = Date.now();\n      setNotice(`完成 ${tasks.length} 場分析｜參考盤 ${referenceCount} 場｜實際信用盤 ${creditCount} 場${sourceWarnings.length ? `｜提醒：${sourceWarnings.join('；')}` : ''}`);",
  'full analysis timestamp',
);

replaceSection(
  'app/page.js',
  '  async function pollReaderAndReprice() {',
  '\n\n  function openEditor',
  `  async function pollReaderAndReprice() {
    if (busy || readerPollBusyRef.current || !board.length) return;
    readerPollBusyRef.current = true;
    try {
      const status = await requestJSON(\`/api/reader/status?date=\${encodeURIComponent(date)}&t=\${Date.now()}\`, {}, 20000);
      setReaderStatus(status);
      if (!status.fresh || !status.payloadHash || status.payloadHash === creditHashRef.current) return;
      const games = schedule.length ? schedule : board.map(item => item.game);
      const credit = await requestJSON('/api/credit-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({ date, schedule: games }),
      }, 60000);
      setCreditProviderStatus(credit);
      if (!credit.readerFresh || !credit.payloadHash || credit.payloadHash === creditHashRef.current) return;
      const creditByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));
      let updated = 0;
      let removed = 0;
      let skipped = 0;
      await runPool(board, 2, async item => {
        const actual = creditByPk.get(Number(item.game.gamePk));
        if (!actual?.markets?.length) {
          if (item.actualSource?.provider === 'TAI888_READER_AUTO' && item.customMarkets?.length) {
            updateBoard(item.game.gamePk, current => ({
              ...current,
              actualSource: null,
              customMarkets: [],
              customData: null,
              statusLabel: current.referenceData ? 'Tai888實際盤已下架｜保留參考盤' : 'Tai888實際盤已下架',
            }));
            removed += 1;
          }
          return;
        }
        const snapshot = snapshots.current.get(item.game.gamePk);
        if (!snapshot) { skipped += 1; return; }
        try {
          const data = await requestJSON('/api/reprice', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
            body: JSON.stringify({
              snapshot,
              markets: actual.markets,
              previousMarkets: item.customMarkets || [],
              verificationMarkets: item.referenceMarkets || [],
              settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
            }),
          }, 120000);
          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);
          updateBoard(item.game.gamePk, current => ({
            ...current,
            actualSource: actual.source,
            customMarkets: actual.markets,
            customData: compactAnalysisData(data),
            status: 'done',
            statusLabel: 'Tai888最新盤快速重算完成',
            error: '',
          }));
          updated += 1;
        } catch { skipped += 1; }
      });
      creditHashRef.current = credit.payloadHash;
      setReaderStatus(current => ({
        ...current,
        fresh: true,
        payloadHash: credit.payloadHash,
        matchedGameCount: credit.matchedGameCount,
        observedAt: credit.observedAt,
        receivedAt: credit.receivedAt,
      }));
      if (updated || removed) {
        setNotice(\`Tai888盤口已自動更新：\${updated}場快速重算\${removed ? '｜' + removed + '場已下架清除' : ''}\${skipped ? '｜' + skipped + '場改走完整分析' : ''}。\`);
      }
      if (skipped) window.setTimeout(() => oneClickAnalyze(), 800);
    } catch (cause) {
      setReaderStatus(current => ({ ...(current || {}), fresh: false, message: String(cause?.message || cause) }));
    } finally {
      readerPollBusyRef.current = false;
    }
  }`,
  'reader reprice loop',
);

// Add verificationMarkets to remaining manual repricing bodies where the item is in scope.
replaceOptional(
  'app/page.js',
  "body: JSON.stringify({ snapshot, markets, previousMarkets: previousActualMarkets, settings:",
  "body: JSON.stringify({ snapshot, markets, previousMarkets: previousActualMarkets, verificationMarkets: item.referenceMarkets || [], settings:",
);
replaceOptional(
  'app/page.js',
  "body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || [], settings:",
  "body: JSON.stringify({ snapshot, markets, previousMarkets: item.customMarkets || [], verificationMarkets: item.referenceMarkets || [], settings:",
);

console.log('Applied MLB EV v9.4.1 / Tai888 Reader v2.0.2 production patch.');
