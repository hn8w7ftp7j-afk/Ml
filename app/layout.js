import './globals.css';
import './security.css';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'MLB 長期正期望值分析',
  description: '私人 MLB 台灣信用盤長期正期望值分析系統',
  robots: { index: false, follow: false },
};

const modelGateScript = `
(() => {
  const modelVersion = '市場錨定穩健模型-2026-08-v5';
  const storageKey = 'mlb-positive-ev-v4';
  const markerKey = 'mlb-positive-ev-active-model';
  try {
    if (localStorage.getItem(markerKey) !== modelVersion) {
      const saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
      if (saved && typeof saved === 'object') {
        saved.analyses = {};
        saved.locks = [];
        localStorage.setItem(storageKey, JSON.stringify(saved));
      }
      localStorage.setItem(markerKey, modelVersion);
    }
  } catch {}

  const syncInterface = () => {
    document.querySelectorAll('.badge').forEach(element => {
      if (/第\\s*4\\.0\\.0\\s*版/.test(element.textContent || '')) element.textContent = '第 5.0.0 版';
    });
    document.querySelectorAll('.result').forEach(card => {
      if (!(card.textContent || '').includes('模型異常｜不下注')) return;
      const button = card.querySelector('button');
      if (button) {
        button.disabled = true;
        button.textContent = '已封鎖';
        button.title = '模型完整性檢查未通過，不可記錄為下注候選';
      }
    });
  };
  addEventListener('DOMContentLoaded', () => {
    setTimeout(syncInterface, 300);
    const observer = new MutationObserver(syncInterface);
    observer.observe(document.body, { childList: true, subtree: true });
  }, { once: true });
})();`;

export default function RootLayout({ children }) {
  return <html lang="zh-Hant"><head><script dangerouslySetInnerHTML={{ __html: modelGateScript }} /></head><body>{children}</body></html>;
}
