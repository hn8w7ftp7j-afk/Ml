'use client';
import { useRef, useState } from 'react';
import Link from 'next/link';
const labels = { NOT_CONFIGURED: '尚未設定 API Key', SOURCE_AUTH_FAILED: '來源金鑰無效', SOURCE_ACCESS_DENIED: '來源方案未授權', SOURCE_RATE_LIMITED: '來源限流，請稍後再試', SOURCE_HTTP_ERROR: '來源回應失敗', SOURCE_UNAVAILABLE: '來源逾時或無法連線', SCHEMA_MISMATCH: '來源格式不符，未採用資料', NO_EVENTS: '此日沒有取得賽事', NO_QUOTES: '此場沒有取得報價', EVENT_NOT_FOUND: '賽事不在此聯盟日期清單', EVENTS_RECEIVED: '已取得來源賽事，尚未核對官方身分', QUOTES_RECEIVED_NOT_VERIFIED: '已取得報價，不代表驗證通過', FRESH: '時間在5分鐘內', STALE: '超過5分鐘', MISSING_TIMESTAMP: '缺少來源時間', FUTURE_TIMESTAMP: '來源時間異常', UNAVAILABLE: '暫停或不可用', INVALID_PRICE: '價格無效', EVENT_MISMATCH: '賽事不符' };
export default function ExternalAudit() {
  const [league, setLeague] = useState('CPBL');
  const [date, setDate] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function load(eventId = '') {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setData(null);
    try {
      const response = await fetch('/api/external-audit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ league, date, eventId }), signal: AbortSignal.timeout(25000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '請求失敗');
      setData(result);
    } catch (cause) { setError(cause.name === 'TimeoutError' ? '請求逾時，可重新查詢' : cause.message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <main style={{ maxWidth: 1000, margin: 'auto', padding: 20, overflowWrap: 'anywhere' }}>
    <Link href="/">← 返回分析網站</Link><h1>外部價格來源稽核</h1>
    <p>獨立來源檢查，不回灌模型，不改分數、排名或既有驗證。取得報價不代表同合約驗證通過。</p>
    <p>中職：OddsPapi／Pinnacle；日韓：odds-api.net。須完成官方賽事與市場規則配對後，才能作同合約比對。目前中職市場 ID 尚未映射，改價時間也不等於最近觀測時間。</p>
    <label>聯盟 <select value={league} disabled={busy} onChange={e => { setLeague(e.target.value); setData(null); }}>{['CPBL', 'NPB', 'KBO'].map(id => <option key={id}>{id}</option>)}</select></label>{' '}
    <label>台灣日期 <input type="date" value={date} disabled={busy} onChange={e => { setDate(e.target.value); setData(null); }}/></label>{' '}
    <button disabled={busy || !date} onClick={() => load()}>{busy ? '查詢中…' : '查詢來源'}</button>
    {error && <p role="alert">{error}</p>}
    {data && <section aria-live="polite"><h2>{data.provider}</h2><p>{labels[data.status] || data.status}</p>
      {!data.configured && <p>伺服器設定：{data.requiredSetting}。不要把金鑰輸入此頁或放進前端程式。</p>}
      {data.partial && <p>結果不完整（分頁或顯示上限），不能視為全市場覆蓋。</p>}
      {data.events.map(event => <p key={event.id}><button disabled={busy} onClick={() => load(event.id)}>{event.label || `${event.away} 對 ${event.home}`}｜{event.start}</button></p>)}
      <p>時間與價格僅供來源診斷；未核對官方賽事身分、盤口與結算規則。</p>
      <div style={{ overflowX: 'auto' }}><table><thead><tr>{['莊家', '市場／期間', '方向', '十進位價格', '来源時間', '狀態'].map(x => <th key={x}>{x}</th>)}</tr></thead><tbody>{data.quotes.map((q, i) => <tr key={`${q.bookmaker}:${q.market}:${q.selection}:${i}`}><td>{q.bookmaker}</td><td>{q.market}／{q.period}</td><td>{q.selection}</td><td>{q.price ?? '—'}</td><td>{q.observedAt || '—'}<br/>{q.timestampBasis === 'BOOKMAKER_SNAPSHOT' ? '莊家快照時間' : '價格變動時間（非觀測時間）'}</td><td>{labels[q.state] || q.state}</td></tr>)}</tbody></table></div>
    </section>}
  </main>;
}
