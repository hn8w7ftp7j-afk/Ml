'use client';

import { useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import { useHistoryAuditRequest } from './history-audit-request.js';
import { auditDay, auditInstant, auditHash, auditInteger, auditCode, auditReadonly } from './history-audit-validation.js';
import styles from './history-audit.module.css';

const endpoint = '/api/soccer/raw-market-coverage';
const leagueNames = { EPL: '英超 EPL', UCL: '歐冠 UCL' };
const cellLabels = [['FT:HANDICAP', '全場讓球'], ['FT:TOTAL', '全場大小'], ['HT:HANDICAP', '上半場讓球'], ['HT:TOTAL', '上半場大小']];
const linePattern = /^(\d+(?:\.\d+)?)(?:平|[+-]\d{1,3})?$/;
const sourceColumns = { primary: { 'FT:HANDICAP': 3, 'FT:TOTAL': 4, 'HT:HANDICAP': 6, 'HT:TOTAL': 7 },
  alternative: { 'FT:HANDICAP': 2, 'FT:TOTAL': 3, 'HT:HANDICAP': 4, 'HT:TOTAL': 5 } };
const flags = { archiveOnly: true, currentBoardUpdated: false, historicalAvailabilityVerified: false,
  executable: false, formalEligible: false, calibrationEligible: false, coverageComplete: false,
  closingCoverage: 'NOT_VERIFIED', completeHistory: false, identityVerified: false, simultaneousCoverageVerified: false };
const leagueAllowed = value => typeof value === 'string' && Object.hasOwn(leagueNames, value);
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const nullableTime = value => value === null || auditInstant(value);
const water = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1000;
const partialReadonly = value => auditReadonly(value, flags, false);
const exactTime = value => value.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(6, '0')}Z`);

export function rawMarketCoverageToday(now = Date.now()) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export function validateRawMarketCoverage(value, scope) {
  const invalid = () => { throw new Error('原始盤口逐場核對未通過驗證'); };
  if (!leagueAllowed(scope?.league) || !auditDay(scope.date) || value?.ok !== true
    || value.schema !== 'soccer-raw-market-coverage-v1' || value.league !== scope.league || value.date !== scope.date
    || !auditReadonly(value, flags) || !auditInstant(value.until) || !['WITNESSES_FOUND', 'PARTIAL', 'UNKNOWN'].includes(value.status)
    || !value.schedule || !auditHash(value.schedule.fingerprint) || !auditInteger(value.schedule.officialGameCount)
    || value.schedule.officialGameCount > 100 || value.schedule.sourceScope !== 'RETURNED_PROVIDER_PAGES_ONLY'
    || value.schedule.providerCompletenessVerified !== false || !partialReadonly(value.schedule)
    || !Array.isArray(value.games) || value.games.length !== value.schedule.officialGameCount
    || !Array.isArray(value.sources) || value.sources.length > 8 || !Array.isArray(value.reasonCodes) || value.reasonCodes.length > 100 || !value.reasonCodes.every(auditCode)) invalid();
  const inventory = value.inventory, budget = value.budget;
  if (!inventory || inventory.status !== 'READ' || !partialReadonly(inventory)
    || !auditInteger(inventory.candidateRows) || inventory.candidateRows > 200 || !auditInteger(inventory.matchedGameCount)
    || !auditInteger(inventory.unmatchedCandidates) || typeof inventory.candidatesTruncated !== 'boolean' || typeof inventory.candidateScanComplete !== 'boolean'
    || inventory.candidateScanComplete === inventory.candidatesTruncated
    || inventory.matchedGameCount > value.games.length || inventory.unmatchedCandidates > inventory.candidateRows
    || !budget || !partialReadonly(budget) || !auditInteger(budget.maxBatchReads) || budget.maxBatchReads < 1 || budget.maxBatchReads > 8 || !auditInteger(budget.batchReads)
    || budget.batchReads > budget.maxBatchReads || value.sources.length > budget.batchReads
    || !auditInteger(budget.sourceBytesReserved) || !auditInteger(budget.sourceBytesRead)
    || !auditInteger(budget.maxMetadataBytes) || budget.maxMetadataBytes < 1 || budget.maxMetadataBytes > 2097152
    || !auditInteger(budget.metadataBytesRead) || budget.metadataBytesRead > budget.maxMetadataBytes
    || budget.metadataByteBasis !== 'SERIALIZED_CANDIDATE_ROWS_JSONB_TEXT'
    || budget.sourceBytesRead > budget.sourceBytesReserved || !auditInteger(budget.maxSourceBytes) || budget.maxSourceBytes < 1 || budget.maxSourceBytes > 10485760
    || budget.sourceBytesReserved > budget.maxSourceBytes || !auditInteger(budget.timeBudgetMs) || budget.timeBudgetMs < 1 || budget.timeBudgetMs > 25000
    || budget.budgetKind !== 'SOFT_DEADLINE' || budget.hardDeadlineEnforced !== false) invalid();
  const batches = new Map(), captureIds = new Set();
  for (const source of value.sources) {
    if (!source || !partialReadonly(source) || !auditHash(source.captureId) || !auditHash(source.batchHash)
      || captureIds.has(source.captureId) || batches.has(source.batchHash) || !['VERIFIED', 'UNKNOWN'].includes(source.status)
      || !nullableTime(source.observedAt) || !nullableTime(source.receivedAt) || !nullableTime(source.persistedAt)
      || !Array.isArray(source.fragments) || source.fragments.length > 8) invalid();
    if (source.status === 'VERIFIED' && (!auditHash(source.derivedHash) || source.reason !== null || !source.observedAt
      || !source.receivedAt || !source.persistedAt || source.fragments.length < 1)) invalid();
    if (source.status === 'UNKNOWN' && (source.derivedHash !== null || !auditCode(source.reason) || source.fragments.length !== 0
      || source.observedAt !== null || source.receivedAt !== null || source.persistedAt !== null)) invalid();
    const fragments = new Set(), partIndexes = new Set();
    for (const fragment of source.fragments) {
      if (!fragment || !partialReadonly(fragment) || !auditHash(fragment.captureId) || fragments.has(fragment.captureId)
        || !auditHash(fragment.evidenceHash) || !auditInstant(fragment.receivedAt) || !auditInstant(fragment.persistedAt)
        || !auditInteger(fragment.partIndex) || !auditInteger(fragment.partCount) || fragment.partCount < 1 || fragment.partCount > 8
        || fragment.partIndex >= fragment.partCount || fragment.partCount !== source.fragments.length || partIndexes.has(fragment.partIndex)) invalid();
      fragments.add(fragment.captureId); partIndexes.add(fragment.partIndex);
    }
    if (source.status === 'VERIFIED' && (!fragments.has(source.captureId) || value.budget.sourceBytesRead < 1
      || value.inventory.candidateRows < 1 || value.budget.metadataBytesRead < 1
      || ['observedAt', 'receivedAt', 'persistedAt'].some(field => exactTime(source[field]) > exactTime(value.until))
      || ['receivedAt', 'persistedAt'].some(field => source.fragments.map(fragment => exactTime(fragment[field])).sort().at(-1) !== exactTime(source[field])))) invalid();
    batches.set(source.batchHash, source); captureIds.add(source.captureId);
  }
  const gameIds = new Set();
  for (const game of value.games) {
    if (!game || !partialReadonly(game) || !new RegExp(`^soccer:${scope.league.toLowerCase()}:\\d{1,16}$`).test(game.gameId || '')
      || gameIds.has(game.gameId) || !text(game.label, 300) || !auditInstant(game.startTime) || !text(game.status, 50)
      || game.identityBasis !== 'DISPLAY_MATCH_TO_CURRENT_PROVIDER_SCHEDULE'
      || !Array.isArray(game.rawGameKeys) || game.rawGameKeys.length > 320 || !game.rawGameKeys.every(auditHash)
      || new Set(game.rawGameKeys).size !== game.rawGameKeys.length
      || game.witnessStatus === 'NOT_CHECKED' && game.rawGameKeys.length !== 0
      || !['FOUR_CELLS_WITNESSED', 'PARTIAL', 'NOT_CHECKED'].includes(game.witnessStatus)
      || !game.cells || Object.keys(game.cells).length !== 4) invalid();
    gameIds.add(game.gameId);
    for (const [key] of cellLabels) {
      const cell = game.cells[key], [period, kind] = key.split(':');
      if (!cell || !partialReadonly(cell) || !['WITNESSED', 'NOT_WITNESSED', 'NOT_CHECKED'].includes(cell.status)
        || !Array.isArray(cell.witnesses) || cell.witnesses.length > 2
        || (cell.status === 'WITNESSED' ? cell.witnesses.length < 1 : cell.witnesses.length !== 0)) invalid();
      for (const quote of cell.witnesses) {
        const source = batches.get(quote?.batchHash);
        if (!quote || quote.gameId !== game.gameId || !auditHash(quote.rawGameKey) || !game.rawGameKeys.includes(quote.rawGameKey) || !partialReadonly(quote) || !source || source.status !== 'VERIFIED' || quote.derivedHash !== source.derivedHash
          || typeof quote.isAlternative !== 'boolean' || quote.period !== period || quote.kind !== kind || quote.originalPeriod !== (period === 'FT' ? 'UNKNOWN' : 'HT')
          || quote.periodBasis !== 'SAME_ROW_PRIMARY_AND_EXPLICIT_HT_COLUMNS' || !text(quote.line, 80) || !linePattern.test(quote.line)
          || !['sourceObservedAt', 'sourceReceivedAt', 'sourcePersistedAt'].every((field, index) => auditInstant(quote[field])
            && exactTime(quote[field]) === exactTime(source[['observedAt', 'receivedAt', 'persistedAt'][index]]))
          || !quote.source || !partialReadonly(quote.source) || !['tableIndex', 'rowIndex', 'columnIndex'].every(field => auditInteger(quote.source[field]))
          || quote.source.columnIndex !== sourceColumns[quote.isAlternative ? 'alternative' : 'primary'][key]) invalid();
        if (kind === 'HANDICAP' ? !['home', 'away'].includes(quote.lineSide) || !water(quote.homeWater) || !water(quote.awayWater)
          || quote.overWater !== null || quote.underWater !== null
          : quote.lineSide !== null || quote.homeWater !== null || quote.awayWater !== null || !water(quote.overWater) || !water(quote.underWater)) invalid();
      }
    }
    const statuses = cellLabels.map(([key]) => game.cells[key].status);
    if (game.witnessStatus === 'FOUR_CELLS_WITNESSED' ? !statuses.every(status => status === 'WITNESSED')
      : game.witnessStatus === 'NOT_CHECKED' ? !statuses.every(status => status === 'NOT_CHECKED')
        : statuses.every(status => status === 'WITNESSED') || statuses.every(status => status === 'NOT_CHECKED')) invalid();
  }
  if (value.status === 'WITNESSES_FOUND' && (!value.games.length || value.games.some(game => game.witnessStatus !== 'FOUR_CELLS_WITNESSED'))) invalid();
  return value;
}

function quoteText(quote) {
  return quote.kind === 'HANDICAP'
    ? `${quote.lineSide === 'home' ? '主讓' : '客讓'}${quote.line}｜客 ${String(quote.awayWater)}／主 ${String(quote.homeWater)}`
    : `${quote.line}｜大 ${String(quote.overWater)}／小 ${String(quote.underWater)}`;
}

export default function RawMarketCoveragePanel() {
  const [league, setLeague] = useState('EPL'), [date, setDate] = useState(() => rawMarketCoverageToday());
  const [inputError, setInputError] = useState('');
  const request = useHistoryAuditRequest(), report = request.data.result;
  const currentScope = useRef({ league, date });
  function changeScope(key, value) {
    currentScope.current = { ...currentScope.current, [key]: value }; request.reset(); setInputError('');
    if (key === 'league') setLeague(value); else setDate(value);
  }
  function query() {
    const scope = { ...currentScope.current };
    if (!leagueAllowed(scope.league) || !auditDay(scope.date)) { setInputError('請選擇有效聯盟與盤日。'); return; }
    setInputError('');
    return request.run(endpoint + '?' + new URLSearchParams(scope), value => validateRawMarketCoverage(value, scope), { clearAll: true });
  }
  return <section className={`card ${styles.panel}`} aria-labelledby="raw-market-coverage-title">
    <h2 id="raw-market-coverage-title">原始盤口逐場核對</h2>
    <p className={styles.notice}>將已保存原文與本次官方來源回傳的場次分開核對，確認四種市場是否有可回讀的雙邊價格。不依賴是否下注，不更改目前盤口。</p>
    <p className={styles.notice}>這是有限來源的歷史見證，各市場可能來自不同來源時間，非同時盤；每類市場只核對至少一條線，不代表主盤與所有替代盤已完整保存，也不是完整變盤、尾盤或賽前可用證明。全場若由同列半場欄位辨識，原始期間仍為未確認，不提供正式評分或投注操作。</p>
    <div className={styles.filters}>
      <label>聯盟<select aria-label="原始逐場核對聯盟" value={league} onChange={event => changeScope('league', event.target.value)}>{Object.entries(leagueNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>盤日<input type="date" aria-label="原始逐場核對盤日" value={date} onChange={event => changeScope('date', event.target.value)}/></label>
      <button type="button" disabled={Boolean(request.busy)} onClick={query}>{request.busy ? '核對中…' : '核對原始盤口場次'}</button>
    </div>
    <div role="status" aria-live="polite">
      {(inputError || request.error) && <p className={styles.error}>{inputError || request.error}</p>}
      {!report && !request.busy && <p className={styles.meta}>逐場核對結果：未確認。</p>}
      {report && <>
        <p className={styles.meta}>{leagueNames[report.league]} · {report.date}；核對時間 {taipeiHistoryTime(report.until)}。</p>
        <p>{report.status === 'WITNESSES_FOUND' ? '本次回傳場次的四類市場均找到至少一條雙邊價格見證；完整歷史與尾盤仍未確認。' : '本次仍有市場缺少見證或尚未檢查，不能認定所有盤口已存齊。'}</p>
        {!report.games.length && <p>本次官方來源沒有回傳場次；這不代表沒有比賽，也不能據此判定盤口完整。</p>}
        <p className={styles.meta}>官方來源回傳 {report.schedule.officialGameCount} 場；本輪讀取 {report.budget.batchReads} 批原文。{report.inventory.candidatesTruncated && '候選來源只載入部分，完整數量未確認。'}</p>
        {report.sources.some(source => source.status === 'UNKNOWN') && <p className={styles.notice}>部分來源尚未完成重播核對，不能當成沒有盤口或零筆保存。</p>}
        {report.games.map(game => <article className={styles.sample} key={game.gameId}>
          <h3>{game.label}</h3>
          <p className={styles.meta}>開賽時間 {taipeiHistoryTime(game.startTime)}；僅對照目前官方來源的場次身分，非賽前身分證明。</p>
          <div className={styles.tableWrap}><table><caption>四類市場的價格見證（每類至少一條線）</caption><thead><tr><th>市場</th><th>核對結果</th><th>原盤價格與來源</th></tr></thead><tbody>{cellLabels.map(([key, name]) => {
            const cell = game.cells[key];
            return <tr key={key}><th scope="row">{name}</th><td>{cell.status === 'WITNESSED' ? '已找到雙邊價格' : cell.status === 'NOT_WITNESSED' ? '已讀來源未見有效雙邊價格' : '尚未完成檢查'}</td><td className={styles.strings}>{cell.witnesses.map((quote, index) => {
              const source = report.sources.find(item => item.batchHash === quote.batchHash);
              return <div key={quote.batchHash + index}>
                <p>{quote.isAlternative ? '替代盤' : '主盤'}：{quoteText(quote)}</p>
                <p className={styles.meta}>{quote.period === 'FT' ? '全場為歷史辨識；原文未標全場。' : '原文明示上半場。'}來源觀察 {taipeiHistoryTime(quote.sourceObservedAt)}。</p>
                <details><summary>查看保存識別與位置</summary><p className={styles.strings}>保存識別：<code>{source.captureId}</code></p><p className={styles.meta}>來源接收 {taipeiHistoryTime(quote.sourceReceivedAt)}；原始存入 {taipeiHistoryTime(quote.sourcePersistedAt)}。表 {quote.source.tableIndex + 1}／列 {quote.source.rowIndex + 1}／欄 {quote.source.columnIndex + 1}。</p></details>
              </div>;
            })}</td></tr>;
          })}</tbody></table></div>
        </article>)}
      </>}
    </div>
  </section>;
}
