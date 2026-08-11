import fs from 'node:fs';

const path = 'app/page.js';
let source = fs.readFileSync(path, 'utf8');

function replaceOnce(before, after, label) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`${label} expected once, found ${count}`);
  source = source.replace(before, after);
}

function replaceBetween(startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (start < 0 || end < 0) throw new Error(`${label} markers not found`);
  source = source.slice(0, start) + replacement + source.slice(end);
}

replaceOnce(
  "const VERSION = '9.2.0';\nconst STORAGE = 'mlb-positive-ev-v9-2';\nconst LEGACY_KEYS = ['mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];",
  "const VERSION = '9.3.0';\nconst STORAGE = 'mlb-positive-ev-v9-3';\nconst LEGACY_KEYS = ['mlb-positive-ev-v9-2', 'mlb-positive-ev-v9-1-preview', 'mlb-positive-ev-v8-4', 'mlb-positive-ev-v7'];",
  'version',
);

replaceOnce(
  "  const [providerStatus, setProviderStatus] = useState(null);\n  const [busy, setBusy] = useState(false);",
  "  const [providerStatus, setProviderStatus] = useState(null);\n  const [creditProviderStatus, setCreditProviderStatus] = useState(null);\n  const [busy, setBusy] = useState(false);",
  'credit provider state',
);

replaceOnce(
  "    requestJSON('/api/reference-lines', {}, 20000).then(setProviderStatus).catch(cause => setProviderStatus({ configured: false, message: String(cause?.message || cause) }));\n  }, []);",
  "    requestJSON('/api/reference-lines', {}, 20000).then(setProviderStatus).catch(cause => setProviderStatus({ configured: false, message: String(cause?.message || cause) }));\n    requestJSON('/api/credit-lines', {}, 20000).then(setCreditProviderStatus).catch(cause => setCreditProviderStatus({ configured: false, message: String(cause?.message || cause) }));\n  }, []);",
  'credit provider health',
);

replaceOnce(
  "  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT' && hasActualWater(row.water));",
  "  const actualRows = (item.customData?.analysis?.results || []).filter(row => row.sourceType === 'ACTUAL_TW_CREDIT');",
  'show missing-side actual rows',
);

replaceOnce(
  "    {item.source && <div className=\"sourceBanner\"><strong>{item.source.label}</strong><span>更新：{localTime(item.source.observedAt)}</span></div>}\n    {item.error && <div className=\"errorBox\">{item.error}</div>}",
  "    {item.source && <div className=\"sourceBanner\"><strong>{item.source.label}</strong><span>更新：{localTime(item.source.observedAt)}</span></div>}\n    {item.actualSource && <div className=\"sourceBanner actualSource\"><strong>{item.actualSource.label}</strong><span>更新：{localTime(item.actualSource.observedAt)}</span></div>}\n    {item.error && <div className=\"errorBox\">{item.error}</div>}",
  'actual source banner',
);

