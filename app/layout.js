import './globals.css';

export const metadata = {
  title: 'MLB Positive EV',
  description: 'MLB 長期正 EV 盤口分析系統'
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
