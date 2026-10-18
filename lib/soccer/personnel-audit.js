const text=v=>String(v??'').normalize('NFKC').replace(/\s+/g,' ').trim();
const didSub=v=>v===true||v?.didSub===true;
const missing=reason=>({status:'UNVERIFIED',reason,players:[],teamPlayerMinutes:null,clockBasis:'PROVIDER_REGULATION_SECONDS_EXCLUDES_ADDED_TIME',physicalElapsedMinutesVerified:false,modelEffectApplied:false});
// Audit observed regulation-clock participation only. Never a future minutes forecast.
// Team-only mode retains the global timeline guards, but makes no claim that
// the other team's substitutions, dismissals or minutes have been verified.
export function soccerMinutesAudit(payload,game,{teamSide=null}={}){
  if(![null,'home','away'].includes(teamSide))return{...missing('AUDIT_TEAM_SCOPE_INVALID'),teamScope:'UNVERIFIED',teamSide:null};
  const teamScope=teamSide===null?'BOTH':'TEAM_ONLY';
  const scopedMissing=reason=>({...missing(reason),teamScope,teamSide});
  const c=payload.header?.competitions?.[0],status=c?.status;
  if(game.status!=='final')return scopedMissing('MATCH_NOT_FINAL');
  if(status?.type?.name!=='STATUS_FULL_TIME'||(status.period!=null&&Number(status.period)!==2)||payload.format?.regulation?.periods!==2)return scopedMissing('REGULATION_PERIOD_UNVERIFIED');
  if(!Array.isArray(payload.keyEvents)||payload.keyEvents.length>1000)return scopedMissing('EVENT_TIMELINE_MISSING');
  const unique=new Map();
  for(const e of payload.keyEvents){const id=String(e.id||'');if(!/^\d{1,20}$/.test(id))return scopedMissing('EVENT_ID_INVALID');if(unique.has(id)&&JSON.stringify(unique.get(id))!==JSON.stringify(e))return scopedMissing('EVENT_REVISION_CONFLICT');unique.set(id,e);}
  const events=[...unique.values()];
  if(events.some(e=>Number(e.period?.number)>2))return scopedMissing('EXTRA_TIME_TIMELINE_UNVERIFIED');
  if(events.filter(e=>e.type?.type==='end-regular-time'&&Number(e.period?.number)===2&&e.clock?.value===5400).length!==1)return scopedMissing('REGULATION_END_MISSING');
  const teams={};
  for(const side of teamSide===null?['home','away']:[teamSide]){
    const team=game[side],group=(payload.rosters||[]).filter(r=>String(r.team?.id)===team.sourceId&&r.homeAway===side);
    if(group.length!==1||!Array.isArray(group[0].roster)||group[0].roster.length>40)return scopedMissing('ROSTER_SCOPE_INVALID');
    const roster=group[0].roster,players=new Map();
    for(const p of roster){const id=String(p.athlete?.id||'');if(!/^\d{1,16}$/.test(id)||players.has(id)||typeof p.starter!=='boolean')return scopedMissing('PLAYER_IDENTITY_INVALID');players.set(id,{id,name:p.athlete.displayName||p.athlete.fullName,starter:p.starter,entered:p.starter?0:null,segments:[],source:p,subInSeen:false,subOutSeen:false,redSeen:false});}
    const on=new Set([...players.values()].filter(p=>p.starter).map(p=>p.id));if(on.size!==11)return scopedMissing('STARTING_XI_INCOMPLETE');
    const changes=events.filter(e=>String(e.team?.id)===team.sourceId&&(/substitution|red-card|yellow-red-card|second-yellow/.test(e.type?.type||''))).sort((a,b)=>(a.clock?.value??Infinity)-(b.clock?.value??Infinity));
    let last=0,expectedSeconds=0;const observed=[];
    for(const e of changes){const second=e.clock?.value,period=Number(e.period?.number),type=e.type?.type;
      if(!Number.isFinite(second)||second<last||second<0||second>5400||![1,2].includes(period)||(period===1&&second>2700)||(period===2&&second<2700))return scopedMissing('EVENT_CLOCK_INVALID');
      expectedSeconds+=(second-last)*on.size;last=second;
      const ids=(e.participants||[]).map(x=>String(x.athlete?.id||''));if(ids.some(id=>!players.has(id)))return scopedMissing('EVENT_PLAYER_IDENTITY_INVALID');
      if(type==='substitution'){
        if(ids.length!==2||ids[0]===ids[1])return scopedMissing('SUBSTITUTION_PAIR_INVALID');
        // The text and roster flags corroborate roles; participant array order is not assumed.
        const roles=ids.flatMap(enter=>ids.filter(exit=>exit!==enter).map(exit=>({enter,exit}))).filter(({enter,exit})=>text(e.text).includes(`${text(players.get(enter).name)} replaces ${text(players.get(exit).name)}`));
        if(roles.length!==1)return scopedMissing('SUBSTITUTION_ROLE_UNVERIFIED');
        const {enter,exit}=roles[0],incoming=players.get(enter),outgoing=players.get(exit);
        if(on.has(enter)||!on.has(exit)||incoming.entered!==null||!didSub(incoming.source.subbedIn)||!didSub(outgoing.source.subbedOut))return scopedMissing('SUBSTITUTION_STATE_CONFLICT');
        outgoing.segments.push({from:outgoing.entered,to:second});outgoing.subOutSeen=true;on.delete(exit);incoming.entered=second;incoming.subInSeen=true;on.add(enter);observed.push({eventId:String(e.id),type:'SUBSTITUTION',enter,exit,second,rawClock:e.clock.displayValue});
      }else{
        if(ids.length!==1||players.get(ids[0]).redSeen)return scopedMissing('DISMISSAL_IDENTITY_CONFLICT');const p=players.get(ids[0]);p.redSeen=true;
        const onField=on.has(p.id);if(onField){p.segments.push({from:p.entered,to:second});on.delete(p.id);}observed.push({eventId:String(e.id),type:onField?'ON_FIELD_DISMISSAL':'BENCH_DISMISSAL',playerId:p.id,second,rawClock:e.clock.displayValue});
      }
      if(on.size>11||on.size<1)return scopedMissing('TEAM_PLAYER_COUNT_INVALID');
    }
    expectedSeconds+=(5400-last)*on.size;
    for(const id of on){const p=players.get(id);p.segments.push({from:p.entered,to:5400});}
    for(const p of players.values()){
      const reds=p.source.stats?.find(s=>s.name==='redCards')?.value;
      if(didSub(p.source.subbedIn)!==p.subInSeen||didSub(p.source.subbedOut)!==p.subOutSeen||(Number(reds)>0&&!p.redSeen))return scopedMissing('ROSTER_EVENT_COVERAGE_INCOMPLETE');
    }
    const values=[...players.values()].map(p=>({id:p.id,name:p.name,starter:p.starter,appeared:p.starter||p.subInSeen,addedTimeOnlyAppearance:p.subInSeen&&p.segments.every(s=>s.from===s.to),segments:p.segments,regulationClockMinutes:p.segments.reduce((n,s)=>n+s.to-s.from,0)/60}));
    const seconds=values.reduce((n,p)=>n+p.regulationClockMinutes*60,0);if(Math.abs(seconds-expectedSeconds)>1e-7)return scopedMissing('TEAM_MINUTES_NOT_CONSERVED');
    teams[side]={sourceId:team.sourceId,players:values,events:observed,teamPlayerMinutes:seconds/60,expectedTeamPlayerMinutes:expectedSeconds/60};
  }
  return{status:'REGULATION_CLOCK_RECONSTRUCTED',teamScope,teamSide,teams,clockBasis:'PROVIDER_REGULATION_SECONDS_EXCLUDES_ADDED_TIME',physicalElapsedMinutesVerified:false,modelEffectApplied:false,reason:null};
}

