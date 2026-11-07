import {createHash} from 'node:crypto';

// Explicit synthetic engineering fixture. It is not a football observation or
// evidence of predictive performance; the normalizer preserves that distinction.
export function soccerWyscoutSyntheticDocuments({kickoffs=['2017-08-11T18:45:00.000Z'],shotsPerTeam=8}={}){
  const matches=[],events=[];let id=100000;
  kickoffs.forEach((kickoff,gameIndex)=>{
    const matchId=9000+gameIndex,teamsData={};
    for(const [side,teamId]of [['home',1001],['away',1002]]){
      let score=0,scoreHT=0;
      for(let i=0;i<shotsPerTeam;i++){
        const period=i<shotsPerTeam/2?'1H':'2H',goal=(i+gameIndex+(side==='home'?0:1))%7===0;
        score+=Number(goal);if(period==='1H')scoreHT+=Number(goal);
        events.push({id:id++,eventId:10,subEventId:100,eventName:'Shot',subEventName:'Shot',matchId,teamId,
          matchPeriod:period,eventSec:100+(i%(shotsPerTeam/2))*200,
          positions:[{x:50+(i%7)*7,y:15+(i%8)*10},{x:100,y:50}],tags:[{id:goal?101:1802}]});
      }
      teamsData[String(teamId)]={teamId,side,score,scoreHT,scoreET:0,scoreP:0};
    }
    const d=new Date(kickoff),hour=d.getUTCHours(),month=d.toLocaleString('en-US',{month:'long',timeZone:'UTC'});
    matches.push({wyId:matchId,competitionId:364,seasonId:181150,status:'Played',duration:'Regular',
      dateutc:d.toISOString().slice(0,19).replace('T',' '),
      date:`${month} ${d.getUTCDate()}, ${d.getUTCFullYear()} at ${hour%12||12}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')} ${hour<12?'AM':'PM'} GMT+0`,teamsData});
  });
  const projection={projectionVersion:'WYSCOUT_FULL_PASS_NATIVE_SHOT_PROJECTION-v1',totalEvents:events.length,uniqueEventIds:events.length,events};
  const source=(value,field)=>{const text=typeof value==='string'?value:JSON.stringify(value);return{text,source:{provider:'SYNTHETIC_ENGINEERING_FIXTURE',
    url:`https://fixture.invalid/${field}`,contentHash:createHash('sha256').update(text).digest('hex'),fetchedAt:'2026-11-01T00:00:00.000Z'}};};
  return{eventsDocument:source(projection,'events'),matchesDocument:source(matches,'matches'),
    eventsMappingDocument:source('event,subevent,event_label,subevent_label\n10,100,Shot,Shot\n3,33,Free Kick,Free kick shot\n3,35,Free Kick,Penalty\n','event-mapping'),
    tagsMappingDocument:source('Tag,Label,Description\n101,Goal,Goal\n102,own_goal,Own goal\n1802,not accurate,Not accurate\n','tags-mapping')};
}
