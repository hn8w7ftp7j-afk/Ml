'use client';

import { useEffect, useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import styles from './raw-seen-replay.module.css';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const text = value => typeof value === 'string' && value.length > 0 && value.length <= 1000;
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const index = value => Number.isSafeInteger(value) && value >= 0;
const water = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000;
const time = value => value && instant(value) ? taipeiHistoryTime(value) : '未確認';
const periods = { FT: '全場', HT: '上半場', UNKNOWN: '時段未確認' };
const kinds = { HANDICAP: '讓球', TOTAL: '大小', MONEYLINE: '獨贏' };

export function validateRawSeenReplay(value, capture) {
  const invalid = () => { throw new Error('這批歷史盤口回應未通過核對，原始保存仍可查看。'); };
  if (!value || value.ok !== true || value.schema !== 'soccer-raw-seen-history-v1' || value.recordKind !== 'RAW_SEEN_REPLAY'
    || value.archiveOnly !== true || value.currentBoardUpdated !== false || value.historicalAvailabilityVerified !== false
    || value.executable !== false || value.coverageComplete !== false || value.closingCoverage !== 'NOT_VERIFIED'
    || value.integrity?.status !== 'VERIFIED' || value.integrity.batchHashVerified !== true
    || !['EPL', 'UCL'].includes(capture?.league) || !digest(capture?.captureId)
    || value.captureBatchId != null && !digest(value.captureBatchId)
    || capture.captureBatchId && value.captureBatchId !== capture.captureBatchId
    || value.observedAt !== capture.observedAt || !instant(value.observedAt)
    || value.pageActivityAt !== null && !instant(value.pageActivityAt)
    || !['receivedAt', 'persistedAt', 'recoveredAt'].every(key => instant(value[key]))
    || !text(value.derivationVersion) || !digest(value.derivedHash)
    || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > 8
    || !Array.isArray(value.games) || value.games.length > 40) invalid();
  const parts = new Set(), positions = new Set();
  for (const part of value.parts) {
    if (!digest(part?.captureId) || !digest(part.evidenceHash) || parts.has(part.captureId)
      || !index(part.partIndex) || positions.has(part.partIndex) || part.partCount !== value.parts.length
      || part.partIndex >= part.partCount || !instant(part.receivedAt) || !instant(part.persistedAt)) invalid();
    parts.add(part.captureId); positions.add(part.partIndex);
  }
  if (!parts.has(capture.captureId)) invalid();
  const games = new Set();
  for (const game of value.games) {
    if (game?.league !== capture.league || game.executable !== false
      || !date(game.boardDate)
      || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.boardTime || '')
      || !['awayRaw', 'homeRaw', 'awayKey', 'homeKey'].every(key => text(game[key]))
      || game.awayKey === game.homeKey || !Array.isArray(game.markets) || game.markets.length > 200) invalid();
    const gameKey = [game.boardDate, game.boardTime, game.awayKey, game.homeKey].join('|');
    if (games.has(gameKey)) invalid(); games.add(gameKey);
    for (const market of game.markets) {
      if (!Object.hasOwn(periods, market?.period) || !Object.hasOwn(kinds, market.kind) || market.unit !== 'GOALS'
        || market.executable === true || market.formalEligible === true
        || market.isAlternative != null && typeof market.isAlternative !== 'boolean'
        || !Array.isArray(market.rawRows) || !market.rawRows.length || market.rawRows.length > 3 || !market.rawRows.every(text)
        || !['tableIndex', 'rowIndex', 'columnIndex'].every(key => index(market.source?.[key]))) invalid();
      if (market.source.originalCell != null && (!Array.isArray(market.source.originalCell) || !market.source.originalCell.length
        || market.source.originalCell.length > 4096 || !market.source.originalCell.every(value => typeof value === 'string' && value.length <= 65536))) invalid();
      if (market.kind === 'HANDICAP' && (!text(market.line) || !['away', 'home'].includes(market.lineSide) || !water(market.awayWater) || !water(market.homeWater))) invalid();
      if (market.kind === 'TOTAL' && (!text(market.line) || !water(market.overWater) || !water(market.underWater))) invalid();
      if (market.kind === 'MONEYLINE' && (!water(market.homeWater) || !water(market.drawWater) || !water(market.awayWater))) invalid();
      if (market.periodEvidence != null && (!['UNKNOWN', 'HT', 'FT'].includes(market.periodEvidence.originalPeriod)
        || market.periodEvidence.displayPeriod !== market.period
        || market.periodEvidence.basis !== 'SAME_ROW_PRIMARY_AND_EXPLICIT_HT_COLUMNS')) invalid();
    }
  }
  return value;
}

export function rawSeenMarketText(market) {
  if (market.kind === 'HANDICAP') return `${market.lineSide === 'home' ? '主讓' : '客讓'}${market.line}｜客 ${market.awayWater}／主 ${market.homeWater}`;
  if (market.kind === 'TOTAL') return `大／小 ${market.line}｜大 ${market.overWater}／小 ${market.underWater}`;
  return `主 ${market.homeWater}／和 ${market.drawWater}／客 ${market.awayWater}`;
}

export function rawSeenSelectedGames(result, gameFilter) {
  if (!gameFilter) return result.games;
  const selected = result.games.filter(game => game.boardDate === gameFilter.boardDate
    && [game.boardTime, game.awayKey, game.homeKey].join('|') === gameFilter.gameKey);
  if (selected.length !== 1) throw new Error('這場對戰未通過來源核對，請重新查詢歷史索引。');
  return selected;
}

