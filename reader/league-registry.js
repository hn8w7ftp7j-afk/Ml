(() => {
  const leagues = Object.freeze({
    MLB: Object.freeze({ id: 'MLB', label: '美棒', marker: /(?:聯盟|联盟)\s*[:：]?\s*MLB\s*(?:美國職棒|美国职棒)/i }),
    NPB: Object.freeze({ id: 'NPB', label: '日棒', marker: /(?:聯盟|联盟)\s*[:：]?\s*NPB\s*(?:日本職業棒球|日本职业棒球|日本職棒|日本职棒)/i }),
    KBO: Object.freeze({ id: 'KBO', label: '韓棒', marker: /(?:聯盟|联盟)\s*[:：]?\s*KBO\s*(?:韓國職棒|韩国职棒)/i }),
    CPBL: Object.freeze({ id: 'CPBL', label: '中職', marker: /(?:聯盟|联盟)\s*[:：]?\s*CPBL\s*(?:中華職棒|中华职棒|台灣職棒|台湾职棒)/i }),
    NBA: Object.freeze({ id: 'NBA', label: '美籃', marker: /(?:聯盟|联盟)\s*[:：]?\s*NBA(?=\s|[-－–—:：（(]|美國職業籃球|美国职业篮球|美國職籃|美国职篮|$)/i }),
    NHL: Object.freeze({ id: 'NHL', label: '冰球', marker: /(?:^(?=NHL(?:國家冰球聯盟|国家冰球联盟|美式冰球))|(?:聯盟|联盟)\s*[:：]?\s*)NHL(?=\s|[-－–—:：（(]|美式冰球|國家冰球|国家冰球|美國職業冰球|美国职业冰球|$)/i }),
    EPL: Object.freeze({ id: 'EPL', label: '英超', marker: /^(?:(?:聯盟|联盟)\s*[:：]?\s*)?(?:(?:EPL\s*[-:：]?\s*)?(?:英格蘭|英格兰|英國|英国)(?:足球)?(?:超級|超级)(?:足球)?(?:聯賽|联赛)|英超(?:聯賽|联赛)?|English Premier League|EPL(?=\s|[-:：（(]|$))/i }),
    UCL: Object.freeze({ id: 'UCL', label: '歐冠', marker: /^(?:(?:聯盟|联盟)\s*[:：]?\s*)?(?:(?:UCL\s*[-:：]?\s*)?歐洲(?:冠軍聯賽|冠军联赛|聯賽冠軍盃)|歐冠(?:聯賽|联赛)?|UEFA Champions League|UCL(?=\s|[-:：（(]|$))/i }),
  });
  const ids = Object.freeze(Object.keys(leagues));
  const special = /(?:走地(?:中)?|滾球|滚球|即時|即时|LIVE|IN[ -]?PLAY|總得分|总得分|主隊|主队|客隊|客队|單隊|单队|特殊|球隊得分|球队得分)/i;
  const soccerExcluded = /(?:角球|罰牌|罚牌|CORNERS?|球員|球员|PLAYERS?|PROPS?|主隊|主队|客隊|客队|單隊|单队|TEAM[ -]?TOTALS?|黃牌|黄牌|紅牌|红牌|卡牌|BOOKINGS?|青年|女子|U\s*\d{2}|WOMEN|YOUTH|下半|第\s*[二2]\s*半|SECOND\s+HALF|2ND\s+HALF|\b2H\b|加時|加时|延長|延长|OVERTIME|EXTRA\s+TIME|第\s*[一二三四\d]+\s*[節节局]|走地|滾球|滚球|即時|即时|\bLIVE\b|IN[ -]?PLAY)/i;
  const soccerFirstHalf = /(?:上半(?:場|场)?|第\s*[一1]\s*半(?:場|场)?|前\s*45\s*(?:分鐘|分钟)|FIRST\s+HALF|1ST\s+HALF|\b1H\b|\bHT\b)/i;
  const soccerFullTime = /(?:全(?:場|场)|正規時間|正规时间|常規時間|常规时间|90\s*(?:分鐘|分钟|MIN(?:UTES?)?)|FULL[ -]?TIME|\bFT\b)/i;
  const bounded = (value,maximum=240) => String(value || '').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim().slice(0,maximum);

  // Period is an observation of a scoped heading, never a verified settlement rule.
  function soccerPeriodEvidence({sectionTitle='',headers=[],marketHeader='',truncated=false}={}) {
    const title=bounded(sectionTitle),tableHeaders=Array.isArray(headers)?headers.slice(0,12).map(v=>bounded(v,160)):[],column=bounded(marketHeader,160);
    const incomplete=truncated===true||String(sectionTitle).length>240||String(marketHeader).length>160||Array.isArray(headers)&&(headers.length>12||headers.some(value=>String(value).length>160));
    const evidence={sectionTitle:title,tableHeaders,marketHeader:column||null,...(incomplete?{truncated:true}:{})};
    // Only standalone scope qualifiers apply to the entire table. Do not
    // borrow a sibling corner/prop market or match the normal team column.
    const excludedScope=/^(?:LIVE|IN[ -]?PLAY|走地(?:中)?|滾球|滚球|即時|即时|(?:全場|全场)?角球(?:數|数|盤|盘)?|CORNERS?|下半(?:場|场)?|第\s*[二2]\s*半(?:場|场)?|SECOND\s+HALF|2ND\s+HALF|2H|加時|加时|延長|延长|OVERTIME|EXTRA\s+TIME|黃牌|黄牌|紅牌|红牌|卡牌|BOOKINGS?|PROPS?)$/i;
    if(soccerExcluded.test(title)||soccerExcluded.test(column)||tableHeaders.some(value=>excludedScope.test(value)))return{...evidence,period:'UNKNOWN',status:'EXCLUDED'};
    if(incomplete)return{...evidence,period:'UNKNOWN',status:'TRUNCATED'};
    const periods=text=>[...(soccerFullTime.test(text)?['FT']:[]),...(soccerFirstHalf.test(text)?['HT']:[])];
    // A dedicated header cell is table-wide evidence. A sibling market's
    // "HT handicap" label is not borrowed to classify an unlabelled total.
    const standalone=/^[（(]?\s*(?:全場|全场|上半場|上半场|上半|第[一1]半場|第[一1]半场|正規時間|正规时间|常規時間|常规时间|90\s*(?:分鐘|分钟|MIN(?:UTES?)?)|FULL[ -]?TIME|FIRST\s+HALF|1ST\s+HALF|FT|HT|1H)\s*[）)]?$/i;
    const headerPeriods=[...new Set(tableHeaders.filter(value=>standalone.test(value)).flatMap(periods))];
    const titlePeriods=periods(title),columnPeriods=periods(column);
    if(columnPeriods.length>1||(!columnPeriods.length&&titlePeriods.length>1)||columnPeriods.length===1&&titlePeriods.length===1&&columnPeriods[0]!==titlePeriods[0])return{...evidence,period:'UNKNOWN',status:'CONFLICT'};
    const specific=columnPeriods[0]||titlePeriods[0];
    if(specific&&headerPeriods.length===1&&specific!==headerPeriods[0]||!specific&&headerPeriods.length>1)return{...evidence,period:'UNKNOWN',status:'CONFLICT'};
    const period=specific||headerPeriods[0]||'UNKNOWN';
    return{...evidence,period,status:period==='UNKNOWN'?'UNKNOWN':'EXPLICIT'};
  }

  function identifyAll(text) {
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    return ids.filter(id => leagues[id].marker.test(value));
  }

  // `identify` is intentionally marker-scoped. Callers must pass one league
  // heading/section label, never document.body.innerText.
  function identify(text) {
    const found = identifyAll(text);
    return found.length === 1 ? found[0] : null;
  }

  function standardMarker(text, expectedLeague = '') {
    const league = identify(text);
    if (!league || (expectedLeague && league !== expectedLeague)) return false;
    const value = String(text || '').replace(/\s+/g, ' ').trim();
    if (special.test(value)) return false;
    // Keep v2.1.26's allow-list: unknown section suffixes are different contracts.
    const match = value.match(leagues[league].marker);
    if (!match || match.index !== 0) return false;
    const suffix = value.slice(match[0].length);
    if (['EPL','UCL'].includes(league)) return !soccerExcluded.test(suffix);
    // The normal full-game heading explicitly says "包括加時與點球".
    // Accept that display qualifier for raw evidence capture only; it neither
    // verifies settlement rules nor enables execution. Standalone OT, period,
    // team-total and regulation-only sections remain separate contracts.
    if (league === 'NHL') {
      const contractSuffix = suffix.replace(/(?:包括|包含)\s*(?:加時|加时)\s*(?:與|与|及)\s*(?:點球|点球)/g, '');
      return !/(?:第\s*[一二三四五六七八九十\d]+\s*(?:節|节|局)|單節|单节|節盤|节盘|上半|下半|半場|半场|正規|正规|常規時間|常规时间|60\s*分鐘|60\s*分钟|分數|分数|合約|合约|加時|加时|延長|延长|\b(?:PERIOD|REGULATION|OVERTIME|PROPS?|P[1-3]|[1-3]P)\b)/i.test(contractSuffix);
    }
    // NBA identity is the scoped league token, never its changing display name
    // or season description. Market columns still determine full-game/half odds.
    // Reject separate period/prop contracts rather than allow-listing seasons.
    if (league === 'NBA') {
      // Tai888 repeats the same events under 「主推過關」 with different
      // contracts. Bound those rows to their own section instead of mixing
      // their prices into the standard board and triggering false conflicts.
      if (/(?:過|过)\s*(?:關|关)|串\s*(?:關|关)|\b(?:PARLAYS?|ACCUMULATORS?)\b/i.test(suffix)) return false;
      return !/(?:第\s*[一二三四五六七八九十\d]+\s*(?:節|节|局)|單節|单节|節盤|节盘|上半|下半|半場|半场|前\s*(?:五|5)|分數|分数|合約|合约|勝分差|胜分差|加時|加时|延長|延长|\b(?:QUARTER|HALF|OVERTIME|PROPS?|Q[1-4]|[1-4]Q)\b)/i.test(suffix);
    }
    return /^\s*(?:[（(]\s*\d{1,2}\s*[）)])?\s*$/.test(suffix);
  }

  globalThis.Tai888LeagueRegistry = Object.freeze({ ids, leagues, identify, identifyAll, standardMarker, soccerPeriodEvidence, version: 'TAI888-LEAGUES-v2.2.0' });
})();
