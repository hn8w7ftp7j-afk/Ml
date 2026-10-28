'use client';

import styles from './nba.module.css';

// The data workspace shares the main board's model validation, job recovery and
// S presentation. Do not retain a second client contract for the retired model.
export default function NbaAnalysisPanel({ date }) {
  const href = `/?${new URLSearchParams({ sport: 'NBA', date })}`;
  return <section aria-label="NBA 盤口分析入口">
    <div className={styles.toolbar}><a className="secondary" href={href}>前往 NBA 盤口分析</a></div>
    <p className={styles.muted}>全場與上半場的讓分、大小分及 S 評分，統一由 NBA 盤口分析核對與顯示。</p>
  </section>;
}
