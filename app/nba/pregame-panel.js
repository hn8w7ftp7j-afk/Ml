'use client';
import { useEffect, useRef, useState } from 'react';
import styles from './nba.module.css';
export default function PregamePanel({ game }) {
  const [state, setState] = useState({ busy: false, rows: null, error: '', receipt: null });
  const active = useRef(null);
  useEffect(() => () => active.current?.abort(), []);
  async function request(capture) {
    active.current?.abort(); const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(() => controller.abort(), 55000); setState(s => ({ ...s, busy: true, error: '' }));
    try {
      const response = await fetch(`/api/nba/pregame?id=${encodeURIComponent(game.sourceId)}`, { method: capture ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
      const body = await response.json(); if (!response.ok || body.league !== 'NBA') throw new Error(body.error || '快照回應格式錯誤');
      const rows = capture ? [body.snapshot] : body.snapshots;
      if (!Array.isArray(rows) || rows.some(r => r.gameId !== game.id)) throw new Error('快照場次不一致');
      setState({ busy: false, rows, receipt: body.receipt || null, error: '' });
    } catch (error) { if (!controller.signal.aborted) setState(s => ({ ...s, busy: false, error: error.message })); else setState(s => ({ ...s, busy: false, error: '讀寫中斷或逾時，未確認保存。' })); }
    finally { clearTimeout(timer); }
  }
  return <section className={styles.panel} aria-label="NBA 賽前永久快照"><h2>賽前傷病／先發觀測</h2>
    <p>只保存伺服器在開賽前實際取得的來源；不接受人工回填時間。來源報導不等於官方確認，缺值不補成健康或已先發。快照目前不送入模型。</p>
    <div className={styles.toolbar}><button disabled={state.busy} onClick={() => request(false)}>查看已保存快照</button>{game.status === 'scheduled' && <button disabled={state.busy} onClick={() => request(true)}>保存當下賽前觀測</button>}</div>
    {state.busy && <p role="status">快照讀寫中…</p>}{state.error && <p role="alert">{state.error}</p>}
    {state.receipt?.persisted && <p role="status">永久保存已確認・{state.receipt.inserted ? '新增觀測' : '相同證據已存在'}</p>}
    {state.rows?.length === 0 && <p>沒有已保存的賽前快照；不能用賽後名單補造。</p>}
    {state.rows?.map(row => <details key={row.revision || row.capturedAt}><summary>觀測時間 {row.capturedAt}</summary><p>先發：{row.lineupStatus}・傷病：{row.injuryStatus}</p>{row.lineups.map(l => <p key={l.teamId}>{l.teamId}：{l.players.map(p => p.name).join('、') || '尚未確認'}</p>)}{row.injuries.map(r => <p key={r.id}>{r.player.name}：{r.status}・報導時間 {r.reportedAt || '未知'}</p>)}<p className={styles.mono}>{row.revision}</p></details>)}
  </section>;
}
