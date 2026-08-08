from pathlib import Path


def replace_once(text, old, new, label):
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


def replace_between(text, start, end, replacement, label):
    left = text.find(start)
    if left < 0:
        raise SystemExit(f'{label}: start marker missing')
    right = text.find(end, left)
    if right < 0:
        raise SystemExit(f'{label}: end marker missing')
    return text[:left] + replacement.rstrip() + '\n\n' + text[right:]


path = Path('app/page.js')
text = path.read_text()
text = replace_once(
    text,
    "} from '../lib/markets.js';\nimport { translateTeamText } from '../lib/i18n.js';",
    "} from '../lib/markets.js';\nimport { BATCH_VERSION, blankDirection, buildAutoAnalysisPlan, flattenMarkets, withFallbackWater } from '../lib/batch.js';\nimport { translateTeamText } from '../lib/i18n.js';",
    'batch imports',
)
text = text.replace("const VERSION = '7.0.6';", "const VERSION = '7.1.0';")
text = replace_once(
    text,
    "const EMPTY = { locks: [], analysisHistory: {}, bets: [], settings: DEFAULT_SETTINGS };",
    "const EMPTY = { locks: [], analysisHistory: {}, bets: [], settings: DEFAULT_SETTINGS, lastBatchId: null };",
    'store batch marker',
)

blank_block = '''function blankGame(game) {
  return {
    id: uid(),
    away: game?.away || '',
    home: game?.home || '',
    gamePk: game?.gamePk || null,
    matchedGame: game || null,
    confidence: 0,
    markets: MARKET_ORDER.map(market => ({ market, directions: [blankDirection(), blankDirection()] })),
  };
}'''
text = replace_between(text, 'function blankDirection() {', 'function mergeVision(rows) {', blank_block, 'move batch helpers')

pool = '''async function runPool(items, concurrency, worker) {
  const rows = Array.isArray(items) ? items : [];
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, rows.length || 1)) }, async () => {
    while (cursor < rows.length) {
      const index = cursor;
      cursor += 1;
      await worker(rows[index], index);
    }
  });
  await Promise.all(runners);
}'''
text = replace_once(text, 'function latestVersion(history, lockId) {', pool + '\n\nfunction latestVersion(history, lockId) {', 'run pool helper')

text = replace_once(
    text,
    "  const [visionBusy, setVisionBusy] = useState(false);\n  const [manualText, setManualText] = useState('');",
    "  const [visionBusy, setVisionBusy] = useState(false);\n  const [batchReport, setBatchReport] = useState(null);\n  const [manualText, setManualText] = useState('');",
    'batch report state',
)

