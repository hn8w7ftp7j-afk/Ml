'use client';

export default function ErrorPage({ error, reset }) {
  function clearAndReload() {
    try {
      for (const key of Object.keys(localStorage)) if (key.startsWith('mlb-positive-ev-')) localStorage.removeItem(key);
      for (const key of Object.keys(sessionStorage)) if (key.startsWith('mlb-')) sessionStorage.removeItem(key);
    } catch {}
    window.location.replace('/');
  }

  return <main className="appShell"><section className="panel"><div className="eyebrow">RECOVERY MODE</div><h1>網站載入發生錯誤</h1><p className="muted">這不是你的手機故障。系統已攔截前端例外，不會再只顯示空白錯誤頁。</p><div className="errorBox">{String(error?.message || '未知前端錯誤')}</div><div style={{display:'grid',gap:10,marginTop:16}}><button className="primary" onClick={() => reset()}>重新載入頁面</button><button className="mini" onClick={clearAndReload}>清除舊版暫存並重新開啟</button></div></section></main>;
}
