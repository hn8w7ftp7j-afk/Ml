'use client';

import { useRef, useState } from 'react';
import { taipeiHistoryTime } from './history-view.js';
import { useHistoryAuditRequest } from './history-audit-request.js';
import { auditDay, auditInstant, auditHash, auditInteger, auditReadonly } from './history-audit-validation.js';
import styles from './history-audit.module.css';

const endpoint = '/api/reader/legacy-history';
const leagueNames = { MLB: 'MLB 美國職棒', NPB: 'NPB 日本職棒', CPBL: 'CPBL 中華職棒' };
const marketNames = { '全場讓分': '全場讓分', '全場大小': '全場大小', '上半讓分': '前五局讓分', '上半大小': '前五局大小' };
const flags = { sourceKind: 'NORMALIZED_READER_CACHE', archiveOnly: true, currentBoardUpdated: false,
  executable: false, historicalAvailabilityVerified: false, coverageComplete: false, firstObservedAtVerified: false,
  formalEligible: false, calibrationEligible: false, closingCoverage: 'NOT_VERIFIED', mutableSnapshot: true,
  completeHistory: false, concurrentSourceCommitsVerified: false,
  timeBasis: 'LAST_RETAINED_READER_SNAPSHOT_NOT_FIRST_PRICE_OBSERVATION' };
const leagueAllowed = value => typeof value === 'string' && Object.hasOwn(leagueNames, value);
const plainText = (value, max) => typeof value === 'string' && value.length <= max;
const exactInstant = value => value.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction = '') => `.${fraction.padEnd(6, '0')}Z`);
const partialReadonly = value => auditReadonly(value, flags, false);

export function readerLegacyCurrentMonth(now = Date.now()) {
  const month = new Date(now + 8 * 3600000).toISOString().slice(0, 7);
  const [year, number] = month.split('-').map(Number);
  return { from: month + '-01', through: new Date(Date.UTC(year, number, 0)).toISOString().slice(0, 10) };
}

function validRange(scope) {
  return leagueAllowed(scope?.league) && auditDay(scope.from) && auditDay(scope.through) && scope.from <= scope.through
    && (Date.parse(scope.through) - Date.parse(scope.from)) / 86400000 <= 30;
}
function metadataMatches(row, scope, detail = false) {
  return row && partialReadonly(row) && row.league === scope.league && auditDay(row.boardDate)
    && (detail ? row.boardDate === scope.date : row.boardDate >= scope.from && row.boardDate <= scope.through)
    && auditInstant(row.observedAt) && auditInstant(row.pageActivityAt) && auditInstant(row.expiresAt)
    && typeof row.expired === 'boolean' && auditInteger(row.payloadBytes) && row.payloadBytes > 0
    && auditHash(row.checksum) && plainText(row.storedSchema, 100) && typeof row.detailAvailable === 'boolean';
}
function baseMatches(value, scope, view) {
  return value?.ok === true && value.schema === 'reader-legacy-history-v1' && auditReadonly(value, flags)
    && auditInstant(value.readAt) && value.view === view && value.filters?.view === view && value.filters.league === scope.league
    && (view === 'inventory' ? value.filters.from === scope.from && value.filters.through === scope.through : value.filters.date === scope.date);
}

export function validateReaderLegacyHistoryInventory(value, scope) {
  const invalid = () => { throw new Error('舊 Reader 清單未通過核對'); };
  if (!validRange(scope) || !baseMatches(value, scope, 'inventory') || !Array.isArray(value.records) || value.records.length > 31) invalid();
  if (value.status === 'NO_RETAINED_ROWS') {
    if (value.count !== 0 || value.records.length !== 0 || value.code !== 'LEGACY_READER_SNAPSHOT_NOT_FOUND') invalid();
    return value;
  }
  if (value.status !== 'RETAINED_MUTABLE_SNAPSHOTS' || !auditInteger(value.count) || value.count < 1 || value.count !== value.records.length) invalid();
  const seen = new Set();
  for (const row of value.records) {
    if (!metadataMatches(row, scope) || row.integrity?.status !== 'NOT_CHECKED' || seen.has(row.boardDate)
      || Object.hasOwn(row, 'games') || Object.hasOwn(row, 'payload') || Object.hasOwn(row, 'deviceId') || Object.hasOwn(row, 'pageUrl')) invalid();
    seen.add(row.boardDate);
  }
  return value;
}

