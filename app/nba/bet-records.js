'use client';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
const Ledger = createContext(null);
const marketNames = { fullTotal: '全場大小', fullRunline: '全場讓分', firstHalfTotal: '上半大小', firstHalfRunline: '上半讓分' };
const key = value => [value.date, value.gameId, value.marketKey, value.side].join('|');
const pick = value => value.side === 'over' ? '大分' : value.side === 'under' ? '小分' : `${value[value.side]} ${value.side === value.lineSide ? '讓分' : '受讓'}`;
async function request(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000), ...options });
  const result = await response.json();
  if (!response.ok || result.ok !== true) throw new Error(result.error || '永久紀錄讀寫失敗。');
  return result;
}
export function NbaBetRecordProvider({ date, active, children }) {
  const [records, setRecords] = useState([]), [status, setStatus] = useState('loading');
  const [error, setError] = useState(''), [pending, setPending] = useState(new Set()), [failed, setFailed] = useState(new Set());
  const revision = useRef(0), inFlight = useRef(new Set());
  async function load() {
    const current = ++revision.current; setStatus('loading'); setError('');
    try {
      const result = await request(`/api/nba/bet-records?date=${encodeURIComponent(date)}`);
      if (current === revision.current) { setRecords(result.records); setStatus('ready'); }
    } catch (cause) { if (current === revision.current) { setError(cause.message); setStatus('failed'); } }
  }
  useEffect(() => { setRecords([]); setFailed(new Set()); if (active) void load(); return () => { revision.current++; }; }, [date, active]);
  async function save(entry) {
    const payload = { date, gameId: entry.game.id, marketKey: entry.marketKey, side: entry.side,
      away: entry.away, home: entry.home, startTime: entry.game.startTime,
      line: entry.line, lineSide: entry.lineSide, water: entry.water, stake: 10000, alreadyPlaced: true };
    if (records.some(row => key(row) === key(payload))) return;
    return mutate(payload, key(payload));
  }
  async function changeStatus(record, action) { return mutate({ action, id: record.id }, key(record)); }
  async function mutate(payload, identity) {
    if (status !== 'ready' || inFlight.current.has(identity)) return;
    const current = revision.current; inFlight.current.add(identity);
    setPending(new Set(inFlight.current)); setError('');
    try {
      const result = await request('/api/nba/bet-records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!result.record?.id || result.persistence !== 'durable_database') throw new Error('未取得永久保存確認，請重新讀取紀錄。');
      if (current === revision.current) {
        setRecords(old => [result.record, ...old.filter(row => key(row) !== identity)]);
        setFailed(old => new Set([...old].filter(value => value !== identity)));
      }
    } catch (cause) { if (current === revision.current) { setError(cause.message); setFailed(old => new Set([...old, identity])); } }
    finally { inFlight.current.delete(identity); setPending(new Set(inFlight.current)); }
  }
  return <Ledger.Provider value={{ date, records, status, error, load, save, changeStatus, pending, failed }}>
    {error && active && <div className="errorBox" role="alert">{error}</div>}{children}
  </Ledger.Provider>;
}
export function NbaBetRecordButton({ entry }) {
  const ledger = useContext(Ledger);
  const recorded = ledger.records.find(row => key(row) === key({ ...entry, gameId: entry.game.id, date: ledger.date }));
  const identity = key({ ...entry, gameId: entry.game.id, date: ledger.date });
  const saving = ledger.pending.has(identity);
  const cancelled = recorded?.status === 'CANCELLED';
  return <div className="nbaRecordAction"><button className={`mini ${recorded && !cancelled ? 'recorded' : 'secondary'}`} title={cancelled ? '恢復原本的 10,000 元紀錄與原盤口、水位，不會送單' : recorded ? '只取消網站紀錄，不會撤銷實際下注' : '保存你已自行完成的下注；每筆固定 10,000 元，不會送單'} disabled={ledger.status !== 'ready' || saving} onClick={() => recorded ? ledger.changeStatus(recorded, cancelled ? 'restore' : 'cancel') : ledger.save(entry)}>{saving ? '保存中…' : cancelled ? '重新記錄下注' : recorded ? '已下注 ✓｜取消下注' : ledger.status === 'loading' ? '帳本同步中…' : ledger.failed.has(identity) ? '記錄失敗｜重試' : '紀錄實際下注'}</button>
    {recorded && <small>原盤 {recorded.line}｜水位 {recorded.water}｜{recorded.stake.toLocaleString('zh-TW')} 元</small>}
    {ledger.status === 'failed' && <button className="mini secondary" onClick={ledger.load}>重試帳本同步</button>}
  </div>;
}
export function NbaBetRecords() {
  const ledger = useContext(Ledger);
  return <section className="panel" aria-label="NBA 下注紀錄"><div className="panelHead"><h2>NBA｜下注紀錄</h2><button className="mini secondary" onClick={ledger.load}>重新讀取</button></div>
    <p>{ledger.date}｜每筆固定 10,000 元｜實際下注紀錄｜待結算</p>
    {ledger.error && <p className="errorBox" role="alert">{ledger.error}</p>}
    {ledger.records.map(record => <div className="nbaArchivedRecord" key={record.id}><strong>{record.away}（客）@ {record.home}（主）</strong><p>{marketNames[record.marketKey]}｜{pick(record)}｜{record.line}｜水位 {record.water}</p><p>實際金額 {record.stake.toLocaleString('zh-TW')} 元｜{record.status === 'CANCELLED' ? '已取消紀錄' : '已下注 ✓'}</p><button className={`mini ${record.status === 'CANCELLED' ? 'secondary' : 'cancel'}`} disabled={ledger.status !== 'ready' || ledger.pending.has(key(record))} onClick={() => ledger.changeStatus(record, record.status === 'CANCELLED' ? 'restore' : 'cancel')}>{ledger.pending.has(key(record)) ? '保存中…' : record.status === 'CANCELLED' ? '恢復原紀錄' : '取消下注紀錄'}</button><small>保存時間 {new Date(record.recordedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}{record.note ? `｜${record.note}` : ''}</small></div>)}
    {!ledger.records.length && <p>{ledger.status === 'loading' ? '帳本同步中…' : ledger.status === 'ready' ? '此日期尚無已記錄的下注。' : '帳本尚未同步完成。'}</p>}
  </section>;
}
