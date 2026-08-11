import fs from 'node:fs';

function read(path) {
  return fs.readFileSync(path, 'utf8');
}

function write(path, content) {
  fs.writeFileSync(path, content);
}

function replaceExact(source, before, after, label) {
  if (!source.includes(before)) throw new Error(`Patch target not found: ${label}`);
  return source.replace(before, after);
}

// 1. Tai888 source: detect Cloudflare browser challenge and stop cleanly.
{
  const path = 'lib/tai888-source.js';
  let source = read(path);
  source = replaceExact(
    source,
    "export const TAI888_SOURCE_VERSION = 'TAI888-STANDARD-LOGIN-VISIBLE-PAGE-2026-08-v1.0.0';",
    "export const TAI888_SOURCE_VERSION = 'TAI888-STANDARD-LOGIN-VISIBLE-PAGE-2026-08-v1.1.0';",
    'Tai888 source version',
  );
  source = replaceExact(
    source,
    "async function readText(response) {\n  const buffer = Buffer.from(await response.arrayBuffer());\n  if (buffer.length > MAX_PAGE_BYTES) throw new Error('Tai888頁面內容過大，已停止讀取');\n  return buffer.toString('utf8');\n}\n",
    "async function readText(response) {\n  const buffer = Buffer.from(await response.arrayBuffer());\n  if (buffer.length > MAX_PAGE_BYTES) throw new Error('Tai888頁面內容過大，已停止讀取');\n  return buffer.toString('utf8');\n}\n\nexport function isCloudflareChallengeForTest(status, headers = {}, text = '') {\n  const server = typeof headers?.get === 'function' ? headers.get('server') : headers?.server;\n  const body = String(text || '');\n  return Number(status) === 403\n    && (/cloudflare/i.test(String(server || '')) || /Just a moment|cf-chl-|challenge-platform|Enable JavaScript and cookies/i.test(body));\n}\n",
    'Cloudflare challenge helper',
  );
  source = replaceExact(
    source,
    "    const text = await readText(response);\n    if (!response.ok) throw new Error(`Tai888頁面請求失敗（${response.status}）`);\n    return { url, status: response.status, text, contentType: response.headers.get('content-type') || '' };",
    "    const text = await readText(response);\n    if (isCloudflareChallengeForTest(response.status, response.headers, text)) {\n      const error = new Error('Tai888目前啟用Cloudflare瀏覽器驗證，Vercel伺服器無法直接登入；請在Tai888登入後，使用「貼上盤口文字」或「上傳盤口截圖」匯入。');\n      error.code = 'TAI888_CLOUDFLARE_BLOCKED';\n      error.status = 409;\n      throw error;\n    }\n    if (!response.ok) throw new Error(`Tai888頁面請求失敗（${response.status}）`);\n    return { url, status: response.status, text, contentType: response.headers.get('content-type') || '' };",
    'Cloudflare challenge handling',
  );
  write(path, source);
}

// 2. Credit-lines API: Cloudflare is a supported blocked state, not a fatal board error.
{
  const path = 'app/api/credit-lines/route.js';
  let source = read(path);
  source = replaceExact(
    source,
    "  } catch (error) {\n    return NextResponse.json({\n      ok: false,\n      error: String(error?.message || error),\n      details: Array.isArray(error?.details) ? error.details.slice(0, 8) : [],\n    }, {\n      status: Number(error?.status) || 502,\n      headers: { 'Cache-Control': 'no-store' },\n    });\n  }",
    "  } catch (error) {\n    if (error?.code === 'TAI888_CLOUDFLARE_BLOCKED') {\n      return NextResponse.json({\n        ok: true,\n        configured: true,\n        blocked: true,\n        blockCode: 'TAI888_CLOUDFLARE_BLOCKED',\n        version: TAI888_SOURCE_VERSION,\n        provider: 'TAI888_READ_ONLY_CREDIT',\n        label: 'Tai888唯讀信用盤',\n        games: [],\n        message: String(error.message),\n        importModes: ['clipboard_text', 'screenshot'],\n      }, { headers: { 'Cache-Control': 'no-store' } });\n    }\n    return NextResponse.json({\n      ok: false,\n      error: String(error?.message || error),\n      details: Array.isArray(error?.details) ? error.details.slice(0, 8) : [],\n    }, {\n      status: Number(error?.status) || 502,\n      headers: { 'Cache-Control': 'no-store' },\n    });\n  }",
    'Credit-lines blocked response',
  );
  write(path, source);
}

