'use client';
import { useState } from 'react';
import styles from './nba.module.css';
export default function VerifiedResearchPanel() {
  const [result, setResult] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function load() {
    setBusy(true); setError('');
    try { const response = await fetch('/api/nba/research', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) }); const body = await response.json(); if (!response.ok || body.league !== 'NBA') throw new Error('無法取得實測報告'); setResult(body); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const r = result?.research; const n = v => Number.isFinite(v) ? v.toFixed(2) : '—';
  return <section className={styles.panel} aria-label="已完成 NBA 歷史實測"><h2>已保存的完整球季實測</h2><p>固定樣本：克里夫蘭騎士 2025–26 例行賽。不是目前選擇球隊的報告，也不是全聯盟校準。</p><button disabled={busy} onClick={load}>{busy ? '讀取中…' : '查看 82 場實測結果'}</button>{error && <p role="alert">{error}</p>}{r && <><p>完整資料 {r.counts.features}/{r.counts.input} 場・逐時驗證 {r.counts.validation} 場・来源失敗 {result.failures.length} 場</p><p>模型 MAE {n(r.validation?.mae)}・同場基準 MAE {n(r.validation?.baselineSameFolds?.mae)}・模型 RMSE {n(r.validation?.rmse)}</p><p>結論：{r.researchVerdict === 'not_better_than_baseline' ? '未優於簡單基準，不升級模型。' : '僅此样本結果，不能證明未來能力。'}</p>{r.validation?.jointCoverage.map(row => <p key={row.nominal}>{row.nominal * 100}% 聯合區間：實測 {n(row.observed * 100)}%，{row.samples} 場。</p>)}<p>這是得分點估計與區間涵蓋率；未提供機率預測，因此沒有偽造 Brier Score 或 Log Loss。尚未完成跨隊、跨球季與賽前完整特徵驗證。</p><p>取得完成時間：{result.generatedAt}</p></>}</section>;
}
