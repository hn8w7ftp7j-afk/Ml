'use client';
import { useEffect, useState } from 'react';

const clock = value => value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'short', hour12: false }).format(new Date(value)) : '尚未提供';
const goalieState = value => ({ UNKNOWN: '未知', PROJECTED: '預計先發', CONFIRMED: '消息明確確認' }[value] || '未知');
const names = rows => rows.map(row => `${row.name}（${row.playerId}）`).join(' ／ ');

export default function PersonnelPanel({ value, versions, busy, onLoad, onVersions }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  const personnel = value?.personnel;
  const source = personnel?.source;
  const age = now - Date.parse(source?.availableAt);
  const fresh = Number.isFinite(age) && age >= 0 && Number.isFinite(personnel?.freshness?.maxAgeMs) && age <= personnel.freshness.maxAgeMs;
  return <section className="nhlPersonnel" aria-label="官方傷病陣容與門將資料">
    <div className="nhlActions"><button className="primary" disabled={busy} onClick={onLoad}>{busy ? '讀取官方人員消息中…' : '讀取官方傷病、陣容與門將'}</button><button className="secondary" onClick={onVersions}>查看人員與門將版本</button></div>
    {!personnel && <p className="nhlNote">讀取 NHL 官方陣容消息，依比賽日期、球隊及官方球員 ID 核對。</p>}
    {personnel && <>
      <p className="nhlNote">人員資料 QA {personnel.qa?.status}｜{personnel.status === 'NO_MATCHING_GAME' ? '這篇滾動消息沒有本場相符資料' : personnel.pointInTimeEligible ? '本次已在開賽前取得來源與身分證據' : '回溯來源；不是當時保存的賽前快照'}</p>
      {personnel.status === 'NO_MATCHING_GAME' && <p className="nhlWarning">沒有將其他日期或其他對戰的傷病／門將套入本場。可選擇消息對應日期的官方賽程查看；未刊登的消息不補為「健康」或「已確認」。</p>}
      {personnel.matched && ['away', 'home'].map(side => {
        const team = personnel.teams?.[side]; const goalie = personnel.goalies?.[side];
        return <section className="panel" key={side}><h3>{side === 'away' ? '客隊' : '主隊'}｜球隊 ID {team?.teamId}</h3>
          <p><strong>{goalieState(goalie?.status)}</strong>：{goalie?.playerId ? `${goalie.name}（${goalie.playerId}）` : '尚無可核對人員'}</p>
          <p className="nhlNote">官方文章的預計搭配，不等同正式出賽名單。門將僅在消息明確提到本場先發時顯示確認。</p>
          <div className="nhlTableWrap"><table className="nhlTable"><thead><tr><th>組別</th><th>官方人員／Player ID</th></tr></thead><tbody>
            {(team?.lineCombinations || []).map((row, index) => <tr key={`F${index}`}><td>鋒線 {index + 1}</td><td>{names(row)}</td></tr>)}
            {(team?.defensivePairings || []).map((row, index) => <tr key={`D${index}`}><td>防守搭配 {index + 1}</td><td>{names(row)}</td></tr>)}
            {(team?.listedGoalies || []).length > 0 && <tr><td>門將名單</td><td>{names(team.listedGoalies)}</td></tr>}
          </tbody></table></div>
          {['injuries', 'scratched'].map(key => { const unresolved = (team?.unresolvedAvailability || []).filter(row => row.category === key); return <div key={key}><h4>{key === 'injuries' ? '傷病／出賽狀態消息' : '預計未出賽'}</h4>{team?.[key] == null ? <p className="nhlWarning">來源缺少或身分未完全核對；不當成 0 人。</p> : team[key].length ? <ul>{team[key].map(row => <li key={row.playerId}>{row.name}（{row.playerId}）{row.reason ? `：${row.reason}` : '｜消息未提供原因'}</li>)}</ul> : unresolved.length ? <p className="nhlWarning">此段尚無完成 ID 核對的人員；不是官方 0 人。</p> : <p>官方該段明列無人。</p>}{unresolved.length > 0 && <p className="nhlWarning">清單不完整，以下原文姓名尚未核對 ID：{unresolved.map(row => `${row.name}${row.reason ? `（${row.reason}）` : ''}`).join('、')}。不將這些姓名套入球員紀錄。</p>}</div>; })}
          {team?.issues?.length > 0 && <p className="nhlWarning">此隊待核對：{team.issues.join('；')}</p>}
        </section>;
      })}
      {source && <div className="nhlSource"><a href={source.url} target="_blank" rel="noreferrer">NHL 官方陣容原文</a><br/>初次發布 {clock(source.sourcePublishedAt)}｜文章更新 {clock(source.sourceUpdatedAt)}<br/>本次取得 {clock(source.observedAt)}｜{fresh ? '來源在時效範圍內' : '舊消息或尚無本場時效證據'}<details><summary>來源版本</summary>{source.contentHash}<br/>人員版本 {personnel.revision || '無本場版本'}</details></div>}
      {personnel.qa?.warnings?.length > 0 && <p className="nhlNote nhlWarning">{personnel.qa.warnings.join('；')}</p>}
      {value.observation && <p className="nhlNote">{value.observation.persisted ? '本次人員來源與門將版本已永久保存。' : value.observation.reason}</p>}
      {value.change && <p className="nhlNote">{value.change.ok === false ? '來源版本順序不符，不採用倒退版本。' : value.change.playerChanged ? '偵測到門將人選變更，請重新核對本場資料。' : value.change.goalieStatusChanged ? '門將確認狀態已更新。' : value.change.changed ? '官方人員消息版本已更新。' : '未觀察到已保存人員版本的變更。'}</p>}
    </>}
    {versions && <details open><summary>已保存人員／門將來源版本（{versions.length}）</summary>{versions.length === 0 ? <p className="nhlNote">尚無已永久保存的人員版本。</p> : versions.map(row => <p className="nhlSource" key={row.revision}>{clock(row.observedAt)}｜{['away', 'home'].map(side => `${side === 'away' ? '客' : '主'}：${row.personnel?.goalies?.[side]?.name || '未知'}／${goalieState(row.personnel?.goalies?.[side]?.status)}`).join('；')}<br/>{row.revision}</p>)}</details>}
  </section>;
}
