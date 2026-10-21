'use client';
import { useEffect, useState } from 'react';

const leagues = ['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'];
const states = { synced: '盤口已同步', error: '未通過', disconnected: '讀取程式未連線', missing: '未偵測盤面', idle: '等待重新讀取' };
const reasons = { 'no-complete-tab': '盤面檢查未通過', 'no-parsed-games': '看到標題但無法組成賽事',
  'no-board-table': '無法辨識盤面區段', 'conflicting-duplicate-rows': '同場盤口資料衝突',
  'conflicting-duplicate-frames': '同頁框架盤口衝突', 'conflicting-duplicate-tabs': '不同分頁盤口衝突',
  NETWORK_ERROR: '上傳連線失敗', TIMEOUT: '上傳逾時', SYNC_EXCEPTION: '同步程式例外' };
export default function ReaderDiagnosticsPage() {
  const [league, setLeague] = useState('NBA'), [device, setDevice] = useState(''), [deviceQuery, setDeviceQuery] = useState('');
  const [reload, setReload] = useState(0), [reports, setReports] = useState([]), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ league, deviceId: deviceQuery });
    fetch(`/api/reader/diagnostics?${params}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok || !data.ok) throw new Error(data.error || '查詢失敗'); return data; })
      .then(data => setReports(data.reports || []))
      .catch(cause => { if (cause.name !== 'AbortError') { setReports([]); setError(cause.message); } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [league, deviceQuery, reload]);
  const panel = { background: '#142234', border: '1px solid #33465c', borderRadius: 12, padding: 16, marginBottom: 14 };
  return <main style={{ maxWidth: 1080, margin: '0 auto', padding: '24px 16px', color: '#e5edf8', minHeight: '100vh', background: '#0a1320' }}>
    <a href="/" style={{ color: '#8ac8ff' }}>返回分析首頁</a>
    <h1>Reader 自動診斷</h1>
    <p>盤口未通過也會回傳原因。以下為已收到的紀錄，保留 14 天；電腦離線或 Reader 未啟動時，無法即時收到。</p>
    <form style={{ ...panel, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'end' }} onSubmit={event => { event.preventDefault(); setDeviceQuery(device.trim()); setReload(value => value + 1); }}>
      <label>聯盟<br /><select value={league} onChange={event => setLeague(event.target.value)} style={{ padding: 10 }}><option value="">全部</option>{leagues.map(id => <option key={id}>{id}</option>)}</select></label>
      <label style={{ flex: '1 1 220px' }}>裝置識別碼（可留空）<br /><input style={{ padding: 10, width: '100%', boxSizing: 'border-box' }} value={device} onChange={event => setDevice(event.target.value)} maxLength={100} /></label>
      <button type="submit" style={{ padding: '10px 18px' }} disabled={loading}>重新查詢</button>
    </form>
    <div role="status">{loading ? '讀取診斷中…' : error || (!reports.length ? '目前沒有符合條件的診斷紀錄。尚不能判定 Reader 正常。' : `最近 ${reports.length} 筆回報`)}</div>
    {!loading && reports.map(record => <article key={record.report_id} style={panel}>
      <h2 style={{ fontSize: 18 }}>Reader {record.payload.readerVersion}｜{new Date(record.received_at).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}</h2>
      <p style={{ overflowWrap: 'anywhere', fontSize: 13 }}>裝置：{record.device_id}<br />回報：{record.report_id}<br />電腦記錄時間：{new Date(record.payload.createdAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}<br />分頁 {record.payload.tabCount}，未連線 {record.payload.silentTabCount}</p>
      {record.payload.exceptionCode && <p>同步例外：{reasons[record.payload.exceptionCode] || record.payload.exceptionCode}</p>}
      {Object.entries(record.payload.leagues || {}).filter(([id]) => !league || id === league).map(([id, row]) => <section key={id} style={{ borderTop: '1px solid #33465c', paddingTop: 10, marginTop: 10 }}>
        <strong>{id}｜{states[row.state] || row.state}</strong>
        {row.errorCode && <p>{reasons[row.errorCode] || row.errorCode}</p>}
        {row.issues?.length > 0 && <p style={{ overflowWrap: 'anywhere' }}>{row.issues.join('、')}</p>}
        {row.boards?.map((board, index) => <div key={index} style={{ fontSize: 13, marginTop: 8, overflowWrap: 'anywhere' }}>
          盤面 {index + 1}：預期 {board.diagnostics.expectedGameCount} 場／偵測 {board.diagnostics.gameCount} 場／解析 {board.parsedGameCount} 場；候選列 {board.diagnostics.candidateRows}／配對列 {board.diagnostics.pairedRows}
          {board.issues?.length > 0 && <div>檢查原因：{board.issues.join('、')}</div>}
        </div>)}
      </section>)}
    </article>)}
  </main>;
}