export function compareSoccerPersonnel(previous,current){
  if(previous===undefined)return{status:'HISTORY_UNAVAILABLE',teams:[],modelEffectApplied:false};
  if(!previous)return{status:'NO_PREVIOUS_SNAPSHOT',teams:[],modelEffectApplied:false};
  const before=previous.evidence||previous,after=current;
  if(before.game?.id!==after.game?.id||before.game?.league!==after.game?.league||before.game?.date!==after.game?.date||['home','away'].some(s=>before.game[s]?.sourceId!==after.game[s]?.sourceId)||Date.parse(before.observedAt)>=Date.parse(after.observedAt))return{status:'COMPARISON_NOT_APPLICABLE',teams:[],modelEffectApplied:false};
  const teams=['home','away'].map(side=>{
    const old=before.teams[side].lineup,next=after.teams[side].lineup,a=new Map(old.starters.map(p=>[p.id,p])),b=new Map(next.starters.map(p=>[p.id,p]));
    const complete=a.size===11&&b.size===11;
    const status=b.size!==11?'LINEUP_COVERAGE_INCOMPLETE':a.size!==11?'LINEUP_PUBLISHED':a.size===b.size&&[...a.keys()].every(id=>b.has(id))?'UNCHANGED':'LINEUP_CHANGED';
    return{side,status,previousStatus:old.status,currentStatus:next.status,added:complete?[...b.values()].filter(p=>!a.has(p.id)):[],removed:complete?[...a.values()].filter(p=>!b.has(p.id)):[],publishedPlayers:status==='LINEUP_PUBLISHED'?[...b.values()]:[],formationBefore:old.formation,formationAfter:next.formation};
  });
  return{status:before.phase==='PREMATCH_OBSERVATION'&&after.phase==='POSTSTART_AUDIT'?'PREMATCH_TO_ACTUAL_AUDIT':'OBSERVATION_CHANGE',previousObservedAt:before.observedAt,currentObservedAt:after.observedAt,previousAnalysisHash:previous.analysisHash||null,teams,modelEffectApplied:false,expectedMinutesError:null};
}
