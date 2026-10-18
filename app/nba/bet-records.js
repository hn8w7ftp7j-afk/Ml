'use client';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { nbaManualRecordStats } from '../../lib/nba/manual-bet-stats.js';
import { summarizeHighScoreBets } from '../../lib/league-bet-status.js';
const Ledger = createContext(null);
const marketNames = { fullTotal: '全場大小', fullRunline: '全場讓分', firstHalfTotal: '上半大小', firstHalfRunline: '上半讓分' };
const key = value => [value.date, value.gameId, value.marketKey, value.side].join('|');
const pick = value => value.side === 'over' ? '大分' : value.side === 'under' ? '小分' : `${value[value.side]} ${value.side === value.lineSide ? '讓分' : '受讓'}`;
const results = { WIN: '全贏', LOSS: '全輸', PARTIAL_WIN: '部分贏', PARTIAL_LOSS: '部分輸', PUSH: '走水' };
const money = value => value.toLocaleString('zh-TW', { maximumFractionDigits: 2 });
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000), ...options });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(result.error || '永久紀錄讀寫失敗。');
  return result;
}
export function NbaBetRecordProvider({ date, active, candidates = [], analysisReady = true, onHighScoreStatusChange, children }) {
  const [records, setRecords] = useState([]), [status, setStatus] = useState('loading');
  const [recordsDate, setRecordsDate] = useState('');
  const [error, setError] = useState(''), [pending, setPending] = useState(new Set()), [failed, setFailed] = useState(new Set());
  const [settling, setSettling] = useState(false), [settlementNotice, setSettlementNotice] = useState('');
  const revision = useRef(0), writeRevision = useRef(0), inFlight = useRef(new Set());
  const dateRef = useRef(date); dateRef.current = date;
  const settlingDate = useRef('');
  const ledgerStatus = recordsDate === date ? status : 'loading';
  const statusRef = useRef(ledgerStatus); statusRef.current = ledgerStatus;
  const load = useCallback(async ({ background = false } = {}) => {
    // A refresh must not invalidate an in-flight durable save or settlement.
    if ([...inFlight.current].some(identity => identity.startsWith(`${date}|`)) || settlingDate.current === date) return;
    const current = ++revision.current, writes = writeRevision.current;
    const matches = () => current === revision.current && writes === writeRevision.current && dateRef.current === date;
    if (!background || statusRef.current !== 'ready') setStatus('loading');
    setError('');
    try {
      const result = await request(`/api/nba/bet-records?date=${encodeURIComponent(date)}`);
      if (!Array.isArray(result.records)) throw new Error('下注帳本回傳格式不完整，請重新同步。');
      if (matches()) { setRecords(result.records); setRecordsDate(date); setStatus('ready'); }
    } catch (cause) { if (matches()) { setError(cause.message); setStatus('failed'); } }
  }, [date]);
  useEffect(() => {
    setRecords([]); setRecordsDate(''); setStatus('loading'); setFailed(new Set()); setSettlementNotice('');
    void load();
    return () => { revision.current++; };
  }, [date, load]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState !== 'hidden') void load({ background: true }); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);
  const confirmedKeys = new Set(records.filter(record => record.date === date && record.status !== 'CANCELLED').map(key));
  const summary = summarizeHighScoreBets(candidates, {
    analysisReady,
    ledgerReady: ledgerStatus === 'ready',
    isRecorded: candidate => confirmedKeys.has(key({ date, gameId: candidate.game.id, marketKey: candidate.marketKey, side: candidate.side })),
  });
  const callback = useRef(onHighScoreStatusChange); callback.current = onHighScoreStatusChange;
  const published = useRef('');
  useEffect(() => {
    const next = { league: 'NBA', date, ...summary };
    const signature = JSON.stringify(next);
    if (!callback.current || published.current === signature) return;
    published.current = signature; callback.current(next);
  }, [date, summary.state, summary.label, summary.total, summary.unbet, summary.recorded]);
  async function save(entry) {
    const payload = { date, gameId: entry.game.id, marketKey: entry.marketKey, side: entry.side,
      away: entry.away, home: entry.home, startTime: entry.game.startTime,
      line: entry.line, lineSide: entry.lineSide, water: entry.water, stake: 10000, alreadyPlaced: true };
    if (records.some(row => key(row) === key(payload))) return;
    return mutate(payload, key(payload));
  }
  async function changeStatus(record, action) { return mutate({ action, id: record.id }, key(record)); }
  async function settle() {
    if (settling || ledgerStatus !== 'ready') return;
    const current = revision.current; writeRevision.current++; settlingDate.current = date;
    setSettling(true); setError(''); setSettlementNotice('');
    try {
      const result = await request('/api/nba/bet-records', { method: 'POST', signal: AbortSignal.timeout(60000), headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'settle', date }) });
      if (current === revision.current && dateRef.current === date) {
        setRecords(result.records);
        setSettlementNotice(`本次處理 ${result.summary.checked} 筆，已結算 ${result.summary.settled} 筆；未完賽或尚待官方確認的紀錄仍保留待結算${result.summary.deferred ? `，另 ${result.summary.deferred} 筆將於下次核對` : ''}。`);
      }
    } catch (cause) { if (current === revision.current && dateRef.current === date) setError(cause.message); }
    finally { settlingDate.current = ''; setSettling(false); }
  }
  async function mutate(payload, identity) {
    if (ledgerStatus !== 'ready' || inFlight.current.has(identity)) return;
    const current = revision.current; writeRevision.current++; inFlight.current.add(identity);
    setPending(new Set(inFlight.current)); setError('');
    try {
      const result = await request('/api/nba/bet-records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!result.record?.id || result.persistence !== 'durable_database') throw new Error('未取得永久保存確認，請重新讀取紀錄。');
      if (current === revision.current && dateRef.current === date) {
        setRecords(old => [result.record, ...old.filter(row => key(row) !== identity)]);
        setFailed(old => new Set([...old].filter(value => value !== identity)));
      }
    } catch (cause) { if (current === revision.current && dateRef.current === date) { setError(cause.message); setFailed(old => new Set([...old, identity])); } }
    finally { inFlight.current.delete(identity); setPending(new Set(inFlight.current)); }
  }
  return <Ledger.Provider value={{ date, records: recordsDate === date ? records : [], status: ledgerStatus, error, load, save, changeStatus, pending, failed, settle, settling, settlementNotice }}>
    {error && active && <div className="errorBox" role="alert">{error}</div>}{children}
  </Ledger.Provider>;
}
export function NbaBetRecordButton({ entry }) {
  const ledger = useContext(Ledger);
  const recorded = ledger.records.find(row => key(row) === key({ ...entry, gameId: entry.game.id, date: ledger.date }));
  const identity = key({ ...entry, gameId: entry.game.id, date: ledger.date });
  const saving = ledger.pending.has(identity);
  const cancelled = recorded?.status === 'CANCELLED';
  return <div className="nbaRecordAction">
    {recorded && <strong className={`nbaBetStatus ${cancelled ? 'cancelled' : 'recorded'}`}>{cancelled ? '已取消' : '已下注 ✓'}</strong>}
    <button className={`mini ${recorded && !cancelled ? 'cancel' : 'green'}`} title={cancelled ? '恢復原本的 10,000 元紀錄與原盤口、水位，不會送單' : recorded ? '只取消網站紀錄，不會撤銷實際下注' : '保存你已自行完成的下注；每筆固定 10,000 元，不會送單'} disabled={ledger.status !== 'ready' || saving} onClick={() => recorded ? ledger.changeStatus(recorded, cancelled ? 'restore' : 'cancel') : ledger.save(entry)}>{saving ? '儲存中…' : ledger.status === 'loading' ? '帳本同步中…' : cancelled ? '重新紀錄下注' : recorded ? '取消下注' : ledger.failed.has(identity) ? '記錄失敗｜重試' : '紀錄實際下注'}</button>
    {recorded && <details className="nbaRecordDetails"><summary>原下注紀錄</summary><small>原盤 {recorded.line}｜水位 {recorded.water}｜{recorded.stake.toLocaleString('zh-TW')} 元</small></details>}
    {ledger.status === 'failed' && <button className="mini secondary" onClick={ledger.load}>重新同步帳本</button>}
  </div>;
}
export function NbaBetRecords() {
  const ledger = useContext(Ledger);
  const stats = nbaManualRecordStats(ledger.records);
  return <section className="panel" aria-label="NBA 下注紀錄"><div className="panelHead"><h2>NBA｜下注紀錄</h2><div><button className="mini secondary" disabled={ledger.settling || ledger.status !== 'ready'} onClick={ledger.settle}>{ledger.settling ? '核對官方賽果中…' : '核對賽果並結算'}</button><button className="mini secondary" onClick={ledger.load}>重新讀取</button></div></div>
    <p>{ledger.date}｜每筆固定 10,000 元｜{ledger.status === 'ready' ? `已結算 ${stats.settled} 筆｜待結算 ${stats.pending} 筆` : '帳本尚未完成同步'}</p>
    {ledger.status === 'ready' && <p>實際紀錄：{stats.wins} 贏／{stats.losses} 輸／{stats.pushes} 走水｜勝率 {stats.winRate == null ? '—' : `${(stats.winRate * 100).toFixed(2)}%`}｜損益 {money(stats.profit)} 元｜ROI {stats.roi == null ? '—' : `${(stats.roi * 100).toFixed(2)}%`}</p>}
    <details className="rankingDetails"><summary>紀錄與結算說明</summary><p>僅記錄已自行完成的下注，不會送單。勝率按正負結算筆數計算，走水與取消紀錄不計；損益依保存的原盤口、水位及有效輸贏金額 1.5% 退水。本人申報紀錄不列入模型驗證樣本。</p></details>
    {ledger.settlementNotice && <p role="status">{ledger.settlementNotice}</p>}
    {ledger.error && <p className="errorBox" role="alert">{ledger.error}</p>}
    {ledger.records.map(record => <div className="nbaArchivedRecord" key={record.id}><strong>{record.away}（客）@ {record.home}（主）</strong><p>{marketNames[record.marketKey]}｜{pick(record)}｜{record.line}｜水位 {record.water}</p><p>實際金額 {record.stake.toLocaleString('zh-TW')} 元｜{record.status === 'CANCELLED' ? '已取消紀錄' : '已下注 ✓'}</p>{record.settlement && <p>{results[record.settlement.result]}｜{record.settlement.scores.period === 'FIRST_HALF' ? '上半' : '全場含延長'}比分 {record.settlement.scores.away}：{record.settlement.scores.home}｜損益 {money(record.settlement.profit)} 元｜退水 {money(record.settlement.rebate)} 元</p>}<button className={`mini ${record.status === 'CANCELLED' ? 'secondary' : 'cancel'}`} disabled={ledger.status !== 'ready' || ledger.pending.has(key(record))} onClick={() => ledger.changeStatus(record, record.status === 'CANCELLED' ? 'restore' : 'cancel')}>{ledger.pending.has(key(record)) ? '保存中…' : record.status === 'CANCELLED' ? '重新紀錄下注' : '取消下注'}</button><small>保存時間 {new Date(record.recordedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}{record.note ? `｜${record.note}` : ''}</small></div>)}
    {!ledger.records.length && <p>{ledger.status === 'loading' ? '帳本同步中…' : ledger.status === 'ready' ? '此日期尚無已記錄的下注。' : '帳本尚未同步完成。'}</p>}
  </section>;
}
