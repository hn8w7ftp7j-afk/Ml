export default function manifest() {
  return {
    id: '/',
    name: '棒球 EV｜盤口與下注系統',
    short_name: '棒球 EV',
    description: 'MLB、NPB、KBO、CPBL 台灣信用盤分析與實際下注紀錄',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#06111d',
    theme_color: '#06111d',
    lang: 'zh-Hant',
    categories: ['sports', 'utilities'],
    icons: [
      { src: '/icons/app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/app-icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
