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
const STALE_MS = 180_000;

pairButton.addEventListener('click', async () => {
  const value = password.value;
  if (!value) return setMessage('請輸入配對密碼。', 'error');
  pairButton.disabled = true;
  pairButton.textContent = '配對中…';
  setMessage('正在建立 Reader 裝置憑證…');
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'PAIR_READER',
      password: value,
      deviceName: deviceName.value,
    });
    if (!result?.ok) throw new Error(result?.error || '配對失敗');
    password.value = '';
    await refresh();
    setMessage(
      result.message || '配對完成',
      result.syncOk === false ? 'error' : 'ok',
    );
  } catch (error) {
    await refresh().catch(() => {});
    setMessage(String(error?.message || error), 'error');
  } finally {
    pairButton.disabled = false;
    pairButton.textContent = '配對並啟用自動同步';
  }
});

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  syncButton.textContent = '同步中…';
  setMessage('正在讀取 Tai888 MLB 標準盤口…');
  try {
    const result = await chrome.runtime.sendMessage({ type: 'SYNC_NOW' });
    if (!result?.ok) throw new Error(result?.error || '同步失敗');
    await refresh();
    setMessage(result.message || '同步完成', result.skipped ? '' : 'ok');
  } catch (error) {
    await refresh().catch(() => {});
    setMessage(String(error?.message || error), 'error');
  } finally {
    syncButton.disabled = false;
    syncButton.textContent = '立即同步一次';
  }
});

autoToggle.addEventListener('change', async () => {
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'SET_AUTO_ENABLED',
      enabled: autoToggle.checked,
    });
    if (!result?.ok) throw new Error(result?.error || '設定失敗');
    setMessage(result.enabled ? '自動同步已開啟。' : '自動同步已暫停。', result.enabled ? 'ok' : '');
  } catch (error) {
    autoToggle.checked = !autoToggle.checked;
    setMessage(String(error?.message || error), 'error');
  }
});

unpairButton.addEventListener('click', async () => {
  await chrome.storage.local.remove([
    'readerToken', 'pairedAt', 'readerStatus', 'pairError',
    'lastPayloadHash', 'lastSyncAt',
  ]);
  await refresh();
  setMessage('已移除裝置配對，請重新輸入配對密碼。');
});

async function refresh() {
  const result = await chrome.runtime.sendMessage({ type: 'GET_READER_STATUS' });
  const paired = Boolean(result?.paired);
  pairPanel.classList.toggle('hidden', paired);
  statusPanel.classList.toggle('hidden', !paired);
  if (!paired) {
    setMessage(result?.error || '第一次使用請輸入一次配對密碼。');
    return result;
  }

  autoToggle.checked = result.autoEnabled !== false;
  const status = result.status || {};
  const lastSyncAt = Number(status.lastSyncAt || 0);
  const ageMs = lastSyncAt ? Math.max(0, Date.now() - lastSyncAt) : null;
  const stale = status.state === 'synced' && ageMs != null && ageMs > STALE_MS;
  const failed = status.ok === false || Boolean(result.error);
  const ok = status.ok === true && status.state === 'synced' && !stale;

  state.textContent = ok
    ? '同步正常'
    : stale
      ? '盤口已過期'
      : failed
        ? '需要處理'
        : '配對完成｜等待首次同步';
  dot.className = ok ? 'ok' : stale || failed ? 'error' : '';
  lastSync.textContent = lastSyncAt
    ? `${new Date(lastSyncAt).toLocaleString('zh-TW')}（${formatAge(ageMs)}前）`
    : '尚未同步';
  matched.textContent = Number.isFinite(Number(status.matchedGameCount))
    ? `${status.matchedGameCount}/${status.rawGameCount || status.matchedGameCount} 場`
    : '—';

  if (stale) {
    setMessage('最後成功同步已超過3分鐘。請確認Tai888頁面仍登入、停在「美棒 → 讓分＆大小」，必要時按F5後再立即同步。', 'error');
  } else if (failed) {
    setMessage(result.error || status.message || '同步失敗', 'error');
  } else if (ok) {
    setMessage(status.message || 'Tai888 Reader 已持續自動同步。', 'ok');
  } else {
    setMessage('裝置已配對。保持Tai888 MLB盤口頁開著，再按「立即同步一次」。');
  }
  return result;
}

function formatAge(milliseconds) {
  const seconds = Math.floor(Number(milliseconds || 0) / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分鐘`;
  return `${Math.floor(minutes / 60)}小時`;
}

function setMessage(value, type = '') {
  message.textContent = value;
  message.className = `message ${type}`.trim();
}

refresh().catch(error => setMessage(String(error?.message || error), 'error'));
