import './globals.css';
import './security.css';
import UiAuditFixes from './ui-audit-fixes.js';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'MLB Positive EV',
  description: '私人 MLB 台灣信用盤分析系統',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return <html lang="zh-Hant"><body><UiAuditFixes/>{children}</body></html>;
}
