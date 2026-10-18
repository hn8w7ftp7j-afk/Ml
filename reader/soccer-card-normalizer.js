(() => {
  const clean = v => String(v || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const homeMarker = /[\[［【(（]\s*主\s*[\]］】)）]/u;
  const clock = /^(\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):([0-5]\d)\s*(?:[（(]GMT\+8[）)])?$/i;
  const key = v => ({ 獨贏: 'moneyline', 独赢: 'moneyline', 讓分: 'runline', 让分: 'runline', 讓球: 'runline', 让球: 'runline', 大小: 'total', 大小盤: 'total', 大小盘: 'total' })[clean(v)];
  function bands(parts) {
    const out = [];
    for (const p of [...parts].sort((a,b) => a.top-b.top || a.left-b.left)) {
      let row = out.find(x => Math.abs(x.top-p.top) <= 6);
      if (!row) { row = { top:p.top, parts:[] }; out.push(row); }
      if (!row.parts.some(x => x.text===p.text && Math.abs(x.left-p.left)<2)) row.parts.push(p);
    }
    return out.map(x => ({ ...x, text:clean(x.parts.sort((a,b)=>a.left-b.left).map(p=>p.text).join(' ')) }));
  }
  function quoteRows(parts, count, moneyline) {
    const out=[]; let pending=[];
    for (const {text} of bands(parts)) {
      pending.push(text);
      if (/^[-－—]$/.test(text) || (moneyline ? /^(?:\d{1,4}(?:\.\d{1,3})?)$/.test(text) : /(?:^|\s)\d{1,2}\.\d{2,3}$/.test(text))) {
        out.push(clean(pending.join(' '))); pending=[];
      }
    }
    return out.length===count && !pending.length ? out : null;
  }
  function normalize(sections, league) {
    const rows=[], issues=[]; let label='', excluded=0, count=0;
    for (const section of (Array.isArray(sections)?sections:[]).slice(0,12)) {
      if (!globalThis.Tai888LeagueRegistry?.standardMarker(section.label, league)) continue;
      const parts=(section.fragments||[]).filter(p => typeof p.text==='string' && clean(p.text) && Number.isFinite(p.top) && Number.isFinite(p.left)).map(p=>({...p,text:clean(p.text)}));
      if (!parts.length || parts.length>2400) continue;
      const all=bands(parts);
      if (all.some(p => { const ids=globalThis.Tai888LeagueRegistry.identifyAll(p.text);return ids.some(id=>id!==league); })) { issues.push('SOCCER_MIXED_LEAGUE_SECTION');continue; }
      const dates=all.map(p=>({...p,match:p.text.replace(/\s*[（(]更多玩法[）)]\s*[>›]?$/,'').match(clock)})).filter(p=>p.match);
      if (!dates.length) continue;
      label ||= clean(section.label); count+=dates.length;
      for (let n=0;n<dates.length;n++) {
        const start=dates[n], end=dates[n+1]?.top ?? Infinity;
        const content=parts.filter(p=>p.top>start.top+6 && p.top<end-6);
        const headings=all.filter(p=>p.top<end && p.parts.some(x=>key(x.text))).map(p=>({...p,columns:p.parts.filter(x=>key(x.text)).map(x=>({...x,key:key(x.text)}))})).filter(p=>p.columns.some(x=>x.key==='runline')&&p.columns.some(x=>x.key==='total'));
        const heading=headings.filter(p=>p.top<=start.top).at(-1)||headings.find(p=>p.top>start.top);
        if (!heading || new Set(heading.columns.map(p=>p.key)).size!==heading.columns.length) { issues.push('SOCCER_CARD_HEADERS_MISSING');continue; }
        const cols=heading.columns.sort((a,b)=>a.left-b.left), edge=cols[0].left-(cols[1].left-cols[0].left)/2;
        const teamRows=bands(content.filter(p=>p.left<edge));
        if (teamRows.some(p=>/角球|CORNER|卡牌|黃牌|黄牌|紅牌|红牌|BOOKING/i.test(p.text))) { excluded++;continue; }
        const teams=teamRows.map(p=>({...p,team:globalThis.Tai888SoccerTeams?.resolve(p.text)})).filter(p=>p.team);
        if (teams.length!==2 || teams[0].team.key===teams[1].team.key || teams.filter(p=>homeMarker.test(p.text)).length!==1) { issues.push('SOCCER_CARD_TEAM_IDENTITY_INVALID');continue; }
        const home=homeMarker.test(teams[0].text)?0:1, away=1-home;
        const evidence=[]; let bad=false;
        for(let i=0;i<cols.length;i++) {
          const col=cols[i], left=i?(cols[i-1].left+col.left)/2:edge, right=cols[i+1]?(col.left+cols[i+1].left)/2:Infinity;
          const raw=quoteRows(content.filter(p=>p.left>=left&&p.left<right&&!key(p.text)&&!/更多玩法/.test(p.text)),col.key==='moneyline'?3:2,col.key==='moneyline');
          if(!raw){bad=true;break;} evidence.push({key:col.key,rawRows:col.key==='runline'?[raw[away],raw[home]]:raw});
        }
        if(bad){issues.push('SOCCER_CARD_QUOTES_AMBIGUOUS');continue;}
        const [,month,day,hour,minute]=start.match;
        const cell=key=>({pair:evidence.find(x=>x.key===key)?.rawRows||['','']});
        rows.push({cells:[{pair:[`${month}-${day}`,`${hour.padStart(2,'0')}:${minute}`]},{pair:[teams[away].text,teams[home].text]},cell('runline'),cell('total'),cell('moneyline')]});
      }
    }
    return {tables:rows.length?[{headers:['時間','主客隊伍','讓分','大小盤','獨贏'],rows}]:[],diagnostics:{league,pageLeagueLabel:label,sawLeagueMarker:Boolean(label),gameCount:rows.length,expectedGameCount:count||null,excludedProps:excluded,cardIssues:[...new Set(issues)],conflictingGameKeys:[]}};
  }
  globalThis.Tai888SoccerCardNormalizer=Object.freeze({normalize});
})();
