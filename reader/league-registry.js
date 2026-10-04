(() => {
  const leagues = Object.freeze({
    MLB: Object.freeze({ id: 'MLB', label: '美棒', marker: /(?:聯盟|联盟)\s*[:：]?\s*MLB\s*(?:美國職棒|美国职棒)/i }),
    NPB: Object.freeze({ id: 'NPB', label: '日棒', marker: /(?:聯盟|联盟)\s*[:：]?\s*NPB\s*(?:日本職業棒球|日本职业棒球|日本職棒|日本职棒)/i }),
    KBO: Object.freeze({ id: 'KBO', label: '韓棒', marker: /(?:聯盟|联盟)\s*[:：]?\s*KBO\s*(?:韓國職棒|韩国职棒)/i }),
    CPBL: Object.freeze({ id: 'CPBL', label: '中職', marker: /(?:聯盟|联盟)\s*[:：]?\s*CPBL\s*(?:中華職棒|中华职棒|台灣職棒|台湾职棒)/i }),
    NBA: Object.freeze({ id: 'NBA', label: '美籃', marker: /(?:聯盟|联盟)\s*[:：]?\s*NBA(?=\s|[-－–—:：（(]|$)/i }),
  });
  const ids = Object.freeze(Object.keys(leagues));
  const special = /(?:走地(?:中)?|滾球|滚球|即時|即时|LIVE|IN[ -]?PLAY|總得分|总得分|主隊|主队|客隊|客队|單隊|单队|特殊|球隊得分|球队得分)/i;

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
    // NBA identity is the scoped league token, never its changing display name
    // or season description. Market columns still determine full-game/half odds.
    // Reject separate period/prop contracts rather than allow-listing seasons.
    if (league === 'NBA') return !/(?:第\s*[一二三四五六七八九十\d]+\s*(?:節|节|局)|單節|单节|節盤|节盘|上半|下半|半場|半场|前\s*(?:五|5)|分數|分数|合約|合约|勝分差|胜分差|加時|加时|延長|延长|\b(?:QUARTER|HALF|OVERTIME|PROPS?|Q[1-4]|[1-4]Q)\b)/i.test(suffix);
    return /^\s*(?:[（(]\s*\d{1,2}\s*[）)])?\s*$/.test(suffix);
  }

  globalThis.Tai888LeagueRegistry = Object.freeze({ ids, leagues, identify, identifyAll, standardMarker, version: 'TAI888-LEAGUES-v2.2.0' });
})();
