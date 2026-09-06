'use client';

const number = value => typeof value === 'number' && Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 3 }) : '—';
const percent = value => typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '—';
const status = value => ({ HISTORICAL_GAME_REQUIRES_HELD_OUT_ARTIFACT: '此場早於凍結模型適用時間；請查看歷史保留集，不套用未來資料訓練的模型。',
  SEASON_PHASE_NOT_TRAINED: '此賽事類型尚無獨立訓練模型；不借用例行賽模型。',
  NO_ELIGIBLE_OBSERVED_SHOTS: '尚無通過 QA 的射門事件。',
  OBSERVED_SHOT_RESEARCH_SCORED: '已計算實際射門的條件進球機率。' }[value] || value);

export default function ObservedShotPanel({ game, value, busy, onLoad }) {
  const research = value?.research;
  return <section className="panel" aria-label="本場射門品質研究">
    <h3>本場 5v5 射門品質｜獨立 xG 研究</h3>
    <p className="nhlNote">使用已凍結的歷史模型與本場實際射門座標；不是官方 xG、賽前預測或投注推薦。沒有事件資料時不補造數字。</p>
    <button className="secondary" disabled={busy} onClick={onLoad}>{busy ? '讀取射門研究中…' : '讀取本場射門研究'}</button>
    {!research ? <p className="nhlNote">尚未讀取本場事件資料。</p> : <>
      {Object.entries(research.strengths || {}).map(([strength, row]) => <div key={strength}>
        <h4>{strength}</h4><p className="nhlNote">{status(row.status)}</p>
        {row.teamResearch && <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>球隊</th><th>研究 xGF</th><th>研究 xGA</th><th>xGF%</th><th>已核對射門</th></tr></thead><tbody>{row.teamResearch.map(team => <tr key={team.teamId}><td>{team.teamId === game.awayTeamId ? game.away?.abbrev : game.home?.abbrev}（{team.teamId}）</td><td>{number(team.researchXGF)}</td><td>{number(team.researchXGA)}</td><td>{percent(team.researchXGFShare)}</td><td>{number(team.coveredShotsFor)}／{number(team.eligibleShotsFor)}</td></tr>)}</tbody></table></div>}
        {row.ok && <p className="nhlNote">有效事件 {number(row.testedShots)}；訓練截止 {row.trainingCutoff}。未定義 High-Danger 或 5v5 時間分母，不推算相關指標。</p>}
      </div>)}
      <p className="nhlSource"><a href={research.source?.url} target="_blank" rel="noreferrer">NHL 官方本場事件</a><br/>取得 {research.source?.fetchedAt}<br/>來源 SHA256 {research.source?.contentHash}<br/>模型版本 {research.artifactHash}</p>
    </>}
  </section>;
}
