import HistoryBrowser from './history-browser.js';
import ArchivePanel from './archive-panel.js';

export const metadata = { title: '歷史盤口｜Sports Analysis' };

export default function MarketLineHistoryPage() {
  return <HistoryBrowser><ArchivePanel/></HistoryBrowser>;
}
