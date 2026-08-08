'use client';
import { useEffect } from 'react';

export default function UiAuditFixes() {
  useEffect(() => {
    const setText = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
    const apply = () => {
      document.querySelectorAll('.badge').forEach(node => { if (node.textContent?.startsWith('v')) setText(node, 'v3.1.0'); });
      setText(document.querySelector('.header p'), '截圖辨識 → 盤口鎖定 → MLB 資料 → 實際開盤市場 EV → 下注績效');
      const success = document.querySelector('.success');
      if (success) {
        const markets = [...document.querySelectorAll('.market')];
        let openMarkets = 0, directions = 0;
        for (const market of markets) {
          const inputs = [...market.querySelectorAll('.direction input')];
          const picks = inputs.filter((_, index) => index % 2 === 0).map(input => input.value.trim()).filter(Boolean);
          if (picks.length) { openMarkets += 1; directions += picks.length; }
        }
        setText(success, openMarkets ? `✓ 已開 ${openMarkets} 個市場／${directions} 個方向；空白市場視為未開盤，可鎖定` : '目前沒有已開盤市場');
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return null;
}