pipeline = r'''  async function chooseImages(files) {
    const list = [...(files || [])].slice(0, 8);
    if (!list.length || visionBusy) return;
    setVisionBusy(true);
    setBatchReport(null);
    setVisionStatus('正在保留文字清晰度並分段全部圖片…');
    try {
      const rows = [];
      for (let index = 0; index < list.length; index += 1) {
        const file = list[index];
        const prepared = await prepareImage(file);
        rows.push({
          id: uid(),
          name: file.name,
          preview: URL.createObjectURL(file),
          data: prepared.data,
          parts: prepared.parts,
          width: prepared.width,
          height: prepared.height,
          size: file.size,
        });
        setVisionStatus(`正在處理第 ${index + 1} 張，共 ${list.length} 張；此圖分為 ${prepared.parts.length} 區塊`);
      }
      setImages(rows);
      const regions = rows.reduce((sum, row) => sum + Math.max(1, row.parts?.length || 0), 0);
      setVisionStatus(`已準備 ${rows.length} 張圖片、${regions} 個區塊；現在自動辨識全部盤口`);
      await recognizeAndAnalyze(rows);
    } catch (error) {
      setVisionStatus(`自動處理失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  async function recognizeAndAnalyze(sourceImages) {
    const all = [];
    const failures = [];
    const models = new Set();
    const tasks = sourceImages.flatMap((image, imageIndex) => {
      const parts = Array.isArray(image.parts) && image.parts.length ? image.parts : [image.data];
      return parts.map((data, partIndex) => ({ image, imageIndex, partIndex, partCount: parts.length, data }));
    });

    for (let index = 0; index < tasks.length; index += 1) {
      const task = tasks[index];
      setVisionStatus(`自動辨識全部圖片：圖片 ${task.imageIndex + 1}/${sourceImages.length}，區塊 ${task.partIndex + 1}/${task.partCount}`);
      try {
        const data = await requestJSON('/api/vision', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ images: [task.data], schedule: games, defaultWater: store.settings.fallbackWater }),
        });
        if (data.model) models.add(data.model);
        all.push(...(data.games || []));
      } catch (error) {
        failures.push(`圖片 ${task.imageIndex + 1} 區塊 ${task.partIndex + 1}：${error.message}`);
      }
    }

    const merged = mergeVision(all);
    if (!merged.length) throw new Error(failures[0] || '沒有辨識到任何場次，請改貼盤口文字或裁切更小範圍');
    setParsed(merged);
    setSelected(0);
    const modelText = models.size ? `｜${[...models].join('、')}` : '';
    const partialText = failures.length ? `｜${failures.length} 個區塊需注意` : '';
    setVisionStatus(`辨識完成 ${merged.length} 場${modelText}${partialText}；開始自動分析所有有效盤口`);
    await autoAnalyzeAll(merged, failures);
  }

  async function recognize() {
    if (!images.length || visionBusy) return;
    setVisionBusy(true);
    setBatchReport(null);
    try {
      await recognizeAndAnalyze(images);
    } catch (error) {
      setVisionStatus(`重新處理失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  async function parseText() {
    if (!manualText.trim() || visionBusy) return;
    setVisionBusy(true);
    setBatchReport(null);
    setVisionStatus('正在解析全部盤口文字…');
    try {
      const data = await requestJSON('/api/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: manualText, schedule: games, defaultWater: store.settings.fallbackWater }),
      });
      const rows = mergeVision(data.games || []);
      if (!rows.length) throw new Error('沒有解析到場次');
      setParsed(rows);
      setSelected(0);
      setVisionStatus(`解析完成 ${rows.length} 場；開始自動分析所有有效盤口`);
      await autoAnalyzeAll(rows, []);
    } catch (error) {
      setVisionStatus(`解析或分析失敗：${error.message}`);
    } finally {
      setVisionBusy(false);
    }
  }

  async function autoAnalyzeAll(rows, recognitionFailures = []) {
    const existingLocks = [...store.locks];
    const plan = buildAutoAnalysisPlan({
      games: rows,
      settings: store.settings,
      version: VERSION,
      batchId: uid(),
      idFactory: uid,
    });
    setParsed(plan.preparedGames);

    if (!plan.locks.length) {
      const report = {
        batchId: plan.batchId,
        recognized: plan.recognizedGameCount,
        analyzed: 0,
        failed: 0,
        skipped: plan.recognizedGameCount,
        directions: 0,
        issues: [...plan.issues, ...recognitionFailures],
      };
      setBatchReport(report);
      setVisionStatus('辨識已完成，但沒有可直接分析的有效盤口；請到盤口確認頁修正');
      setTab('confirm');
      return;
    }

    setStore(value => ({
      ...value,
      lastBatchId: plan.batchId,
      locks: [...plan.locks, ...value.locks].slice(0, 300),
    }));
    setBusyLocks(value => ({ ...value, ...Object.fromEntries(plan.locks.map(lock => [lock.id, true])) }));

    let finished = 0;
    let completed = 0;
    const analysisFailures = [];
    await runPool(plan.locks, 2, async lock => {
      const previous = existingLocks
        .filter(item => String(item.game?.gamePk) === String(lock.game?.gamePk) && new Date(item.lockedAt) < new Date(lock.lockedAt))
        .sort((left, right) => new Date(right.lockedAt) - new Date(left.lockedAt))[0];
      try {
        const data = await requestJSON('/api/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            game: lock.game,
            markets: lock.markets,
            previousMarkets: previous?.markets || [],
            settings: store.settings,
          }),
        }, 180000);
        const analysisVersion = { id: uid(), createdAt: new Date().toISOString(), ...data };
        setStore(value => ({
          ...value,
          analysisHistory: {
            ...value.analysisHistory,
            [lock.id]: [analysisVersion, ...(value.analysisHistory[lock.id] || [])].slice(0, 30),
          },
        }));
        completed += 1;
      } catch (error) {
        analysisFailures.push(`${matchup(lock.game)}：${error.message}`);
      } finally {
        finished += 1;
        setBusyLocks(value => ({ ...value, [lock.id]: false }));
        setVisionStatus(`自動分析全部盤口：已完成 ${finished}/${plan.locks.length} 場`);
      }
    });

    const issues = [...plan.issues, ...recognitionFailures, ...analysisFailures];
    const report = {
      batchId: plan.batchId,
      recognized: plan.recognizedGameCount,
      analyzed: completed,
      failed: analysisFailures.length,
      skipped: Math.max(0, plan.recognizedGameCount - plan.locks.length),
      directions: plan.directionCount,
      markets: plan.marketCount,
      issues,
    };
    setBatchReport(report);
    setVisionStatus(`全部完成：辨識 ${report.recognized} 場，自動分析 ${report.analyzed} 場、${report.markets} 個市場、${report.directions} 個方向${issues.length ? `；${issues.length} 項需核對` : ''}`);
    setTab(completed > 0 ? 'analysis' : 'confirm');
  }'''
