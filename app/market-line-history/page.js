import HistoryBrowser from './history-browser.js';
import ArchivePanel from './archive-panel.js';
import RawSeenHistoryIndexPanel from './raw-seen-history-index-panel.js';
import RawHistoryMaintenancePanel from './raw-history-maintenance-panel.js';

export const metadata = { title: '歷史盤口｜Sports Analysis' };

export default function MarketLineHistoryPage() {
  return <HistoryBrowser><RawHistoryMaintenancePanel/><RawSeenHistoryIndexPanel/><ArchivePanel/></HistoryBrowser>;
}
