'use client';
import { useEffect, useState } from 'react';

async function api(body) {
  const response = await fetch('/api/analysis-notifications', body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(data.error || '通知尚未送達，請重新啟用通知');
  return data;
}
export default function AnalysisNotificationControl() {
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('iPhone 請先加入主畫面，再從主畫面開啟並啟用通知。');
  useEffect(() => {
    let active = true;
    if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
      api().then(async data => {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        if (active) setEnabled(data.subscribed && !!subscription && Notification.permission === 'granted');
      }).catch(() => {});
    }
    return () => { active = false; };
  }, []);
  async function enable() {
    if (!('PushManager' in window) || !('Notification' in window)) {
      setMessage('此瀏覽器尚不支援背景推播。iPhone 請用 Safari 加入主畫面，再從圖示開啟。'); return;
    }
    setBusy(true);
    try {
      // Request permission directly inside the user gesture (required on iOS).
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('尚未允許通知；若已封鎖，請在手機或瀏覽器設定開啟。');
      const data = await api();
      await navigator.serviceWorker.register('/sw.js');
      const registration = await navigator.serviceWorker.ready;
      const raw = atob(data.publicKey.replace(/-/g, '+').replace(/_/g, '/'));
      const applicationServerKey = Uint8Array.from(raw, c => c.charCodeAt(0));
      const subscription = await registration.pushManager.getSubscription()
        || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
      await api({ action: 'subscribe', subscription: subscription.toJSON() });
      setEnabled(true);
      setMessage('本裝置已啟用。請等畫面顯示「背景分析已開始」再離開；可先送測試通知。');
    } catch (error) { setMessage(error.message); }
    finally { setBusy(false); }
  }
  async function action(name) {
    setBusy(true);
    try {
      await api({ action: name });
      if (name === 'unsubscribe') {
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
    <p role="status">{message}</p>
    <p>背景分析完成後通知本裝置；部分失敗會如實標示。通知只含完成數量，不含盤口或下注金額。是否即時顯示仍受網路、勿擾模式與系統設定影響。</p>
    {!enabled ? <button disabled={busy} onClick={enable}>啟用分析完成通知</button> : <>
      <button disabled={busy} onClick={() => action('test')}>送出測試通知</button>
      <button disabled={busy} onClick={() => action('unsubscribe')}>關閉本裝置通知</button>
    </>}
  </section>;
}
