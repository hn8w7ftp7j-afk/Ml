import './globals.css';
import './security.css';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: 'MLB 長期正期望值分析｜固定雙EV短板聯合情境模型',
  description: '私人 MLB 台灣信用盤長期正期望值分析系統：實際開盤、逐腿結算、加權EV、穩健EV、固定可重現評分',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