replaceBetween(
  '  async function analyzeBoardItem',
  '\n\n  async function oneClickAnalyze',
  `  async function analyzeBoardItem(task, index, total) {
    const game = task.game;
    const referenceMarkets = task.referenceMarkets || [];
    const actualMarkets = task.actualMarkets || [];
    const useReference = referenceMarkets.length > 0;
    const baseMarkets = useReference ? referenceMarkets : actualMarkets;
    updateBoard(game.gamePk, item => ({ ...item, status: 'running', statusLabel: useReference ? '建立參考比分分布中…' : '建立信用盤比分分布中…' }));
    try {
      const baseData = await requestJSON('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
        body: JSON.stringify({
          game,
          markets: baseMarkets,
          settings: { ...settings, rebateRate: useReference ? 0 : 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
        }),
      }, 180000);
      snapshots.current.set(game.gamePk, baseData.repriceSnapshot);

      let customData = null;
      if (useReference && actualMarkets.length) {
        const repriced = await requestJSON('/api/reprice', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },
          body: JSON.stringify({
            snapshot: baseData.repriceSnapshot,
            markets: actualMarkets,
            previousMarkets: [],
            settings: { ...settings, rebateRate: 0.015, candidateThreshold: 7.2, strongestThreshold: 8.5, expertMode: 'off' },
          }),
        }, 120000);
        snapshots.current.set(game.gamePk, repriced.repriceSnapshot);
        customData = compactAnalysisData(repriced);
      }

      const actualOnly = !useReference;
      updateBoard(game.gamePk, item => ({
        ...item,
        mode: actualOnly ? 'actual' : 'reference',
        status: 'done',
        statusLabel: actualMarkets.length ? '實際信用盤分析完成' : '參考盤分析完成',
        referenceData: compactAnalysisData(baseData),
        customMarkets: actualMarkets,
        customData: actualOnly ? compactAnalysisData(baseData) : customData,
        error: '',
      }));
    } catch (cause) {
      updateBoard(game.gamePk, item => ({ ...item, status: 'failed', statusLabel: '分析失敗', error: String(cause?.message || cause) }));
    } finally {
      setProgress(value => ({ ...value, done: Math.min(total, value.done + 1), label: \`分析今日全部盤口：\${index + 1}/\${total}\` }));
    }
  }`,
  'analyzeBoardItem',
);

replaceBetween(
  '  async function oneClickAnalyze',
  '\n\n  function openEditor',
  `  async function oneClickAnalyze() {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setTab('board'); snapshots.current.clear();
    try {
      setProgress({ active: true, done: 0, total: 1, label: '取得今日MLB賽事' });
      const games = await fetchSchedule(date);
      if (!games.length) throw new Error('這個日期沒有可分析的賽前MLB賽事');

      setProgress({ active: true, done: 0, total: 2, label: '同時取得國際參考盤與Tai888信用盤' });
      const [referenceOutcome, creditOutcome] = await Promise.allSettled([
        requestJSON('/api/reference-lines', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ date, schedule: games }),
        }, 60000),
        requestJSON('/api/credit-lines', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() }, body: JSON.stringify({ date, schedule: games }),
        }, 60000),
      ]);

      const reference = referenceOutcome.status === 'fulfilled'
        ? referenceOutcome.value
        : { configured: providerStatus?.configured || false, games: [], error: String(referenceOutcome.reason?.message || referenceOutcome.reason) };
      const credit = creditOutcome.status === 'fulfilled'
        ? creditOutcome.value
        : { configured: creditProviderStatus?.configured || false, games: [], error: String(creditOutcome.reason?.message || creditOutcome.reason) };
      setProviderStatus(reference);
      setCreditProviderStatus(credit);

      const referenceByPk = new Map((reference.games || []).map(row => [Number(row.gamePk), row]));
      const creditByPk = new Map((credit.games || []).map(row => [Number(row.gamePk), row]));
      const items = games.map(game => {
        const foundReference = referenceByPk.get(Number(game.gamePk));
        const foundCredit = creditByPk.get(Number(game.gamePk));
        const available = Boolean(foundReference?.markets?.length || foundCredit?.markets?.length);
        return {
          game,
          mode: foundReference ? 'reference' : foundCredit ? 'actual' : 'reference',
          source: foundReference?.source || null,
          actualSource: foundCredit?.source || null,
          referenceMarkets: foundReference?.markets || [],
          customMarkets: foundCredit?.markets || [],
          status: available ? 'queued' : 'unopened',
          statusLabel: available ? '等待分析' : '目前尚無可配對盤口',
          referenceData: null,
          customData: null,
          error: '',
        };
      });
      setBoard(items);

      const tasks = items.filter(item => item.referenceMarkets.length || item.customMarkets.length).map(item => ({
        game: item.game,
        referenceMarkets: item.referenceMarkets,
        actualMarkets: item.customMarkets,
      }));
      const sourceWarnings = [
        reference.error ? \`國際參考盤：\${reference.error}\` : '',
        credit.error ? \`Tai888信用盤：\${credit.error}\` : '',
        ...(reference.failures || []),
        ...(credit.warnings || []),
      ].filter(Boolean);

      if (!tasks.length) {
        setNotice(sourceWarnings.join('；') || reference.message || credit.message || '目前兩個盤源都沒有可分析的MLB盤口。');
        setProgress({ active: false, done: 0, total: 0, label: '' });
        return;
      }

      setProgress({ active: true, done: 0, total: tasks.length, label: '分析今日全部盤口' });
      await runPool(tasks, 2, (task, index) => analyzeBoardItem(task, index, tasks.length));
      const creditCount = tasks.filter(task => task.actualMarkets.length).length;
      const referenceCount = tasks.filter(task => task.referenceMarkets.length).length;
      setNotice(\`完成 \${tasks.length} 場分析｜參考盤 \${referenceCount} 場｜實際信用盤 \${creditCount} 場\${sourceWarnings.length ? \`｜提醒：\${sourceWarnings.join('；')}\` : ''}\`);
    } catch (cause) { setError(String(cause?.message || cause)); }
    finally { setBusy(false); setProgress(value => ({ ...value, active: false })); }
  }`,
  'oneClickAnalyze',
);

