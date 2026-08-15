import './globals.css';
import './security.css';

export const dynamic = 'force-dynamic';
export const metadata = {
  title: '棒球長期正期望值分析｜MLB・NPB・KBO・CPBL',
  description: '私人多聯盟台灣信用盤長期正期望值分析系統：各聯盟獨立資料、模型、排名與下注識別',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return <html lang="zh-Hant"><body>{children}</body></html>;
}
