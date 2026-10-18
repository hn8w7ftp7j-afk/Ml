'use client';

const clock=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'未提供';
const count=value=>Number.isInteger(value)&&value>=0?String(value):'未知';
const minutes=value=>Number.isFinite(value)&&value>=0?value.toFixed(1).replace(/\.0$/,''):'未知';
const sourceUrl=value=>typeof value==='string'&&/^https?:\/\//.test(value)?value:null;
const observedWindow=(player,days)=>Number.isInteger(player?.[`rosterMatchesObservedLast${days}Days`])&&player[`rosterMatchesObservedLast${days}Days`]>0;
const omissionMessage=reason=>reason==='SOCCER_PLAYER_MATCH_LIMIT'?'超出本次逐場核對範圍，未計入分鐘。':reason==='SOCCER_PLAYER_EXTRA_TIME_UNVERIFIED'?'此場包含加時賽，分鐘仍待核對，未計入。':/TIMEOUT|BUDGET_EXCEEDED/.test(reason||'')?'本次讀取逾時，未取得可核對分鐘。':'資料未能完整核對，未計入分鐘。';

function SourceReference({source}){
  const url=sourceUrl(source?.url);
  return <span>{source?.provider||'資料源'}｜取得：{clock(source?.fetchedAt)}{url&&<>｜<a href={url} target="_blank" rel="noreferrer">來源紀錄</a></>}</span>;
}

function PlayerWorkload({workload}){
  const players=Array.isArray(workload?.players)?workload.players:[],matches=Array.isArray(workload?.matches)?workload.matches:[],omissions=Array.isArray(workload?.omissions)?workload.omissions:[];
  const available=workload?.ok===true&&players.length>0;
  return <div className="soccerPlayerWorkload">
    <h4>球員近期已知上場</h4>
    {available?<>
      <p className="soccerAvailability">截至 {clock(workload.referenceAt)}，近14日已核對 {count(workload.coverage?.verifiedMatchesLast14Days??workload.coverage?.verifiedMatches)}／{count(workload.coverage?.candidateMatches)} 場。僅計已核對場次，覆蓋尚未確認完整。</p>
      <div className="soccerTableWrap"><table className="soccerAuditTable"><thead><tr><th>球員</th><th>7日分鐘</th><th>14日分鐘</th><th>7日出場／先發</th><th>14日出場／先發</th></tr></thead><tbody>{players.map(player=><tr key={player.id}><td>{player.name||'球員姓名待核對'}</td><td>{observedWindow(player,7)?minutes(player.regulationClockMinutesLast7Days):'未知'}</td><td>{observedWindow(player,14)?minutes(player.regulationClockMinutesLast14Days):'未知'}</td><td>{observedWindow(player,7)?`${count(player.appearancesLast7Days)}／${count(player.startsLast7Days)}`:'未知'}</td><td>{observedWindow(player,14)?`${count(player.appearancesLast14Days)}／${count(player.startsLast14Days)}`:'未知'}</td></tr>)}</tbody></table></div>
      <p className="soccerAvailability">分鐘採正規時鐘，不含補時或加時賽。0 僅指已核對名單中的紀錄；缺資料顯示未知，不代表沒有出場。</p>
    </>:<p className="soccerAvailability">球員近期上場分鐘未知；尚未取得可核對的逐場名單，不以 0 分鐘代替。</p>}
    {(workload||matches.length>0||omissions.length>0)&&<details className="soccerDetails"><summary>逐場來源與未納入項目</summary>
      {matches.length>0?<ul>{matches.map((match,index)=><li key={`${match.eventId}-${index}`}><p>{clock(match.startTime)}｜{match.competition?.name||match.competition?.slug||'賽事待核對'}｜已核對名單 {Array.isArray(match.players)?match.players.length:'未知'} 人</p><p className="soccerAvailability"><SourceReference source={match.source}/></p></li>)}</ul>:<p>尚無可核對的逐場上場紀錄。</p>}
      {omissions.length>0&&<><p>另有 {omissions.length} 場未納入分鐘統計，不能視為球員休息。</p><ul>{omissions.map((item,index)=><li key={`${item.eventId||'unknown'}-${index}`}>場次 {item.eventId||'待核對'}：{omissionMessage(item.reason)}{item.source&&<p className="soccerAvailability"><SourceReference source={item.source}/></p>}</li>)}</ul></>}
    </details>}
  </div>;
}

export function SoccerWorkloadPanel({workload}){
  if(!workload)return null;
  return <details className="soccerDetails"><summary>跨賽事賽程與近期負荷</summary>
    <p className="soccerAvailability">統計來源已回報的完賽場次，包含聯賽與盃賽；尚未確認完整覆蓋，不代表每位球員都出場。</p>
    <div className="soccerLineupGrid">{['home','away'].map(side=>{
      const team=workload.teams?.[side],last=team?.lastKnownCompleted;
      return <section key={side}><h4>{side==='home'?'主隊':'客隊'}</h4>{team?.ok?<>
        <p>近7日已知完賽 {count(team.completedMatchesLast7Days)} 場；近14日 {count(team.completedMatchesLast14Days)} 場。</p>
        <p>上一場已知完賽：{last?`${clock(last.startTime)} 對 ${last.opponent?.name||'對手待核對'}`:'來源未提供'}。</p>
        {Number.isFinite(team.kickoffGapHoursFromLastCompleted)&&<p>兩場開球間隔：{team.kickoffGapHoursFromLastCompleted.toFixed(1)} 小時，並非實際休息時長。</p>}
        {team.scheduledBeforeTarget?.length>0&&<p>本場前另有 {team.scheduledBeforeTarget.length} 場已公布賽程，尚未進行，不計入已完成負荷。</p>}
        {team.scheduledAhead?.length>0&&<ul>{team.scheduledAhead.map(event=><li key={event.eventId}>{clock(event.startTime)}｜{event.competition?.name||event.competition?.slug||'賽事待核對'}｜{event.opponent?.name||'對手待核對'}</li>)}</ul>}
      </>:<p>跨賽事資料暫時不足；不推定為充分休息。</p>}<PlayerWorkload workload={team?.playerWorkload}/></section>;
    })}</div>
    <p className="soccerAvailability">本場預估上場分鐘尚未提供；國家隊行程、旅行距離與完整負荷仍待核對。這些觀察尚未直接加減進球機率。</p>
  </details>;
}
