'use client';

import { useEffect, useRef, useState } from 'react';
import styles from './nba.module.css';

const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
const money = value => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)} 元` : '—';
const time = value => Number.isFinite(Date.parse(value || ''))
  ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(value)) : '—';
const seasonType = value => ({ preseason: '季前賽', regular: '例行賽', postseason: '季後賽' }[value] || '賽事類型待核對');
const direction = value => ({ over: '大分', under: '小分', none: '無方向', uncertain: '未定' }[value] || '未定');

function validResult(body, game, date, observedAt) {
  if (!body || body.league !== 'NBA' || body.modelVersion !== 'nba-total-pace-rest-v1'
    || body.gameId !== game.id || body.date !== date || body.observedAt !== observedAt
    || body.executable !== false || !['ready', 'insufficient', 'blocked'].includes(body.status)) return false;
  return body.status !== 'ready' || (body.prediction && body.assessment
    && ['home', 'away', 'baseTotal', 'total', 'correction'].every(key => typeof body.prediction[key] === 'number' && Number.isFinite(body.prediction[key])));
}

export default function NbaAnalysisPanel({ date, game, row, observedAt, validUntil, away, home }) {
  const [state, setState] = useState({ loading: false, result: null, error: '' });
  const [expired, setExpired] = useState(() => Date.now() >= validUntil);
  const active = useRef(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      setExpired(true);
      active.current?.abort();
      setState({ loading: false, result: null, error: '' });
    }, Math.max(0, validUntil - Date.now()));
    return () => { clearTimeout(timer); active.current?.abort(); active.current = null; };
  }, [validUntil]);

  async function analyze() {
    if (expired || Date.now() >= validUntil) { setExpired(true); return; }
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 55_000);
    setState({ loading: true, result: null, error: '' });
    try {
      const query = new URLSearchParams({ date, id: game.sourceId, observedAt });
      const response = await fetch(`/api/nba/analysis?${query}`, { cache: 'no-store', credentials: 'same-origin', signal: controller.signal });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(response.status === 401 ? '登入已過期，請重新登入。' : typeof body?.error === 'string' ? body.error : typeof body?.issues?.[0]?.message === 'string' ? body.issues[0].message : '全場大小分析失敗，請重新讀取盤口後重試。');
      if (!validResult(body, game, date, observedAt)) throw new Error('分析場次、盤口時間或回應格式不符，請重新讀取盤口。');
      if (!controller.signal.aborted && active.current === controller && Date.now() < validUntil) setState({ loading: false, result: body, error: '' });
    } catch (error) {
      if (active.current === controller && Date.now() < validUntil) setState({ loading: false, result: null, error: error.name === 'AbortError' ? '分析已中斷或逾時，可重試。' : error.message });
    } finally { clearTimeout(timer); }
  }

  if (expired || Date.now() >= validUntil) return <p className={styles.muted}>盤口已過期或比賽已開賽，請重新讀取盤口。</p>;
  const result = state.result;
  const training = result?.training;
  const assessment = result?.assessment;
  const prediction = result?.prediction;
  return <section aria-label="NBA 全場大小分析">
    <div className={styles.toolbar}><button type="button" disabled={state.loading} onClick={analyze}>{state.loading ? '全場大小分析中…' : result ? '重新分析全場大小' : '分析全場大小'}</button></div>
    {state.loading && <p className={styles.loading} role="status">正在核對此場盤口與賽前歷史資料…</p>}
    {state.error && <p className={styles.error} role="alert">{state.error}{state.error.includes('登入') && <a href="/login?next=/nba">重新登入</a>}</p>}
    {result?.status === 'insufficient' && <div className={styles.sourceStatus} role="status"><div><strong>此場資料不足，尚無分析方向</strong><span>{training?.seasonYear ? `${training.seasonYear - 1}–${String(training.seasonYear).slice(-2)} ` : ''}{seasonType(training?.seasonType || game.seasonType)}・可用 {training?.availableGames ?? 0} 場・至少需要 {training?.minimumResiduals ?? 50} 筆校正樣本</span></div><p>只使用同球季、同賽事類型的賽前歷史；不以其他球季例行賽填補季前賽。</p></div>}
    {result?.status === 'blocked' && <p className={styles.error} role="alert">此場分析已被資料核對阻擋，請重新讀取盤口。</p>}
    {result?.status === 'ready' && <>
      <h3>全場大小・節奏與休息修正</h3>
      <dl className={styles.metrics}>
        <div><dt>原比分總分</dt><dd>{number(prediction.baseTotal)}</dd></div>
        <div><dt>校正後總分</dt><dd>{number(prediction.total)}</dd></div>
        <div><dt>目前盤口</dt><dd>{row.fullTotal.line}</dd></div>
        <div><dt>參考方向</dt><dd>{direction(assessment.direction)}</dd></div>
      </dl>
      <p className={styles.muted}>原比分：{away}（客）{number(prediction.away)}、{home}（主）{number(prediction.home)}。總分修正 {prediction.correction > 0 ? '+' : ''}{number(prediction.correction)}；各隊原比分保留。</p>
      <dl className={styles.stats}>
        <div><dt>大分・每 100 元歷史估計淨額</dt><dd>{money(assessment.positiveExpectedNet)}</dd></div>
        <div><dt>小分・每 100 元歷史估計淨額</dt><dd>{money(assessment.negativeExpectedNet)}</dd></div>
        <div><dt>歷史節奏估計</dt><dd>{number(assessment.paceProxy?.estimatedPace)}</dd></div>
      </dl>
      <p className={styles.muted}>以上是歷史分布試算，尚未驗證為賽前 EV，也不是此場的已驗證勝率；目前不開放下注執行。</p>
      <details><summary>查看節奏、休息與資料截止</summary>
        {[['away', away], ['home', home]].map(([side, name]) => <p key={side}>{name}：歷史節奏 {number(assessment.paceProxy?.[side]?.mean)}（{assessment.paceProxy?.[side]?.count ?? 0} 場，截止 {assessment.paceProxy?.[side]?.through || '未取得'}）；前場日期 {assessment.restProxy?.[side]?.priorDate || '未取得'}，比賽日間隔 {assessment.restProxy?.[side]?.gapDays ?? '—'} 天。</p>)}
        <p>比賽日間隔依已保存賽程推算，不能視為完整官方休息天數。傷停與陣容尚未納入此修正。</p>
        <p>校正 {assessment.calibrationSamples ?? 0} 筆・截止 {assessment.calibrationThrough || '未取得'}；分布 {assessment.distributionSamples ?? 0} 筆・截止 {assessment.distributionThrough || '未取得'}。</p>
        <p>盤口時間 {time(observedAt)}（台灣）・分析時間 {time(result.generatedAt)}（台灣）。盤口更新、過期或開賽後，本次結果會清除。</p>
      </details>
    </>}
    {Array.isArray(result?.issues) && result.issues.length > 0 && <ul className={styles.issues}>{result.issues.map((issue, index) => <li key={`${issue.code}:${index}`}>{issue.message}</li>)}</ul>}
  </section>;
}
