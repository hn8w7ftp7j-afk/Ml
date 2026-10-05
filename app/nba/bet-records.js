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
  const [error, setError] = useState(''), [editing, setEditing] = useState(null), [saving, setSaving] = useState(false);
  const revision = useRef(0), mutation = useRef(false);
  async function load() {
    const current = ++revision.current; setStatus('loading'); setError('');
    try {
      const result = await request(`/api/nba/bet-records?date=${encodeURIComponent(date)}`);
      if (current === revision.current) { setRecords(result.records); setStatus('ready'); }
    } catch (cause) { if (current === revision.current) { setError(cause.message); setStatus('failed'); } }
  }
  useEffect(() => { setEditing(null); setRecords([]); if (active) void load(); return () => { revision.current++; }; }, [date, active]);
  async function save(event) {
    event.preventDefault(); if (mutation.current || !editing) return;
    const values = new FormData(event.currentTarget);
    const payload = { ...editing, stake: values.get('stake'), water: values.get('water'), line: values.get('line'), lineSide: values.get('lineSide') || null, note: values.get('note'), alreadyPlaced: values.get('alreadyPlaced') === 'on' };
    const current = revision.current; mutation.current = true; setSaving(true); setError('');
    try {
      const result = await request('/api/nba/bet-records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (!result.record?.id || result.persistence !== 'durable_database') throw new Error('未取得永久保存確認，請重新讀取紀錄。');
      if (current === revision.current) { setRecords(old => [result.record, ...old.filter(row => key(row) !== key(result.record))]); setEditing(null); }
    } catch (cause) { if (current === revision.current) setError(cause.message); }
    finally { mutation.current = false; setSaving(false); }
  }
  return <Ledger.Provider value={{ date, records, status, error, load, open: entry => { setError(''); setEditing({ ...entry, date, gameId: entry.game.id, away: entry.away, home: entry.home, startTime: entry.game.startTime }); } }}>
    {children}
    {editing && <section className="panel nbaRecordForm" role="dialog" aria-modal="true" aria-labelledby="nbaRecordTitle">
      <h2 id="nbaRecordTitle">記錄已下注</h2><p>{editing.away}（客）@ {editing.home}（主）｜{marketNames[editing.marketKey]}｜{pick(editing)}</p>
      <p>保存你已自行下的實際合約，不會送單。請核對金額、盤口和水位。</p>
      <form onSubmit={save}><div className="settingsGrid">
        <label>實際下注金額（元）<input autoFocus name="stake" type="number" min="0.01" max="1000000000" step="0.01" required disabled={saving}/></label>
        <label>實際下注盤口<input name="line" defaultValue={editing.line} maxLength={30} required disabled={saving}/></label>
        <label>實際水位<input name="water" type="number" min="0.001" max="5" step="any" defaultValue={editing.water} required disabled={saving}/></label>
        {!editing.marketKey.endsWith('Total') && <label>實際讓分球隊<select name="lineSide" defaultValue={editing.lineSide} disabled={saving}><option value="away">{editing.away}（客）</option><option value="home">{editing.home}（主）</option></select></label>}
        <label>備註<input name="note" maxLength={300} disabled={saving}/></label>
      </div><label className="nbaRecordConfirmation"><input type="checkbox" name="alreadyPlaced" required disabled={saving}/>這筆已由我自行下注，只需保存紀錄</label>
      {error && <p className="errorBox" role="alert">{error}</p>}
      <div className="heroControls"><button className="primary" disabled={saving}>{saving ? '確認永久保存中…' : '保存下注紀錄'}</button><button type="button" className="secondary" disabled={saving} onClick={() => setEditing(null)}>取消</button></div></form>
    </section>}
  </Ledger.Provider>;
}
export function NbaBetRecordButton({ entry }) {
  const ledger = useContext(Ledger);
  const recorded = ledger.records.find(row => key(row) === key({ ...entry, gameId: entry.game.id, date: ledger.date }));
  return <div className="nbaRecordAction"><button className={`mini ${recorded ? 'recorded' : 'secondary'}`} disabled={ledger.status !== 'ready' || Boolean(recorded)} onClick={() => ledger.open(entry)}>{recorded ? '已記錄下注' : ledger.status === 'loading' ? '帳本同步中…' : '記錄已下注'}</button>
    {recorded && <small>原盤 {recorded.line}｜水位 {recorded.water}｜{recorded.stake.toLocaleString('zh-TW')} 元</small>}
    {ledger.status === 'failed' && <button className="mini secondary" onClick={ledger.load}>重試帳本同步</button>}
  </div>;
}
export function NbaBetRecords() {
  const ledger = useContext(Ledger);
  return <section className="panel" aria-label="NBA 下注紀錄"><div className="panelHead"><h2>NBA｜下注紀錄</h2><button className="mini secondary" onClick={ledger.load}>重新讀取</button></div>
    <p>{ledger.date}｜本人填寫的實際下注合約｜待結算</p>
    {ledger.error && <p className="errorBox" role="alert">{ledger.error}</p>}
    {ledger.records.map(record => <div className="nbaArchivedRecord" key={record.id}><strong>{record.away}（客）@ {record.home}（主）</strong><p>{marketNames[record.marketKey]}｜{pick(record)}｜{record.line}｜水位 {record.water}</p><p>實際金額 {record.stake.toLocaleString('zh-TW')} 元｜已永久保存</p><small>保存時間 {new Date(record.recordedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}{record.note ? `｜${record.note}` : ''}</small></div>)}
    {!ledger.records.length && <p>{ledger.status === 'loading' ? '帳本同步中…' : ledger.status === 'ready' ? '此日期尚無已記錄的下注。' : '帳本尚未同步完成。'}</p>}
  </section>;
}