text = replace_between(text, '  async function chooseImages(files) {', '  function addManual() {', pipeline, 'replace upload pipeline')

text = replace_once(
    text,
    "  const allLatestResults = useMemo(() => store.locks.flatMap(lock => latestVersion(store.analysisHistory, lock.id)?.analysis?.results || []), [store]);",
    "  const allLatestResults = useMemo(() => store.locks.flatMap(lock => latestVersion(store.analysisHistory, lock.id)?.analysis?.results || []), [store]);\n  const latestBatchLocks = useMemo(() => store.lastBatchId ? store.locks.filter(lock => lock.batchId === store.lastBatchId) : [], [store]);\n  const latestBatchRows = useMemo(() => latestBatchLocks.flatMap(lock => {\n    const data = latestVersion(store.analysisHistory, lock.id);\n    return (data?.analysis?.results || []).map(result => ({ lock, data, result }));\n  }).sort((left, right) => (right.result.score ?? -1) - (left.result.score ?? -1)), [latestBatchLocks, store.analysisHistory]);",
    'latest batch score rows',
)

text = text.replace('實際開盤 → MLB 資料 → GPT 研究判讀 → 聯合比分分布 → 台灣信用盤 EV', '上傳全部圖片 → 自動辨識全部盤口 → 自動分析全部場次 → 一次顯示所有評分')

old_upload = '''        <h2>一、上傳信用盤截圖</h2>
        <label className="drop">點這裡從手機相簿選擇<input type="file" accept="image/*" multiple onChange={event => chooseImages(event.target.files)}/><span>最多 8 張；只擷取實際開出的市場</span></label>
        <div className="previews">{images.map(image => <div className="preview" key={image.id}><img src={image.preview} alt="盤口截圖"/><button onClick={() => setImages(value => value.filter(item => item.id !== image.id))}>移除</button><small>{image.name}</small></div>)}</div>
        <div className="status">{visionStatus || '尚未選擇圖片'}</div>
        <button className="primary full" disabled={visionBusy || !images.length} onClick={recognize}>{visionBusy ? '人工智慧辨識中，請勿重複點擊' : '開始辨識盤口'}</button>'''
new_upload = '''        <h2>一、上傳後自動分析全部盤口</h2>
        <label className="drop">點這裡一次選擇所有盤口圖片<input type="file" accept="image/*" multiple disabled={visionBusy} onChange={event => { chooseImages(event.target.files); event.target.value = ''; }}/><span>最多 8 張；選完後自動辨識、建立全部快照並分析所有實際開盤市場，不必逐場按分析</span></label>
        <div className="previews">{images.map(image => <div className="preview" key={image.id}><img src={image.preview} alt="盤口截圖"/><button disabled={visionBusy} onClick={() => setImages(value => value.filter(item => item.id !== image.id))}>移除</button><small>{image.name}</small></div>)}</div>
        <div className="status">{visionStatus || '尚未選擇圖片；選圖後會直接跑到全部評分'}</div>
        {batchReport && <div className={batchReport.issues?.length ? 'warnings' : 'success'}>本次辨識 {batchReport.recognized} 場｜成功分析 {batchReport.analyzed} 場｜{batchReport.markets || 0} 個市場｜{batchReport.directions || 0} 個方向{batchReport.issues?.length ? `｜${batchReport.issues.length} 項需核對` : '｜全部完成'}</div>}
        <button className="secondary full" disabled={visionBusy || !images.length} onClick={recognize}>{visionBusy ? '正在自動辨識並分析全部盤口…' : '重新辨識並分析目前全部圖片'}</button>'''