export function validateReaderLegacyHistoryDetail(value, entry) {
  const invalid = () => { throw new Error('舊 Reader 明細未通過核對'); };
  if (!entry || !leagueAllowed(entry.league) || !auditDay(entry.boardDate) || entry.detailAvailable !== true) invalid();
  const scope = { league: entry.league, date: entry.boardDate };
  if (!baseMatches(value, scope, 'detail')) invalid();
  if (value.status === 'NO_RETAINED_ROWS') {
    if (value.count !== 0 || value.record !== null || value.code !== 'LEGACY_READER_SNAPSHOT_NOT_FOUND') invalid();
    return value;
  }
  const row = value.record;
  if (value.status !== 'RETAINED_MUTABLE_SNAPSHOT' || value.count !== 1 || !metadataMatches(row, scope, true)
    || !auditInstant(row.receivedAt) || !plainText(row.readerVersion, 120) || !row.readerVersion
    || !auditHash(row.payloadHash) || !auditHash(row.rawBoardHash) || row.detailAvailable !== true
    || row.integrity?.status !== 'PASS' || row.integrity.scope !== 'CACHE_CHECKSUM_IDENTITY_SCHEMA_NOT_SOURCE_TIME_AUTHORITY'
    || !Array.isArray(row.games) || row.games.length < 1 || row.games.length > 40) invalid();
  const games = new Set();
  for (const game of row.games) {
    if (!game || !partialReadonly(game) || !auditInteger(game.gamePk) || game.gamePk < 1 || games.has(game.gamePk)
      || !plainText(game.away, 100) || !game.away || !plainText(game.home, 100) || !game.home
      || !(game.boardTime === null || typeof game.boardTime === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(game.boardTime))
      || !['open', 'locked'].includes(game.marketStatus) || !game.source || !partialReadonly(game.source)
      || !['observedAt', 'receivedAt', 'pageActivityAt'].every(key => auditInstant(game.source[key]) && exactInstant(game.source[key]) === exactInstant(row[key]))
      || !Array.isArray(game.markets) || game.markets.length > 8
      || (game.marketStatus === 'locked' ? game.markets.length !== 0 : game.markets.length === 0)) invalid();
    games.add(game.gamePk);
    const picks = new Set(), counts = new Map();
    for (const market of game.markets) {
      if (!market || !partialReadonly(market) || !Object.hasOwn(marketNames, market.market)
        || !plainText(market.pick, 180) || !market.pick || typeof market.water !== 'number' || !Number.isFinite(market.water)
        || market.water < 0.01 || market.water > 3 || !auditInstant(market.lineAsOf) || exactInstant(market.lineAsOf) !== exactInstant(row.pageActivityAt)
        || Object.hasOwn(market, 'rawText') && !plainText(market.rawText, 300)
        || picks.has(market.market + '\n' + market.pick)) invalid();
      picks.add(market.market + '\n' + market.pick); counts.set(market.market, (counts.get(market.market) || 0) + 1);
    }
    if ([...counts.values()].some(count => count !== 2)) invalid();
  }
  return value;
}

