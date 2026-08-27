'use client';

import { useEffect, useState } from 'react';

function standaloneMode() {
  return window.matchMedia?.('(display-mode: standalone)').matches === true
    || window.navigator.standalone === true;
}

export default function PwaRegister() {
  const [visible, setVisible] = useState(false);
  const [instructions, setInstructions] = useState(false);
  const [installPrompt, setInstallPrompt] = useState(null);

  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    if (!standaloneMode() && sessionStorage.getItem('pwa-install-dismissed') !== '1') setVisible(true);
    const capturePrompt = event => {
      event.preventDefault();
      setInstallPrompt(event);
      setVisible(true);
    };
    window.addEventListener('beforeinstallprompt', capturePrompt);
    return () => window.removeEventListener('beforeinstallprompt', capturePrompt);
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

  if (!visible) return null;
  return <aside className="pwaInstall" aria-label="安裝棒球EV App">
    <div className="pwaInstallIcon" aria-hidden="true">EV</div>
    <div><strong>安裝成獨立 App</strong><span>{instructions ? 'iPhone：按下方分享圖示，再選「加入主畫面」' : '加入主畫面後，不顯示 Safari 上下工具列'}</span></div>
    <button className="pwaInstallButton" onClick={instructions ? dismiss : install}>{instructions ? '知道了' : '安裝'}</button>
    <button className="pwaInstallClose" aria-label="關閉安裝提示" onClick={dismiss}>×</button>
  </aside>;
}