export default function RawSeenReplay({ capture, gameFilter }) {
  const [result, setResult] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef({ sequence: 0, controller: null, seed: capture.captureId });
  request.current.seed = capture.captureId;
  useEffect(() => {
    ++request.current.sequence; request.current.controller?.abort();
    setResult(null); setError(''); setBusy(false);
    return () => { ++request.current.sequence; request.current.controller?.abort(); };
  }, [capture.captureId, capture.league, gameFilter?.boardDate, gameFilter?.gameKey]);
  async function replay() {
    const sequence = ++request.current.sequence, seed = capture.captureId;
    request.current.controller?.abort();
    const controller = new AbortController(); request.current.controller = controller;
    const current = () => request.current.sequence === sequence && request.current.seed === seed;
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    setResult(null); setError(''); setBusy(true);
    try {
      const response = await fetch(`/api/soccer/raw-seen-history?captureId=${seed}`, { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const payload = await response.json();
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.code === 'RAW_SEEN_RECOVERY_UNSUPPORTED_FORMAT'
        ? '這批原文的表格格式尚未支援辨識，原始保存仍可查看；不能據此認定沒有盤口。'
        : '這批來源目前無法重播；片段或盤口仍待核對，原始保存可繼續查看。');
      const checked = validateRawSeenReplay(payload, capture);
      rawSeenSelectedGames(checked, gameFilter);
      if (current()) setResult(checked);
    } catch (cause) {
      if (current()) setError(cause.name === 'AbortError' ? '歷史盤口讀取逾時，請重試；原始保存仍保留。' : cause.message || '歷史盤口暫時無法讀取。');
    } finally { window.clearTimeout(timeout); if (current()) setBusy(false); }
  }
  if (!['EPL', 'UCL'].includes(capture.league)) return null;
  return <div className={styles.panel} aria-label="原始保存重播的歷史盤口" aria-busy={busy}>
    <button type="button" className="secondary" disabled={busy} onClick={replay}>{busy ? '核對整批歷史盤口…' : '重播歷史盤口'}</button>
    {error && <p role="alert" className={styles.error}>{error}</p>}
    {result && <section className={styles.result}>
      <h4>這批來源辨識出 {rawSeenSelectedGames(result, gameFilter).length} 場進球盤</h4>
      <p className={styles.notice}>以下由保存原文重新辨識，供歷史查閱，尚未核對官方場次。來源時間保持原值；未確認當時可分析資格或尾盤完整度。</p>
      <p className={styles.meta}>來源讀取 {time(result.observedAt)}｜頁面活動 {time(result.pageActivityAt)}<br/>接收 {time(result.receivedAt)}｜存入 {time(result.persistedAt)}<br/>本次重播 {time(result.recoveredAt)}</p>
      {result.games.length === 0 && <p className={styles.notice}>這批原文未辨識出可列示的進球市場，不能據此認定沒有開盤。</p>}
      {rawSeenSelectedGames(result, gameFilter).map(game => <article className={styles.game} key={[game.boardDate, game.boardTime, game.awayKey, game.homeKey].join('|')}>
        <h5>{game.boardDate} {game.boardTime}｜{game.awayRaw} → {game.homeRaw}</h5>
        {game.markets.length === 0 ? <p className={styles.notice}>此場沒有可列示的進球盤口。</p> : <div className={styles.tableWrap}><table>
          <caption>原盤盤口、水位與文字位置</caption>
          <thead><tr><th scope="col">市場</th><th scope="col">盤口與水位</th><th scope="col">來源文字</th><th scope="col">來源位置</th></tr></thead>
          <tbody>{game.markets.map((market, i) => <tr key={i}><th scope="row">{periods[market.period]} {kinds[market.kind]}{market.isAlternative === true && <small className={styles.interpreted}>替代盤線</small>}{market.periodEvidence?.originalPeriod === 'UNKNOWN' && market.period === 'FT' && <small className={styles.interpreted}>歷史辨識；原文未標全場</small>}</th><td>{rawSeenMarketText(market)}</td><td className={styles.raw}><small>{market.source.originalCell ? '保存原格' : '辨識用文字'}</small><br/>{(market.source.originalCell || market.rawRows).join('\n')}</td><td>表 {market.source.tableIndex + 1}／列 {market.source.rowIndex + 1}／欄 {market.source.columnIndex + 1}</td></tr>)}</tbody>
        </table></div>}
      </article>)}
      <details className={styles.sources}><summary>這次重播使用的原始保存片段</summary>
        <p className={styles.meta}>各片段及整批內容已核對；原文與重播結果分別保留識別。</p>
        <ol>{result.parts.map(part => <li key={part.captureId}><a href={`/api/reader/seen-captures?captureId=${part.captureId}`} target="_blank" rel="noreferrer">查看第 {part.partIndex + 1}／{part.partCount} 段原始保存</a><small>接收 {time(part.receivedAt)}｜存入 {time(part.persistedAt)}<br/>保存識別 {part.captureId}<br/>原文雜湊 {part.evidenceHash}</small></li>)}</ol>
        <p className={styles.meta}>重播版本 {result.derivationVersion}<br/>整批識別 {result.captureBatchId || '單筆來源'}<br/>重播內容識別 {result.derivedHash}</p>
      </details>
    </section>}
  </div>;
}
