import './globals.css';
import './security.css';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'MLB 長期正期望值分析',
  description: '私人 MLB 台灣信用盤長期正期望值分析系統',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