// 3. Frontend: deterministic one-click reference analysis plus clipboard/text fallback.
{
  const path = 'app/page.js';
  let source = read(path);
  source = replaceExact(source, "const VERSION = '9.3.3';", "const VERSION = '9.3.4';", 'frontend version');
  source = replaceExact(
    source,
    "const STORAGE = 'mlb-positive-ev-v9-3-3';\nconst LEGACY_KEYS = ['mlb-positive-ev-v9-3-2',",
    "const STORAGE = 'mlb-positive-ev-v9-3-4';\nconst LEGACY_KEYS = ['mlb-positive-ev-v9-3-3', 'mlb-positive-ev-v9-3-2',",
    'frontend storage version',
  );
  source = replaceExact(
    source,
    "  const [uploadStatus, setUploadStatus] = useState('');\n  const [health, setHealth] = useState(null);",
    "  const [uploadStatus, setUploadStatus] = useState('');\n  const [pasteText, setPasteText] = useState('');\n  const [pasteStatus, setPasteStatus] = useState('');\n  const [health, setHealth] = useState(null);",
    'clipboard state',
  );
  source = replaceExact(
    source,
    "        credit.error ? `Tai888信用盤：${credit.error}` : '',\n        ...(reference.failures || []),",
    "        credit.error ? `Tai888信用盤：${credit.error}` : '',\n        credit.blocked && credit.message ? `Tai888信用盤：${credit.message}` : '',\n        ...(reference.failures || []),",
    'blocked source warning',
  );

  const functions = `\n  async function pasteCreditText() {\n    try {\n      if (!navigator?.clipboard?.readText) throw new Error('clipboard unavailable');\n      const value = await navigator.clipboard.readText();\n      if (!String(value || '').trim()) throw new Error('clipboard empty');\n      setPasteText(value);\n      setPasteStatus('已貼上剪貼簿內容，按「辨識並分析文字」即可。');\n      setError('');\n    } catch {\n      setError('Safari目前無法直接讀取剪貼簿，請長按下方文字框後選擇「貼上」。');\n    }\n  }\n\n  async function importCreditText(event) {\n    event?.preventDefault?.();\n    const text = String(pasteText || '').trim();\n    if (busy) return;\n    if (!text) { setError('請先貼上Tai888盤口文字'); return; }\n    setBusy(true); setError(''); setNotice(''); setPasteStatus('辨識貼上的盤口文字中…'); snapshots.current.clear();\n    try {\n      const games = schedule.length ? schedule : await fetchSchedule(date);\n      const recognized = await requestJSON('/api/vision', {\n        method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },\n        body: JSON.stringify({ text, schedule: games, defaultWater: settings.fallbackWater }),\n      }, 180000);\n      const prepared = (recognized.games || []).map(raw => {\n        const matchedGame = games.find(game => Number(game.gamePk) === Number(raw.gamePk)) || games.find(game => clean(game.away) === clean(raw.away) && clean(game.home) === clean(raw.home));\n        return withFallbackWater({ ...raw, matchedGame }, settings);\n      }).filter(row => row.matchedGame);\n      if (!prepared.length) throw new Error('沒有辨識到可配對的信用盤場次，請確認複製內容包含對戰、盤口與水位');\n      const items = prepared.map(row => ({\n        game: row.matchedGame, mode: 'actual', source: { label: '我的Tai888盤口文字', observedAt: new Date().toISOString() }, referenceMarkets: [], customMarkets: flattenMarkets(row),\n        status: 'queued', statusLabel: '等待分析', referenceData: null, customData: null, error: '',\n      }));\n      setBoard(items); setTab('board');\n      setProgress({ active: true, done: 0, total: items.length, label: '分析貼上的信用盤文字' });\n      await runPool(items, 2, async (item, index) => {\n        updateBoard(item.game.gamePk, value => ({ ...value, status: 'running', statusLabel: '分析中…' }));\n        try {\n          const data = await requestJSON('/api/analyze', {\n            method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': uid() },\n            body: JSON.stringify({ game: item.game, markets: item.customMarkets, settings: { ...settings, rebateRate: 0.015 } }),\n          }, 180000);\n          snapshots.current.set(item.game.gamePk, data.repriceSnapshot);\n          updateBoard(item.game.gamePk, value => ({ ...value, status: 'done', statusLabel: '信用盤分析完成', referenceData: compactAnalysisData(data), customData: compactAnalysisData(data) }));\n        } catch (cause) {\n          updateBoard(item.game.gamePk, value => ({ ...value, status: 'failed', statusLabel: '分析失敗', error: String(cause?.message || cause) }));\n        } finally {\n          setProgress(value => ({ ...value, done: value.done + 1, label: \\`分析文字盤口：\\${index + 1}/\\${items.length}\\` }));\n        }\n      });\n      setPasteStatus(\\`完成 \\${items.length} 場盤口分析\\`);\n      setNotice(\\`已從貼上的Tai888盤口文字完成 \\${items.length} 場分析。\\`);\n    } catch (cause) {\n      setError(String(cause?.message || cause));\n      setPasteStatus('文字辨識失敗');\n    } finally {\n      setBusy(false);\n      setProgress(value => ({ ...value, active: false }));\n    }\n  }\n`;
  source = replaceExact(
    source,
    "\n  async function uploadScreenshots(event) {",
    `${functions}\n  async function uploadScreenshots(event) {`,
    'clipboard import functions',
  );

  source = replaceExact(
    source,
    "<div><div className=\"eyebrow\">MLB POSITIVE EV</div><h1>今日盤口分析</h1><p>國際參考盤建立模型，Tai888唯讀信用盤自動套入；完整盤口仍可立即改價重算。</p></div>",
    "<div><div className=\"eyebrow\">MLB POSITIVE EV</div><h1>今日盤口分析</h1><p>國際參考盤建立模型；Tai888可自動套入，若受瀏覽器驗證限制則可貼文字或截圖匯入。</p></div>",
    'header copy',
  );
  source = replaceExact(
    source,
    "<div className=\"heroCopy\"><span className=\"kicker\">每日主要操作</span><h2>一鍵分析今日全部 MLB</h2><p>同時取得國際參考盤與你的唯讀信用盤，一次建立凍結比分分布並直接產生實際信用盤分數。</p></div>",
    "<div className=\"heroCopy\"><span className=\"kicker\">每日主要操作</span><h2>一鍵分析今日全部 MLB</h2><p>先完成全部國際參考盤分析；Tai888可讀取時自動套入，受Cloudflare限制時不會中斷參考盤分析。</p></div>",
    'hero copy',
  );
  source = replaceExact(
    source,
    "        <div className={`providerState ${creditProviderStatus?.configured ? 'ready' : 'missing'}`}>\n          <strong>{creditProviderStatus?.configured ? 'Tai888唯讀信用盤已連接' : 'Tai888唯讀信用盤待設定'}</strong>\n          <span>{creditProviderStatus?.configured ? creditProviderStatus.label || creditProviderStatus.provider : '只使用一般帳密表單與可見盤口頁，不繞過驗證或隱藏接口。'}</span>\n        </div>",
    "        <div className={`providerState ${creditProviderStatus?.blocked ? 'missing' : creditProviderStatus?.configured ? 'ready' : 'missing'}`}>\n          <strong>{creditProviderStatus?.blocked ? 'Tai888受Cloudflare瀏覽器驗證保護' : creditProviderStatus?.configured ? 'Tai888唯讀信用盤已連接' : 'Tai888唯讀信用盤待設定'}</strong>\n          <span>{creditProviderStatus?.blocked ? '伺服器端不能直接登入；請到「上傳盤口」貼文字或上傳截圖。' : creditProviderStatus?.configured ? creditProviderStatus.label || creditProviderStatus.provider : '只使用一般帳密表單與可見盤口頁，不繞過驗證或隱藏接口。'}</span>\n        </div>",
    'provider blocked state',
  );

  source = replaceExact(
    source,
    "    {tab === 'import' && <section className=\"panel\">\n      <h2>上傳我的信用盤截圖</h2><p className=\"muted\">一次可選最多8張。辨識後直接分析全部有效盤口；此功能是合法盤源尚未連接時的備援，也是你輸入實際信用盤的方式。</p>\n      <label className=\"uploadDrop\"><input type=\"file\" accept=\"image/*\" multiple onChange={uploadScreenshots}/><strong>點這裡選擇盤口圖片</strong><span>{uploadStatus || '選完後自動辨識並分析，不必逐場按按鈕'}</span></label>",
    "    {tab === 'import' && <section className=\"panel\">\n      <h2>匯入我的Tai888信用盤</h2><p className=\"muted\">Tai888目前啟用Cloudflare瀏覽器驗證，伺服器不能直接代登入。你仍可在自己的瀏覽器正常登入後，把可見盤口文字貼到下方，一次辨識並分析。</p>\n      <form className=\"textImport\" onSubmit={importCreditText}>\n        <div className=\"textImportHead\"><strong>貼上盤口文字</strong><span>不會上傳帳號、密碼或餘額</span></div>\n        <textarea rows=\"10\" value={pasteText} onChange={event => setPasteText(event.target.value)} placeholder=\"在Tai888盤口頁複製可見文字後貼在這裡…\"/>\n        <div className=\"importActions\"><button type=\"button\" className=\"secondary\" onClick={pasteCreditText}>貼上剪貼簿</button><button className=\"primary\" disabled={busy || !pasteText.trim()}>{busy ? '處理中…' : '辨識並分析文字'}</button></div>\n        {pasteStatus && <div className=\"importStatus\">{pasteStatus}</div>}\n      </form>\n      <div className=\"importDivider\"><span>或使用圖片</span></div>\n      <h3>上傳信用盤截圖</h3><p className=\"muted\">一次可選最多8張。辨識後直接分析全部有效盤口。</p>\n      <label className=\"uploadDrop\"><input type=\"file\" accept=\"image/*\" multiple onChange={uploadScreenshots}/><strong>點這裡選擇盤口圖片</strong><span>{uploadStatus || '選完後自動辨識並分析，不必逐場按按鈕'}</span></label>",
    'clipboard import UI',
  );
  write(path, source);
}

