'use client';
import { useEffect, useReducer } from 'react';
import { cancelNbaShadow, nbaShadowIsBusy, nbaShadowKey, readNbaShadow, runNbaShadow, subscribeNbaShadow } from '../../lib/nba/shadow-client.js';
import styles from './nba.module.css';
const number = value => Number.isFinite(value) ? value.toLocaleString('zh-TW', { maximumFractionDigits: 2 }) : '—';
const labels = { running: '讀取與驗證中', completed: '研究已完成', partial: '部分資料未取得', cancelled: '已停止', blocked: 'QA 阻擋', failed: '執行失敗' };

export default function ShadowPanel({ games, teamId, seasonType }) {
  const [, refresh] = useReducer(n => n + 1, 0);
  useEffect(() => subscribeNbaShadow(refresh), []);
  const key = nbaShadowKey(games, teamId, seasonType);
  const job = readNbaShadow(key); const report = job?.report;
  const running = job?.status === 'running';
  return <section className={styles.panel} aria-label="籃球 Shadow 模型研究">
    <div className={styles.sectionHead}><h2>回合數 × 效率・Shadow 研究</h2><span className={styles.badge}>歷史驗證專用</span></div>
    <p>逐場取得本球季真實 box score，使用 Pace、攻防效率、近五場狀態、主客場、休息日、背靠背、賽程密度與可取得的對手歷史特徵。只評估已完賽資料。</p>
    <p className={styles.muted}>一個球季需逐場讀取，可能花數分鐘。切換 NBA 頁籤或返回原聯盟不會中斷；關閉／重新整理整個瀏覽器頁面會停止尚未完成的讀取，完成報告則保留於此分頁。</p>
    <div className={styles.toolbar}><button type="button" disabled={!games.length || nbaShadowIsBusy()} onClick={() => { void runNbaShadow(games, teamId, seasonType); }}>{job ? '重新執行歷史驗證' : '執行籃球 Shadow 驗證'}</button>{running && <button type="button" onClick={() => cancelNbaShadow(key)}>停止讀取</button>}{nbaShadowIsBusy() && !running && <span>另一份 NBA 研究正在執行，完成後可開始。</span>}</div>
    {job && <p role="status">{labels[job.status] || job.status}・已處理 {job.completed}／{job.total} 場・來源失敗 {job.errors.length} 場</p>}
    {job?.persistence === 'memory_only' && <p role="alert" className={styles.error}>瀏覽器儲存空間不足或禁止儲存；結果目前只保留在這個頁面的記憶體，重新整理會遺失。其他聯盟資料未刪除。</p>}
    {report && <>
      <p className={styles.muted}>報告完成時間：{job.reportBuiltAt || '未完成'}{running || job.status === 'cancelled' ? '（目前保留上次報告，並非本次尚未完成的結果）' : ''}</p>
      <p>研究狀態：{report.status}・QA {report.qa.status}・完整 box score {report.counts.features} 場・缺漏 {report.counts.missing} 場・驗證 {report.counts.validation} 場</p>
      <dl className={styles.metrics}><div><dt>平均估算 Pace</dt><dd>{number(report.featureSummary?.meanPace)}</dd></div><div><dt>模型得分 MAE</dt><dd>{number(report.validation?.mae)}</dd></div><div><dt>同場基準 MAE</dt><dd>{number(report.validation?.baselineSameFolds?.mae)}</dd></div><div><dt>模型得分 RMSE</dt><dd>{number(report.validation?.rmse)}</dd></div></dl>
      <p className={styles.muted}>模型與基準比較使用相同驗證場次；表現較差也照實顯示。資料太少時不產生誤差數字。</p>
      <p>{report.researchVerdict === 'not_better_than_baseline' ? '驗證結論：本樣本未優於簡單基準，維持研究用途。' : report.researchVerdict === 'lower_mae_in_this_sample_only' ? '驗證結論：僅本樣本 MAE 較低，尚不能宣稱具備未來預測能力。' : '驗證結論：有效樣本不足。'}</p>
      <details><summary>聯合誤差、區間涵蓋率與驗證方法</summary><p>三個 log-scale 目標（回合數、己方效率、對手效率）使用相同較早日期資料。正則化參數由內層時間切分選擇；資料不足時使用事先宣告的 λ=1。這不是封頂或分數調整。</p><p>每一場兩隊得分誤差保留成對關係；區間只用更早日期的歷史誤差建立。</p>
        {report.validation?.jointCoverage?.map(row => <p key={row.nominal}>標稱 {row.nominal * 100}% 聯合區間：實測 {row.observed === null ? '樣本不足' : `${number(row.observed * 100)}%`}，{row.samples} 場，平均寬度 {number(row.meanWidth)} 分。</p>)}
        <p>成對誤差共變異數：{report.validation?.pairedResidualCovariance ? report.validation.pairedResidualCovariance.map(row => row.map(number).join(' / ')).join('；') : '樣本不足'}</p>
        {report.limitations.map(text => <p key={text}>{text}</p>)}
        <p className={styles.mono}>{report.version}</p>
      </details>
      <details><summary>逐次訓練截止日與 QA</summary>{report.folds.map(row => <p key={row.gameId}>{row.date}：只訓練至 {row.trainingThrough}，{row.trainingRows} 筆，λ={row.lambda}。</p>)}{report.qa.issues.map((row, i) => <p key={i}>{row.severity}・{row.message}</p>)}{report.excluded.map(row => <p key={row.gameId}>{row.gameId}・{row.reason}</p>)}</details>
    </>}
    {!!job?.errors.length && <details><summary>資料讀取失敗明細</summary>{job.errors.map((row, i) => <p key={i}>{row.gameId || ''}・{row.message}</p>)}</details>}
    {!!job?.sources.length && <details><summary>歷史 box score 來源追溯</summary>{job.sources.map((row, i) => <p className={styles.mono} key={i}>{row.gameId}・取得 {row.fetchedAt}・來源發布 {row.publishedAt || '未提供'}・SHA-256 {row.hash || '未提供'}</p>)}</details>}
  </section>;
}
