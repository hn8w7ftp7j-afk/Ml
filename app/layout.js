import './globals.css';
import './security.css';
import './ledger.css';
import PwaRegister from './pwa-register.js';

export const dynamic = 'force-dynamic';
export const viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#06111d',
};
export const metadata = {
  title: '棒球長期正期望值分析｜MLB・NPB・KBO・CPBL',
  description: '私人多聯盟台灣信用盤長期正期望值分析系統：各聯盟獨立資料、模型、排名與下注識別',
  applicationName: '棒球 EV',
  manifest: '/manifest.webmanifest',
  appleWebApp: { capable: true, title: '棒球 EV', statusBarStyle: 'black-translucent' },
  formatDetection: { telephone: false },
  icons: {
    icon: [
      { url: '/icons/app-icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/icons/app-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }],
  },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return <html lang="zh-Hant"><body>{children}<PwaRegister/></body></html>;
}
