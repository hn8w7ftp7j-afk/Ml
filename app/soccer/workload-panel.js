'use client';

const clock=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'未提供';
const count=value=>Number.isInteger(value)&&value>=0?String(value):'未知';

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
      </>:<p>跨賽事資料暫時不足；不推定為充分休息。</p>}</section>;
    })}</div>
    <p className="soccerAvailability">球員實際分鐘、國家隊行程與旅行距離仍待補；這些觀察尚未直接加減進球機率。</p>
  </details>;
}
