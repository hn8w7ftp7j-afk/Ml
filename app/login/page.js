'use client';
import { useState } from 'react';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setStatus('登入中…');
    try {
      const response = await fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }), cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '登入失敗');
      const next = new URLSearchParams(window.location.search).get('next') || '/';
      window.location.replace(next.startsWith('/') && !next.startsWith('//') ? next : '/');
    } catch (error) {
      setStatus(String(error?.message || error));
      setBusy(false);
    }
  }

  return <main className="shell loginShell"><section className="card loginCard"><div className="eyebrow">PRIVATE ANALYTICS</div><h1>⚾ Baseball Positive EV</h1><p className="muted">MLB／NPB／KBO／CPBL 共用同一個私人入口；輸入密碼後，這台裝置會維持登入 30 天。</p><form onSubmit={submit}><label>私人密碼<input type="password" autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)} maxLength={256} required autoFocus/></label><button className="primary full" disabled={busy}>{busy?'登入中…':'登入'}</button></form>{status&&<div className="status">{status}</div>}</section></main>;
}
