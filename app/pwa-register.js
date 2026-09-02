'use client';

import { useEffect, useRef, useState } from 'react';
import { APP_VERSION } from '../lib/app-version.js';

const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const SERVICE_WORKER_UPDATE_TIMEOUT_MS = 8000;
const UPDATE_ATTEMPT_KEY = 'pwa-update-attempt-version';
const APP_OPERATION_BUSY_KEY = 'sports-positive-ev-operation-busy';

function standaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.navigator.standalone === true;
}

function updateServiceWorker(registration) {
  if (!registration?.update) return Promise.resolve();
  let timer;
  return Promise.race([
    registration.update(),
    new Promise(resolve => { timer = window.setTimeout(resolve, SERVICE_WORKER_UPDATE_TIMEOUT_MS); }),
  ]).finally(() => window.clearTimeout(timer));
}

export default function PwaRegister() {
  const [visible, setVisible] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);
  const [updating, setUpdating] = useState(false);
  const updateCheckRunning = useRef(false);

  useEffect(() => {
    let active = true;
    let registration;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then(value => {
        registration = value;
        return updateServiceWorker(registration);
      }).catch(() => {});
    }

    async function checkForUpdate() {
      if (!active || updateCheckRunning.current) return;
      updateCheckRunning.current = true;
      try {
        await updateServiceWorker(registration);
        const response = await fetch(`/api/health?t=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) return;
        const latest = await response.json();
        if (!latest?.version || latest.version === APP_VERSION) {
          sessionStorage.removeItem(UPDATE_ATTEMPT_KEY);
          return;
        }
        // Do not reload between a durable job request and saving its runId.
        // The next visibility/interval check will apply the update safely.
        const operationStartedAt = Number(sessionStorage.getItem(APP_OPERATION_BUSY_KEY));
        if (Number.isFinite(operationStartedAt) && Date.now() - operationStartedAt < 15 * 60 * 1000) return;
        sessionStorage.removeItem(APP_OPERATION_BUSY_KEY);
        if (sessionStorage.getItem(UPDATE_ATTEMPT_KEY) === latest.version) return;
        sessionStorage.setItem(UPDATE_ATTEMPT_KEY, latest.version);
        setUpdating(true);
        window.setTimeout(() => {
          // Re-check at the exact reload boundary: an analysis or bet action may
          // have started during the short update notice animation.
          const reloadOperationStartedAt = Number(sessionStorage.getItem(APP_OPERATION_BUSY_KEY));
          if (Number.isFinite(reloadOperationStartedAt)
            && Date.now() - reloadOperationStartedAt < 15 * 60 * 1000) {
            sessionStorage.removeItem(UPDATE_ATTEMPT_KEY);
            setUpdating(false);
            return;
          }
          window.location.reload();
        }, 650);
      } catch {
        // Keep the current working version when the device is temporarily offline.
      } finally {
        updateCheckRunning.current = false;
      }
    }

    const capturePrompt = event => {
      if (standaloneMode() || window.location.pathname === '/login') return;
      event.preventDefault();
      if (sessionStorage.getItem('pwa-install-dismissed') === '1') return;
      setInstallPrompt(event);
      setVisible(true);
    };
    const checkWhenVisible = () => {
      if (document.visibilityState === 'visible') checkForUpdate();
    };
    window.addEventListener('beforeinstallprompt', capturePrompt);
    window.addEventListener('pageshow', checkForUpdate);
    document.addEventListener('visibilitychange', checkWhenVisible);
    const initialCheck = window.setTimeout(checkForUpdate, 1200);
    const periodicCheck = window.setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
    return () => {
      active = false;
      window.clearTimeout(initialCheck);
      window.clearInterval(periodicCheck);
      window.removeEventListener('beforeinstallprompt', capturePrompt);
      window.removeEventListener('pageshow', checkForUpdate);
      document.removeEventListener('visibilitychange', checkWhenVisible);
    };
  }, []);

  async function install() {
    if (!installPrompt) {
      setInstructions(true);
      return;
    }
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice?.outcome === 'accepted') setVisible(false);
    setInstallPrompt(null);
  }

  function dismiss() {
    sessionStorage.setItem('pwa-install-dismissed', '1');
    setVisible(false);
  }

  if (!visible && !updating) return null;
  return <>
    {updating && <div className="pwaUpdating" role="status">新版已上線，正在自動更新…</div>}
    {visible && <aside className="pwaInstall" aria-label="安裝棒球EV App">
      <div className="pwaInstallIcon" aria-hidden="true">EV</div>
      <div><strong>安裝成獨立 App</strong><span>{instructions ? 'iPhone：按下方分享圖示，再選「加入主畫面」' : '加入主畫面後，不顯示 Safari 上下工具列'}</span></div>
      <button className="pwaInstallButton" onClick={instructions ? dismiss : install}>{instructions ? '知道了' : '安裝'}</button>
      <button className="pwaInstallClose" aria-label="關閉安裝提示" onClick={dismiss}>×</button>
    </aside>}
  </>;
}