replaceOnce(
  '<div><div className="eyebrow">MLB POSITIVE EV</div><h1>今日盤口分析</h1><p>先用運彩參考盤建立今日模型，再把你的完整信用盤改上去立即重算。</p></div>',
  '<div><div className="eyebrow">MLB POSITIVE EV</div><h1>今日盤口分析</h1><p>國際參考盤建立模型，Tai888唯讀信用盤自動套入；完整盤口仍可立即改價重算。</p></div>',
  'header copy',
);

replaceOnce(
  '<div className="heroCopy"><span className="kicker">每日主要操作</span><h2>一鍵分析今日全部 MLB</h2><p>取得今日賽事與合法運彩／參考盤，一次建立所有可分析比賽的凍結比分分布與固定分數。</p></div>',
  '<div className="heroCopy"><span className="kicker">每日主要操作</span><h2>一鍵分析今日全部 MLB</h2><p>同時取得國際參考盤與你的唯讀信用盤，一次建立凍結比分分布並直接產生實際信用盤分數。</p></div>',
  'hero copy',
);

replaceOnce(
  `        <div className={\`providerState \${providerStatus?.configured ? 'ready' : 'missing'}\`}>
          <strong>{providerStatus?.configured ? '合法參考盤來源已連接' : '合法參考盤來源尚未設定'}</strong>
          <span>{providerStatus?.configured ? providerStatus.provider || providerStatus.primary || '可使用' : '網站不會模擬登入或爬取未授權頁面；仍可用截圖匯入。'}</span>
        </div>`,
  `        <div className={\`providerState \${providerStatus?.configured ? 'ready' : 'missing'}\`}>
          <strong>{providerStatus?.configured ? '國際參考盤已連接' : '國際參考盤尚未設定'}</strong>
          <span>{providerStatus?.configured ? providerStatus.provider || providerStatus.primary || '可使用' : '設定THE_ODDS_API_KEY後可自動取得國際參考盤。'}</span>
        </div>
        <div className={\`providerState \${creditProviderStatus?.configured ? 'ready' : 'missing'}\`}>
          <strong>{creditProviderStatus?.configured ? 'Tai888唯讀信用盤已連接' : 'Tai888唯讀信用盤待設定'}</strong>
          <span>{creditProviderStatus?.configured ? creditProviderStatus.label || creditProviderStatus.provider : '只使用一般帳密表單與可見盤口頁，不繞過驗證或隱藏接口。'}</span>
        </div>`,
  'provider cards',
);

fs.writeFileSync(path, source);
console.log('v9.3 homepage patch applied');