text = replace_once(text, old_upload, new_upload, 'one-step upload UI')

text = text.replace('<h2>盤口確認與不可覆寫快照</h2>', '<h2>盤口確認與不可覆寫快照</h2><p className="note">一般上傳不需要逐場操作；只有未配對或辨識異常的市場才需要在這裡修正。</p>')

analysis_marker = "    {tab === 'analysis' && <section>\n      {!store.locks.length ?"
analysis_summary = '''    {tab === 'analysis' && <section>
      {latestBatchRows.length > 0 && <div className="card">
        <h2>本次上傳：全部盤口評分總覽</h2>
        <p className="note">已自動完成 {latestBatchLocks.length} 場；下方先依評分由高到低一次列出所有實際開盤方向，再顯示各場完整分析。</p>
        <div className="portfolio">{latestBatchRows.map(({ lock, result }, index) => <div className="portfolioRow" key={`${lock.id}-${result.market}-${result.pick}-${index}`}>
          <b>{result.score == null ? '—' : result.score.toFixed(1)}</b>
          <span>{matchup(lock.game)}｜{result.market}｜{translateTeamText(result.pick)}</span>
          <strong>{result.tag}</strong>
          <span>{result.water == null ? '水位未提供' : Number(result.water).toFixed(3)}{result.waterEstimated ? ' 暫估' : ''}</span>
        </div>)}</div>
        {batchReport?.issues?.length > 0 && <div className="warnings"><b>需核對項目</b>{batchReport.issues.slice(0, 12).map(item => <div key={item}>• {item}</div>)}</div>}
      </div>}
      {!store.locks.length ?'''
text = replace_once(text, analysis_marker, analysis_summary, 'batch analysis summary')

path.write_text(text)

# Health exposes the automatic workflow version.
path = Path('app/api/health/route.js')
text = path.read_text()
text = replace_once(text, "import { VISION_VERSION } from '../../../lib/vision.js';", "import { VISION_VERSION } from '../../../lib/vision.js';\nimport { BATCH_VERSION } from '../../../lib/batch.js';", 'health batch import')
text = text.replace("version: '7.0.6'", "version: '7.1.0'")
text = replace_once(text, '    visionVersion: VISION_VERSION,', '    visionVersion: VISION_VERSION,\n    batchVersion: BATCH_VERSION,', 'health batch version')
path.write_text(text)

