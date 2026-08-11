const pairPanel = document.getElementById('pairPanel');
const statusPanel = document.getElementById('statusPanel');
const password = document.getElementById('password');
const deviceName = document.getElementById('deviceName');
const pairButton = document.getElementById('pair');
const syncButton = document.getElementById('sync');
const unpairButton = document.getElementById('unpair');
const autoToggle = document.getElementById('auto');
const message = document.getElementById('message');
const state = document.getElementById('state');
const dot = document.getElementById('dot');
const lastSync = document.getElementById('lastSync');
const matched = document.getElementById('matched');

pairButton.addEventListener('click', async () => {
  const value = password.value;
  if (!value) return setMessage('請輸入配對密碼。', 'error');
  pairButton.disabled = true;
  pairButton.textContent = '配對中…';
  setMessage('正在建立 Reader 裝置憑證…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'PAIR_READER', password: value, deviceName: deviceName.value });
    if (!result?.ok) throw new Error(result?.error || '配對失敗');
    password.value = '';
    setMessage(result.message || '配對完成', 'ok');
    await refresh();
  } catch (error) {
    setMessage(String(error?.message || error), 'error');
  } finally {
    pairButton.disabled = false;
    pairButton.textContent = '配對並啟用自動同步';
  }
});

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  syncButton.textContent = '同步中…';
  setMessage('正在讀取 Tai888 MLB 盤口表格…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
    if (!result?.ok) throw new Error(result?.error || '同步失敗');
    setMessage(result.message || '同步完成', 'ok');
  } catch (error) {
    setMessage(String(error?.message || error), 'error');
  } finally {
    syncButton.disabled = false;
    syncButton.textContent = '立即同步一次';
    await refresh();
  }
});

autoToggle.addEventListener('change', async () => {
  const result = await chrome.runtime.sendMessage({ type: 'SET_AUTO_ENABLED', enabled: autoToggle.checked });
  setMessage(result?.enabled ? '自動同步已開啟。' : '自動同步已暫停。', result?.enabled ? 'ok' : '');
});

unpairButton.addEventListener('click', async () => {
  await chrome.storage.local.remove(['readerToken', 'pairedAt', 'readerStatus', 'pairError']);
  setMessage('已移除裝置配對，請重新輸入配對密碼。');
  await refresh();
});

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_READER_STATUS' });
  const paired = Boolean(result?.paired);
  pairPanel.classList.toggle('hidden', paired);
  statusPanel.classList.toggle('hidden', !paired);
  if (!paired) {
    setMessage(result?.error || '第一次使用請輸入一次配對密碼。');
    return;
  }
  autoToggle.checked = result.autoEnabled !== false;
  const status = result.status || {};
  const ok = status.ok === true && status.state === 'synced';
  const failed = status.ok === false || Boolean(result.error);
  state.textContent = ok ? '同步正常' : failed ? '需要處理' : '等待首次同步';
  dot.className = ok ? 'ok' : failed ? 'error' : '';
  lastSync.textContent = status.lastSyncAt ? new Date(status.lastSyncAt).toLocaleString('zh-TW') : '尚未同步';
  matched.textContent = Number.isFinite(Number(status.matchedGameCount))
    ? `${status.matchedGameCount}/${status.rawGameCount || status.matchedGameCount} 場`
    : '—';
  if (failed) setMessage(result.error || status.message || '同步失敗', 'error');
  else if (ok) setMessage(status.message || 'Tai888 Reader 已持續自動同步。', 'ok');
  else setMessage('保持 Tai888 MLB 盤口頁開著，Reader 會自動同步。');
}

function setMessage(value, type = '') {
  message.textContent = value;
  message.className = `message ${type}`.trim();
}

refresh().catch(error => setMessage(String(error?.message || error), 'error'));