// 4. Styling for the text-import fallback.
{
  const path = 'app/globals.css';
  let source = read(path);
  source = replaceExact(source, 'button,input,select{font:inherit}', 'button,input,select,textarea{font:inherit}', 'textarea font');
  source = replaceExact(
    source,
    '.uploadDrop{display:block;',
    '.textImport{margin-top:18px;background:#071522;border:1px solid #294b68;border-radius:16px;padding:15px}.textImportHead{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:10px}.textImportHead span{font-size:11px;color:#829bb2}.textImport textarea{display:block;width:100%;resize:vertical;min-height:170px;background:#04101b;color:#f2f7fc;border:1px solid #355674;border-radius:12px;padding:12px;line-height:1.55}.importActions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:10px}.secondary{border:1px solid #3a5e7d;border-radius:12px;background:#10283f;color:#e9f5ff;font-weight:800;padding:12px 15px}.importStatus{margin-top:10px;color:#8edfb5;font-size:12px}.importDivider{display:flex;align-items:center;gap:10px;color:#7993aa;font-size:11px;margin:22px 0 12px}.importDivider:before,.importDivider:after{content:\"\";height:1px;background:#29445f;flex:1}.panel h3{margin:0 0 6px}.uploadDrop{display:block;',
    'text import styles',
  );
  source = replaceExact(
    source,
    '.explainGrid{grid-template-columns:1fr}.settingsGrid{grid-template-columns:1fr}',
    '.explainGrid{grid-template-columns:1fr}.importActions{grid-template-columns:1fr}.textImportHead{display:grid}.settingsGrid{grid-template-columns:1fr}',
    'mobile text import styles',
  );
  write(path, source);
}