export default function LegacyHistoryPanel() {
  const [month] = useState(() => readerLegacyCurrentMonth());
  const [league, setLeague] = useState('MLB'), [from, setFrom] = useState(month.from), [through, setThrough] = useState(month.through);
  const [inputError, setInputError] = useState('');
  const request = useHistoryAuditRequest(), inventory = request.data.inventory, detail = request.data.detail;
  const currentScope = useRef({ league, from, through }), currentInventory = useRef(null);
  currentScope.current = { league, from, through }; currentInventory.current = inventory;
  function changeScope(key, value) {
    currentScope.current = { ...currentScope.current, [key]: value }; currentInventory.current = null;
    request.reset(); setInputError('');
    if (key === 'league') setLeague(value); else if (key === 'from') setFrom(value); else setThrough(value);
  }
  function queryInventory() {
    const scope = { ...currentScope.current };
    if (!validRange(scope)) { setInputError('請選擇有效聯盟與日期，每次最多查詢 31 天。'); return; }
    setInputError(''); currentInventory.current = null;
    return request.run(endpoint + '?' + new URLSearchParams({ view: 'inventory', ...scope }),
      value => validateReaderLegacyHistoryInventory(value, scope), { key: 'inventory', clearAll: true });
  }
  function queryDetail(entry) {
    const list = currentInventory.current, scope = currentScope.current;
    if (!list || list.filters.league !== scope.league || list.filters.from !== scope.from || list.filters.through !== scope.through
      || !list.records.some(row => row === entry && row.detailAvailable === true)) return;
    return request.run(endpoint + '?' + new URLSearchParams({ view: 'detail', league: entry.league, date: entry.boardDate }),
      value => validateReaderLegacyHistoryDetail(value, entry), { key: 'detail' });
  }
  return <section className={`card ${styles.panel}`} aria-labelledby="legacy-history-title">
    <h2 id="legacy-history-title">舊 Reader 保存查閱</h2>
    <p className={styles.notice}>先查日期清單，再按指定日期讀取盤口。這些是可被後續保存覆寫的舊快照，可能已過期；不是原始變盤歷史，也不能證明首次觀察時間、尾盤或完整覆蓋。</p>
    <div className={styles.filters}>
      <label>聯盟<select aria-label="舊 Reader 聯盟" value={league} onChange={event => changeScope('league', event.target.value)}>{Object.entries(leagueNames).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label>
      <label>開始日期<input type="date" aria-label="舊 Reader 開始日期" value={from} onChange={event => changeScope('from', event.target.value)}/></label>
      <label>結束日期<input type="date" aria-label="舊 Reader 結束日期" value={through} onChange={event => changeScope('through', event.target.value)}/></label>
      <button type="button" disabled={Boolean(request.busy)} onClick={queryInventory}>{request.busy === 'inventory' ? '查詢中…' : '查舊 Reader 保存'}</button>
    </div>
    <p className={styles.meta}>預設查本月；每次最多 31 天，不會自動搜尋其他月份。清單只讀取保存資訊，盤口明細需另按一次。</p>
    <div role="status" aria-live="polite">
      {(inputError || request.error) && <p className={styles.error}>{inputError || request.error}</p>}
      {!inventory && !request.busy && <p className={styles.meta}>舊快照留存數量：未確認。</p>}
      {inventory && <>
        <p className={styles.meta}>查詢範圍：{leagueNames[inventory.filters.league]} · {inventory.filters.from} 至 {inventory.filters.through}；核對時間 {taipeiHistoryTime(inventory.readAt)}。</p>
        {inventory.status === 'NO_RETAINED_ROWS' ? <p>目前此範圍沒有留存的舊快照（0 筆）；這不代表當時沒有開盤。</p> : <div className={styles.tableWrap}><table><caption>留存 {inventory.count} 筆日期快照；尚未核對盤口內容</caption><thead><tr><th>盤日</th><th>快照觀察時間</th><th>保存狀態</th><th>讀取明細</th></tr></thead><tbody>{inventory.records.map(row => <tr key={row.league + row.boardDate}><td>{row.boardDate}</td><td>{taipeiHistoryTime(row.observedAt)}</td><td>{row.expired ? '已過期，仍有留存' : '仍有留存'}</td><td>{row.detailAvailable ? <button type="button" disabled={Boolean(request.busy)} onClick={() => queryDetail(row)}>查看 {row.boardDate} 盤口</button> : <span>明細暫不可讀取</span>}</td></tr>)}</tbody></table></div>}
      </>}
      {request.busy === 'detail' && <p className={styles.meta}>讀取指定日期明細中…</p>}
      {detail?.status === 'NO_RETAINED_ROWS' && <p>指定日期目前沒有留存的舊快照（0 筆）；這不代表當時沒有開盤。</p>}
      {detail?.record && <article className={styles.sample}>
        <h3>{leagueNames[detail.record.league]} · {detail.record.boardDate} 舊快照盤口</h3>
        <p className={styles.notice}>已核對快照校驗、聯盟與格式；首次時間、完整歷史與尾盤仍未確認。棒球原欄位「上半」在此顯示為「前五局」，原始選項與文字保持不變。</p>
        <p className={styles.meta}>{detail.record.expired ? '已過期留存快照' : '留存快照'} · Reader {detail.record.readerVersion} · 快照觀察時間 {taipeiHistoryTime(detail.record.observedAt)}。</p>
        {detail.record.games.map(game => <div className={styles.sample} key={game.gamePk}>
          <h3>{game.away} → {game.home}{game.boardTime ? ` · ${game.boardTime}` : ''}</h3>
          {game.marketStatus === 'locked' ? <p className={styles.meta}>舊快照標記鎖盤（實際來源鎖盤未確認），沒有留存價格。</p> : <div className={styles.tableWrap}><table><thead><tr><th>市場</th><th>原始選項／盤口</th><th>水位</th><th>原始文字</th></tr></thead><tbody>{game.markets.map((market, index) => <tr key={market.market + index}><td>{marketNames[market.market]}</td><td className={styles.strings}>{market.pick}</td><td>{String(market.water)}</td><td className={styles.strings}>{Object.hasOwn(market, 'rawText') ? market.rawText : '未保存原始文字'}</td></tr>)}</tbody></table></div>}
        </div>)}
      </article>}
    </div>
  </section>;
}