# Tests for market-by-market planning and skipped invalid rows.
path = Path('scripts/test.mjs')
text = path.read_text()
text = replace_once(text, "import { VISION_VERSION, buildVisionPrompt, cleanVisionJSON, expandVisionPayload } from '../lib/vision.js';", "import { VISION_VERSION, buildVisionPrompt, cleanVisionJSON, expandVisionPayload } from '../lib/vision.js';\nimport { BATCH_VERSION, buildAutoAnalysisPlan } from '../lib/batch.js';", 'test batch import')
batch_tests = r'''
const autoPlan = buildAutoAnalysisPlan({
  games: [{
    id: 'recognized-1',
    away,
    home,
    matchedGame: { gamePk: 44, away, home },
    markets: [
      { market: '全場讓分', directions: [{ pick: `${away}讓1+50`, water: 0.95 }, { pick: `${home}受讓1+50`, water: 0.95 }] },
      { market: '全場大小', directions: [{ pick: '大8+50', water: 0.94 }, { pick: '小9+50', water: 0.94 }] },
      { market: '上半讓分', directions: [{ pick: '', water: null }, { pick: '', water: null }] },
      { market: '上半大小', directions: [{ pick: '', water: null }, { pick: '', water: null }] },
    ],
  }, {
    id: 'recognized-2',
    away: '未配對客隊',
    home: '未配對主隊',
    matchedGame: null,
    markets: [],
  }],
  settings: { fallbackWater: { 全場讓分: 0.95, 全場大小: 0.94, 上半讓分: 0.94, 上半大小: 0.93 } },
  version: 'test-version',
  batchId: 'batch-test',
  idFactory: () => 'lock-test',
  now: () => '2026-08-09T00:00:00.000Z',
});
assert.equal(BATCH_VERSION, 'MLB-AUTO-ANALYZE-ALL-2026-08-v1');
assert.equal(autoPlan.locks.length, 1);
assert.equal(autoPlan.locks[0].batchId, 'batch-test');
assert.equal(autoPlan.locks[0].markets.length, 2);
assert.ok(autoPlan.locks[0].markets.every(row => row.market === '全場讓分'));
assert.ok(autoPlan.issues.some(value => value.includes('全場大小')));
assert.ok(autoPlan.issues.some(value => value.includes('尚未配對')));
'''
text = replace_once(text, "assert.match(VISION_VERSION, /v7\\.0\\.5$/);", "assert.match(VISION_VERSION, /v7\\.0\\.5$/);\n" + batch_tests, 'batch regression tests')
path.write_text(text)

# Production smoke checks the release and one-step UI contract.
path = Path('scripts/smoke.mjs')
text = path.read_text()
text = text.replace("const VERSION = '7.0.6';", "const VERSION = '7.1.0';")
text = replace_once(text, "const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.5';", "const VISION_VERSION = 'MLB-VISION-2026-08-v7.0.5';\nconst BATCH_VERSION = 'MLB-AUTO-ANALYZE-ALL-2026-08-v1';", 'smoke batch constant')
text = replace_once(text, '        && value.visionVersion === VISION_VERSION', '        && value.visionVersion === VISION_VERSION\n        && value.batchVersion === BATCH_VERSION', 'smoke wait batch')
text = replace_once(text, 'assert.equal(health.visionVersion, VISION_VERSION);', 'assert.equal(health.visionVersion, VISION_VERSION);\nassert.equal(health.batchVersion, BATCH_VERSION);', 'smoke batch assertion')
text = text.replace('/第\\s*7\\.0\\.6\\s*版/', '/第\\s*7\\.1\\.0\\s*版/')
text = replace_once(text, "assert.match(renderedHome, /第\\s*7\\.1\\.0\\s*版/);", "assert.match(renderedHome, /第\\s*7\\.1\\.0\\s*版/);\nassert.match(renderedHome, /選完後自動辨識、建立全部快照並分析所有實際開盤市場/);\nassert.match(renderedHome, /本次上傳：全部盤口評分總覽/);", 'smoke one-step UI assertions')
path.write_text(text)

path = Path('package.json')
text = path.read_text().replace('"version": "7.0.6"', '"version": "7.1.0"')
path.write_text(text)
Path('DEPLOYMENT_VERSION').write_text('7.1.0-auto-analyze-all-uploaded-markets\n')

path = Path('README.md')
text = path.read_text().replace('# MLB 長期正期望值分析｜第 7.0.6 版', '# MLB 長期正期望值分析｜第 7.1.0 版', 1)
text += '''

## 7.1.0 上傳後一次完成全部分析

手機一次選擇最多 8 張盤口截圖後，前端會自動保留文字清晰度、切割密集表格、辨識並合併所有圖片中的場次，再依市場逐一驗證。可確認的實際開盤市場會自動建立同一批次的不可覆寫快照，最多同時兩場執行完整 MLB＋GPT＋27 情境分析；使用者不再需要逐場建立快照或逐場按「建立新分析版本」。

若某一市場格式異常，只略過該市場，不阻擋同場其他有效市場；未配對或異常項目保留在盤口確認頁。分析完成後自動切換到「分析結果」，先以評分高低一次列出本次所有盤口方向，再顯示各場完整 EV、風險與比分分布。
'''
path.write_text(text)

print('auto analyze all v7.1.0 patch applied')
