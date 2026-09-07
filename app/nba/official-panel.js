'use client';
import { useEffect, useRef, useState } from 'react';
import styles from './nba.module.css';
export default function OfficialPanel({ game }) {
  const [state, setState] = useState({ loading: false, result: null, error: '' });
  const current = useRef(game.sourceId); const controller = useRef(null);
  useEffect(() => { current.current = game.sourceId; setState({ loading: false, result: null, error: '' }); return () => controller.current?.abort(); }, [game.sourceId]);
  async function check() {
    const id = game.sourceId; controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    const timer = setTimeout(() => abort.abort(), 55000);
    setState(s => ({ ...s, loading: true, error: '' }));
    try {
      const response = await fetch(`/api/nba/official?id=${encodeURIComponent(id)}`, { cache: 'no-store', credentials: 'same-origin', signal: abort.signal });
      const body = await response.json();
      if (!response.ok || body.league !== 'NBA' || body.evidence?.gameId !== game.id) throw new Error(body.error || '官方核對回應身分不一致');
      if (current.current === id) setState({ loading: false, result: body.evidence, error: '' });
    } catch (error) { if (current.current === id) setState(s => ({ ...s, loading: false, error: error.name === 'AbortError' ? '核對已中斷或逾時，可重試。' : error.message })); }
    finally { clearTimeout(timer); }
  }
  const result = state.result;
  return <section className={styles.panel} aria-label="NBA 官方身分核對"><h2>NBA 官方 ID 交叉核對</h2>
    <p>使用官方比賽日與 box score 核對，不改動原本來源 ID。賽後核對不能證明賽前已知先發，也不會送入模型。</p>
    <button type="button" disabled={state.loading} onClick={check}>{state.loading ? '官方核對中…' : '核對官方 ID 與比分'}</button>
    {state.error && <p role="alert">{state.error}</p>}
    {result && <><p role="status">官方核對：{result.status}・{result.players.length} 位球員已對應</p>{result.error && <p role="alert">{result.error}</p>}
      {result.officialGameId && <p className={styles.mono}>官方比賽 ID：{result.officialGameId}</p>}
      {result.teams.map(team => <p key={team.providerId} className={styles.mono}>{team.providerId} → {team.officialId}</p>)}
      <details><summary>球員 ID 與對應依據</summary>{result.players.map(player => <p key={player.providerId} className={styles.mono}>{player.name}：{player.providerId} → {player.officialId}・{player.pointsChecked ? '同場同隊姓名及得分核對' : '同場同隊唯一姓名核對'}</p>)}</details>
      {result.missingPlayers?.map(player => <p key={player.playerId}>未對應：{player.name}（不猜測）</p>)}
      <details><summary>官方來源與取得時間</summary>{result.sources.map(source => <div key={source.url}><a href={source.url} target="_blank" rel="noreferrer">NBA 原始來源 ↗</a><p>取得：{source.fetchedAt}・發布時間未提供</p><p className={styles.mono}>SHA-256：{source.hash}</p></div>)}</details>
    </>}
  </section>;
}
