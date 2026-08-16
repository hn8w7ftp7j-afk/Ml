const byId = id => document.getElementById(id);
const pairPanel = byId('pairPanel'), statusPanel = byId('statusPanel'), password = byId('password'), deviceName = byId('deviceName');
const pairButton = byId('pair'), syncButton = byId('sync'), unpairButton = byId('unpair'), autoToggle = byId('auto');
const message = byId('message'), state = byId('state'), dot = byId('dot'), leagueGrid = byId('leagueGrid');
const LEAGUES = [['MLB', '美棒'], ['NPB', '日棒'], ['KBO', '韓棒'], ['CPBL', '中職']];
const STALE_MS = 180000;

pairButton.addEventListener('click', async () => {
  if (!password.value) return show('請輸入配對密碼。', 'error');
  pairButton.disabled = true;
  try { const result = await chrome.runtime.sendMessage({ type: 'PAIR_READER', password: password.value, deviceName: deviceName.value }); if (!result?.ok) throw new Error(result?.error || '配對失敗'); password.value = ''; await refresh(); show(result.message || '配對完成', result.syncOk === false ? 'error' : 'ok'); }
  catch (error) { show(error.message, 'error'); } finally { pairButton.disabled = false; }
});
syncButton.addEventListener('click', async () => {
  syncButton.disabled = true; syncButton.textContent = '正在檢查四個分頁…'; show('依聯盟分開讀取，不會互相覆蓋。');
  try { const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' }); await refresh(); show(result?.message || '檢查完成', result?.ok ? 'ok' : 'error'); }
  catch (error) { show(error.message, 'error'); } finally { syncButton.disabled = false; syncButton.textContent = '立即同步四個分頁'; }
});
autoToggle.addEventListener('change', async () => { const result = await chrome.runtime.sendMessage({ type: 'SET_AUTO_ENABLED', enabled: autoToggle.checked }); show(result.enabled ? '自動同步已開啟。' : '自動同步已暫停。', result.enabled ? 'ok' : ''); });
unpairButton.addEventListener('click', async () => { await chrome.storage.local.remove(['readerToken', 'pairedAt', 'readerStatuses', 'pairError', 'lastSuccessfulPayloadHashes', 'lastSuccessfulSyncAts']); await refresh(); show('已移除裝置配對。'); });

function render(statuses) {
  leagueGrid.replaceChildren(); let healthy = 0;
  for (const [id, label] of LEAGUES) {
    const item = statuses[id] || {}, last = Number(item.lastSyncAt || 0), stale = last && Date.now() - last > STALE_MS;
    const ok = item.ok === true && item.state === 'synced' && !stale; if (ok) healthy += 1;
    const card = document.createElement('div'); card.className = `league ${ok ? 'good' : item.state === 'missing' ? 'waiting' : 'bad'}`;
    const title = document.createElement('b'); title.textContent = `${label} ${id}`;
    const detail = document.createElement('span'); detail.textContent = ok ? `${item.captureOnly ? '已抓取・待模型' : '可分析'}｜${item.rawGameCount ?? '—'}場｜${age(last)}` : (item.message || '尚未偵測');
    card.append(title, detail); leagueGrid.append(card);
  }
  state.textContent = `${healthy}/4 個分頁正常`; dot.className = healthy === 4 ? 'ok' : healthy ? '' : 'error';
}
async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_READER_STATUS' }), paired = Boolean(result?.paired);
  pairPanel.classList.toggle('hidden', paired); statusPanel.classList.toggle('hidden', !paired);
  if (!paired) { show(result?.error || '第一次使用請輸入一次配對密碼。'); return; }
  autoToggle.checked = result.autoEnabled !== false; render(result.statuses || {});
}
function age(value) { if (!value) return '尚未同步'; const seconds = Math.floor((Date.now() - value) / 1000); return seconds < 60 ? `${seconds}秒前` : `${Math.floor(seconds / 60)}分鐘前`; }
function show(value, type = '') { message.textContent = value; message.className = `message ${type}`.trim(); }
refresh().catch(error => show(error.message, 'error'));
