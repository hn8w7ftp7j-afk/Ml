const byId = id => document.getElementById(id);
const pairPanel = byId('pairPanel'), statusPanel = byId('statusPanel'), password = byId('password'), deviceName = byId('deviceName');
const pairButton = byId('pair'), syncButton = byId('sync'), unpairButton = byId('unpair'), autoToggle = byId('auto');
const message = byId('message'), state = byId('state'), dot = byId('dot'), leagueGrid = byId('leagueGrid');
const LEAGUES = [['MLB', '美棒'], ['NPB', '日棒'], ['KBO', '韓棒'], ['CPBL', '中職'], ['NBA', '美籃'], ['NHL', '冰球'], ['EPL', '英超'], ['UCL', '歐冠']];
const STALE_MS = 180000;
async function send(payload) {
  let timer;
  try {
    const result = await Promise.race([
      chrome.runtime.sendMessage(payload),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reader 背景程式未回應，請到擴充功能頁重新載入 Reader。')), payload.type === 'GET_READER_STATUS' ? 8000 : 240000); }),
    ]);
    if (!result) throw new Error('Reader 未回傳狀態，請重新載入擴充功能。');
    return result;
  } finally { clearTimeout(timer); }
}
byId('repair').addEventListener('click', async () => {
  const button = byId('repair'); button.disabled = true;
  try { const result = await send({ type: 'REPAIR_READER' }); await refresh(); show(result.message || result.error || '修復未完成', result.ok ? 'ok' : 'error'); }
  catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
});
byId('diagnostics').addEventListener('click', async () => {
  const button = byId('diagnostics'); button.disabled = true;
  try {
    const result = await send({ type: 'GET_READER_DIAGNOSTICS' });
    if (!result?.ok) throw new Error(result?.error || '診斷讀取失敗');
    const url = URL.createObjectURL(new Blob([JSON.stringify(result.report, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'Tai888-Reader-diagnostics.json';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    show('診斷已下載，僅包含盤口與讀取狀態，不含配對密碼、Cookie 或 Token。');
  } catch (error) { show(error.message, 'error'); }
  finally { button.disabled = false; }
});

pairButton.addEventListener('click', async () => {
  if (!password.value) return show('請輸入配對密碼。', 'error');
  pairButton.disabled = true;
  try { const result = await send({ type: 'PAIR_READER', password: password.value, deviceName: deviceName.value }); if (!result?.ok) throw new Error(result?.error || '配對失敗'); password.value = ''; await refresh(); show(result.message || '配對完成', result.syncOk === false ? 'error' : 'ok'); }
  catch (error) { show(error.message, 'error'); } finally { pairButton.disabled = false; }
});
syncButton.addEventListener('click', async () => {
  syncButton.disabled = true; syncButton.textContent = '正在檢查各聯盟…'; show('依聯盟分開讀取，不會互相覆蓋。');
  try { const result = await send({ type: 'SYNC_NOW' }); await refresh(); show(result?.message || '檢查完成', result?.ok ? 'ok' : 'error'); }
  catch (error) { show(error.message, 'error'); } finally { syncButton.disabled = false; syncButton.textContent = '立即同步'; }
});
autoToggle.addEventListener('change', async () => { const result = await send({ type: 'SET_AUTO_ENABLED', enabled: autoToggle.checked }); show(result.enabled ? '自動同步已開啟。' : '自動同步已暫停。', result.enabled ? 'ok' : ''); });
unpairButton.addEventListener('click', async () => { await chrome.storage.local.remove(['readerToken', 'pairedAt', 'readerStatuses', 'pairError', 'lastSuccessfulPayloadHashes', 'lastSuccessfulSyncAts', 'diagnosticOutbox', 'diagnosticDelivery', 'diagnosticLastSignature', 'diagnosticLastQueuedAt']); await refresh(); show('已移除裝置配對。'); });

function renderSeenCaptureDelivery(delivery) {
  const element=byId('seenCaptureDelivery');if(!element)return;
  const count=value=>Number.isSafeInteger(value)&&value>=0?String(value):'未確認';
  const failureTime=typeof delivery?.captureFailureAt==='string'&&Number.isFinite(Date.parse(delivery.captureFailureAt))
    ?new Date(delivery.captureFailureAt).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'}):'未確認';
  const problem=delivery?.captureFailureScope==='UNIDENTIFIED_CAPTURE'
    ?`｜先前有無法對應來源的保存失敗（${failureTime}），當次是否已補存仍未確認`
    :delivery?.state==='error'?'｜保存或補傳異常，請查看後台診斷':
    delivery?.code==='SEEN_PAIR_REQUIRED'?'｜等待配對後補傳':'';
  element.textContent=`已看過原盤：本機待傳 ${count(delivery?.pendingCount)} 片｜伺服器回條 ${count(delivery?.savedCaptureCount)} 片${problem}。保留未通過核對的原盤證據；片數不等於賽事數。`;
}
function renderDiagnosticDelivery(delivery) {
  const element = byId('diagnosticDelivery');
  if (!element) return;
  element.textContent = delivery?.state === 'sent'
    ? `診斷已回傳｜${delivery.lastReceivedAt ? new Date(delivery.lastReceivedAt).toLocaleString('zh-TW') : ''}`
    : delivery?.state === 'pending' ? `診斷等待補傳（${delivery.pendingCount || 0} 筆）${delivery.code === 'PAIR_REQUIRED' ? '，請重新配對' : ''}`
    : '診斷將隨讀取自動回傳';
}

function renderMarketArchiveDelivery(delivery) {
  const element = byId('marketArchiveDelivery');
  if (!element) return;
  const pending = Number(delivery?.pendingCount || 0), saved = Number(delivery?.savedCaptureCount || 0);
  const failure = delivery?.code === 'QUEUE_FULL' ? '本機待傳空間已滿，新增擷取未備份；舊待傳資料仍保留'
    : delivery?.code === 'LOCAL_SAVE_FAILED' ? '本機保存未確認，新增擷取未備份'
    : delivery?.code === 'PAIR_REQUIRED' ? '等待重新配對後補傳'
    : delivery?.code === 'DEVICE_MISMATCH' ? '待傳資料屬於其他裝置，已保留並停止補傳'
    : delivery?.code === 'INVALID_RECEIPT' ? '伺服器保存回條不符，資料仍保留'
    : delivery?.code === 'RETRY_PENDING' ? '連線恢復後自動補傳' : '';
  element.textContent = `盤口歷史備份：待傳 ${pending} 筆｜已確認 ${saved} 筆${failure ? `｜${failure}` : ''}`
    + (Number(delivery?.failedCaptureCount || 0) ? `｜累計未加入備份 ${delivery.failedCaptureCount} 次` : '')
    + '。歷史補傳不代表即時盤已同步或所有賽事已收齊。';
}

function render(statuses) {
  leagueGrid.replaceChildren(); let healthy = 0;
  for (const [id, label] of LEAGUES) {
    const item = statuses[id] || {}, last = Number(item.lastSyncAt || 0), stale = last && Date.now() - last > STALE_MS;
    const ok = item.ok === true && item.state === 'synced' && !stale; if (ok) healthy += 1;
    const waiting = ['missing', 'idle'].includes(item.state);
    const card = document.createElement('div'); card.className = `league ${ok ? 'good' : waiting ? 'waiting' : 'bad'}`;
    const title = document.createElement('b'); title.textContent = `${label} ${id}`;
    const local = item.localDiagnostic || {};
    const serverOpen = Number(item.matchedGameCount || 0), serverLocked = Number(item.unopenedGameCount || 0);
    const detail = document.createElement('span');
    detail.textContent = ok
      ? `${['NHL','EPL','UCL'].includes(id) ? '原盤已保存，規則待驗證' : id === 'NBA' ? '盤口已同步' : serverOpen > 0 ? '可分析' : '尚無可分析盤'}｜本機開${local.openCount ?? '—'} 鎖${local.lockedCount ?? '—'} 市場${local.marketCount ?? '—'}｜後端${['NBA', 'NHL', 'EPL', 'UCL'].includes(id) ? '配對' : '開'}${serverOpen} 未開${serverLocked} 市場${item.marketCount ?? 0}${item.partialGameCount ? ` 部分開${item.partialGameCount}場` : ''}｜${age(last)}${serverOpen === 0 && local.sample ? `｜樣本：${local.sample}` : ''}`
      : (item.message || '尚未偵測');
    card.append(title, detail); leagueGrid.append(card);
  }
  state.textContent = `${healthy}/${LEAGUES.length} 個聯盟已同步`; dot.className = healthy === LEAGUES.length ? 'ok' : healthy ? '' : 'error';
}
async function refresh() {
  const result = await send({ type: 'GET_READER_STATUS' });
  if (!result.ok) throw new Error(result.error || '無法取得 Reader 狀態');
  const paired = Boolean(result.paired);
  pairPanel.classList.toggle('hidden', paired); statusPanel.classList.toggle('hidden', !paired);
  renderMarketArchiveDelivery(result.marketArchiveDelivery);
  renderSeenCaptureDelivery(result.seenCaptureDelivery);
  if (!paired) { show(result?.error || '第一次使用請輸入一次配對密碼。'); return; }
  autoToggle.checked = result.autoEnabled !== false; render(result.statuses || {});
  renderDiagnosticDelivery(result.diagnosticDelivery);
}
function age(value) { if (!value) return '尚未同步'; const seconds = Math.floor((Date.now() - value) / 1000); return seconds < 60 ? `${seconds}秒前` : `${Math.floor(seconds / 60)}分鐘前`; }
function show(value, type = '') { message.textContent = value; message.className = `message ${type}`.trim(); }
async function initialize() {
  await refresh();
  if (!statusPanel.classList.contains('hidden') && autoToggle.checked) {
    show('正在偵測 Tai888 分頁…');
    const result = await send({ type: 'SYNC_NOW' });
    await refresh();
    show(result.message || result.error || '偵測未完成', result.ok ? 'ok' : 'error');
  } else if (!statusPanel.classList.contains('hidden')) show('自動同步已暫停，可按立即同步手動偵測。');
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.readerStatuses) render(changes.readerStatuses.newValue || {});
  if (area === 'local' && changes.diagnosticDelivery) renderDiagnosticDelivery(changes.diagnosticDelivery.newValue);
  if (area === 'local' && changes.marketArchiveDelivery) renderMarketArchiveDelivery(changes.marketArchiveDelivery.newValue);
});
initialize().catch(error => show(error.message, 'error'));
