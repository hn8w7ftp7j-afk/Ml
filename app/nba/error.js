'use client';

import styles from './nba.module.css';

export default function NbaError({ reset }) {
  return <main className={styles.workspace} aria-label="NBA 資料載入錯誤"><h1>NBA 畫面暫時無法載入</h1><p>請重新開啟資料頁。已儲存的各聯盟資料仍會保留。</p><div className={styles.toolbar}><button type="button" onClick={reset}>重試 NBA</button><a href="/">返回網站</a></div></main>;
}
