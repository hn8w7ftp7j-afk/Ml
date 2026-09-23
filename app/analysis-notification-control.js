'use client';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

const OPT_OUT = 'analysis-notifications-off-v1';
function optedOut() { try { return localStorage.getItem(OPT_OUT) === '1'; } catch { return false; } }
function rememberOff(off) { try { if (off) localStorage.setItem(OPT_OUT, '1'); else localStorage.removeItem(OPT_OUT); } catch {} }
function bounded(promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('通知連線逾時；本次分析仍會繼續，請稍後重試啟用。')), 15000);
  })]).finally(() => clearTimeout(timer));
}

async function api(body) {
  const response = await fetch('/api/analysis-notifications', body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000),
  } : { cache: 'no-store', signal: AbortSignal.timeout(15000) });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || '通知尚未送達，請重新啟用通知');
  return data;
}
const AnalysisNotificationControl = forwardRef(function AnalysisNotificationControl(_, ref) {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const pending = useRef(null);
  const revision = useRef(0);
  const asked = useRef(false);
  useImperativeHandle(ref, () => ({ prepare: () => prepare(true) }));
  useEffect(() => {
    let active = true;
    if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
      api().then(async data => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        if (active && revision.current === 0) setEnabled(data.subscribed && !!subscription && Notification.permission === 'granted');
      }).catch(() => {});
    }
    return () => { active = false; };
  }, []);
  function prepare(automatic = false) {
    if (pending.current) return pending.current;
    if (automatic && optedOut()) { setMessage('本裝置已關閉完成通知；本次分析仍會繼續。'); return Promise.resolve(); }
    // Start synchronously: iOS permission must retain the analysis-button gesture.
    const work = enable(automatic);
    pending.current = work;
    return work.finally(() => { pending.current = null; });
  }
  async function enable(automatic = false) {
    revision.current += 1;
    if (!('PushManager' in window) || !('Notification' in window)) {
      setMessage('此瀏覽器尚不支援背景推播。iPhone 請用 Safari 加入主畫面，再從圖示開啟。'); return;
    }
    setBusy(true);
    try {
      // Request permission directly inside the user gesture (required on iOS).
      let permission = Notification.permission;
      if (permission === 'default' && (!automatic || !asked.current)) {
        asked.current = true;
        permission = await Notification.requestPermission();
      }
      if (permission !== 'granted') throw new Error('尚未允許通知；若已封鎖，請在手機或瀏覽器設定開啟。');
      const data = await api();
      await bounded(navigator.serviceWorker.register('/sw.js'));
      const registration = await bounded(navigator.serviceWorker.ready);
      const raw = atob(data.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const applicationServerKey = Uint8Array.from(raw, c => c.charCodeAt(0));
      const subscription = await bounded(registration.pushManager.getSubscription())
        || await bounded(registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }));
      await api({ action: 'subscribe', subscription: subscription.toJSON() });
      rememberOff(false);
      setEnabled(true);
      setMessage('本裝置已啟用。請等畫面顯示「背景分析已開始」再離開；可先送測試通知。');
    } catch (error) { setEnabled(false); setMessage(`${error.message} 本次分析可繼續，但完成通知尚未就緒。`); }
    finally { setBusy(false); }
  }
  async function action(name) {
    setBusy(true);
    try {
      await api({ action: name });
      if (name === 'unsubscribe') {
        rememberOff(true);
        revision.current += 1;
        setEnabled(false);
        const registration = await navigator.serviceWorker.getRegistration('/');
        await (await registration?.pushManager.getSubscription())?.unsubscribe();
      }
      setMessage(name === 'test' ? '推播服務已接受測試通知，請確認手機是否收到。' : '本裝置通知已關閉。');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  return <section className="panel" aria-label="分析完成通知">
    <strong>分析完成通知：{enabled ? '本裝置已啟用' : '未啟用'}</strong>
    {message && <p role="status">{message}</p>}
    {!enabled ? <button disabled={busy} onClick={() => prepare()}>啟用分析完成通知</button> : <>
      <button disabled={busy} onClick={() => action('test')}>送出測試通知</button>
      <button disabled={busy} onClick={() => action('unsubscribe')}>關閉本裝置通知</button>
    </>}
  </section>;
});
export default AnalysisNotificationControl;
