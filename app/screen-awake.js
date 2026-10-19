'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import { createScreenAwake } from '../lib/screen-awake.js';

const LABELS = {
  active: '螢幕保持亮起中・操作後延長 5 分鐘',
  pending: '正在啟用螢幕常亮…',
  idle: '螢幕常亮已到期或暫停・操作可重新啟用',
  paused: '螢幕常亮已關閉',
  blocked: '手機未允許螢幕常亮・請檢查省電模式或重試',
  unsupported: '此瀏覽器不支援螢幕常亮・請使用新版 Safari 或 Chrome',
};

export default function ScreenAwake() {
  const pathname = usePathname();
  const controller = useRef(null);
  const [status, setStatus] = useState(null);
  const enabled = Boolean(pathname) && pathname !== '/login';
  useEffect(() => {
    if (!enabled) return;
    const current = createScreenAwake({ doc: document, nav: navigator, onStatus: setStatus });
    controller.current = current;
    const activity = event => {
      // The control itself owns pause/resume; document capture must not undo it.
      if (!event.target?.closest?.('[data-screen-awake]')) current.renew();
    };
    document.addEventListener('pointerdown', activity, { passive: true });
    document.addEventListener('keydown', activity);
    document.addEventListener('visibilitychange', current.visibility);
    window.addEventListener('pageshow', current.visibility);
    window.addEventListener('pagehide', current.suspend);
    current.renew();
    return () => {
      document.removeEventListener('pointerdown', activity);
      document.removeEventListener('keydown', activity);
      document.removeEventListener('visibilitychange', current.visibility);
      window.removeEventListener('pageshow', current.visibility);
      window.removeEventListener('pagehide', current.suspend);
      current.dispose();
      controller.current = null;
    };
  }, [enabled]);
  if (!enabled || !status) return null;
  const active = status === 'active' || status === 'pending';
  return <aside data-screen-awake className="screen-awake" aria-label="螢幕常亮設定">
    <span role="status">{LABELS[status]}</span>
    {status !== 'unsupported' && <button type="button" onClick={() => active ? controller.current?.pause() : controller.current?.resume()}>
      {active ? '關閉常亮' : '亮屏 5 分鐘'}
    </button>}
  </aside>;
}
