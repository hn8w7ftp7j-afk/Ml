'use client';
import styles from './nba.module.css';
const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : '—';
export default function OnOffPanel({ report, players = [] }) {
  return <section className={styles.panel} aria-label="逐事件 On/Off 研究">
    <h2>球員 On/Off・賽後逐事件研究</h2>
    <p>依實際先發、換人與比分事件重建場上／場下得失分。罰球得失分歸屬造成罰球的犯規當下陣容，出場時間仍依實際換人計算。這是描述性研究，不是官方 On/Off、球員因果貢獻或賽前預測，尚未加入 Shadow 模型。</p>
    <p>獨立 QA：{report?.qa?.status || '待取得'}・{report?.status === 'ready' ? '重建完成' : '等待可完整核對的逐事件資料'}</p>
    {report?.qa?.issues?.map((message, index) => <p key={index} className={report.qa.status === 'BLOCK' ? styles.error : styles.muted}>{message}</p>)}
    {report?.status === 'ready' && <>
      <p>{report.events} 筆事件・{report.substitutions} 次換人・比賽時間 {number(report.durationSeconds / 60)} 分鐘</p>
      <details><summary>罰球歸屬核對（{report.freeThrowAttributions?.length || 0} 筆）</summary>{report.freeThrowAttributions?.map(row => <p className={styles.mono} key={row.eventId}>事件 {row.eventId} → 犯規 {row.foulEventId}・第 {row.attempt}/{row.total} 罰・得分 {row.points}</p>)}</details>
      <div className={styles.playerGrid}>{report.players.map(row => <article className={styles.player} key={row.playerId}>
        <strong>{players.find(player => player.id === row.playerId)?.name || row.playerId}</strong>
        <p>在場 {number(row.onSeconds / 60)} 分鐘・不在場 {number(row.offSeconds / 60)} 分鐘</p>
        <p>在場得／失分 {row.onPointsFor}／{row.onPointsAgainst}・淨分 {row.plusMinus}</p>
        <p>不在場得／失分 {row.offPointsFor}／{row.offPointsAgainst}</p>
        <p>每 48 分鐘淨分：在場 {number(row.onNetPer48)}・不在場 {number(row.offNetPer48)}</p>
        <small>{row.plusMinusVerified ? '正負值已與 box score 交叉核對' : '正負值缺少獨立欄位可核對'}</small>
      </article>)}</div>
      <p className={styles.muted}>每 48 分鐘不是每 100 回合；未估造球員回合數。沒有在場／不在場時間時，不產生該項比率。</p>
    </>}
    {report?.source && <details><summary>逐事件來源追溯</summary><p className={styles.mono}>{report.source.url}</p><p>取得時間 {report.source.fetchedAt}・來源發布 {report.source.publishedAt || '未提供'}</p><p className={styles.mono}>SHA-256 {report.source.hash}</p></details>}
  </section>;
}