// 5. Versions and permanent test.
{
  const path = 'app/api/health/route.js';
  let source = read(path);
  source = replaceExact(source, "version: '9.3.3',", "version: '9.3.4',", 'health version');
  write(path, source);
}
{
  const path = 'package.json';
  let source = read(path);
  source = replaceExact(source, '"version": "9.3.3"', '"version": "9.3.4"', 'package version');
  source = replaceExact(
    source,
    'node scripts/reference-lines-test.mjs && node scripts/tai888-source-test.mjs && node scripts/single-side-water-test.mjs',
    'node scripts/reference-lines-test.mjs && node scripts/tai888-source-test.mjs && node scripts/tai888-cloudflare-test.mjs && node scripts/single-side-water-test.mjs',
    'test command',
  );
  write(path, source);
}
write('scripts/tai888-cloudflare-test.mjs', `import assert from 'node:assert/strict';\nimport { isCloudflareChallengeForTest } from '../lib/tai888-source.js';\n\nassert.equal(isCloudflareChallengeForTest(403, { server: 'cloudflare' }, '<title>Just a moment...</title>'), true);\nassert.equal(isCloudflareChallengeForTest(403, { server: 'nginx' }, '<html>Forbidden</html>'), false);\nassert.equal(isCloudflareChallengeForTest(200, { server: 'cloudflare' }, '<title>Just a moment...</title>'), false);\nconsole.log(JSON.stringify({ ok: true, cloudflareBlockedState: true }, null, 2));\n`);

console.log('Applied v9.3.4 Tai888 Cloudflare-safe fallback.');
