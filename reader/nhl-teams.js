(() => {
  // NHL canonical identity only. A provider code/name is never a game ID;
  // the server must still reconcile the date/time and both teams to NHL data.
  const rows = [
    ['ANA', 24, ['ANA', 'ANH'], ['Anaheim Ducks', '安那罕鴨', '安納罕鴨', '阿納海姆鴨', '鸭队']],
    ['BOS', 6, ['BOS'], ['Boston Bruins', '波士頓棕熊', '波士顿棕熊', '棕熊']],
    ['BUF', 7, ['BUF'], ['Buffalo Sabres', '水牛城軍刀', '布法羅軍刀', '布法罗军刀', '軍刀', '军刀']],
    ['CGY', 20, ['CGY', 'CAL'], ['Calgary Flames', '卡加利火焰', '卡尔加里火焰', '火焰']],
    ['CAR', 12, ['CAR'], ['Carolina Hurricanes', '卡羅萊納颶風', '卡罗来纳飓风', '颶風', '飓风']],
    ['CHI', 16, ['CHI'], ['Chicago Blackhawks', '芝加哥黑鷹', '芝加哥黑鹰', '黑鷹', '黑鹰']],
    ['COL', 21, ['COL'], ['Colorado Avalanche', '科羅拉多雪崩', '科罗拉多雪崩', '雪崩']],
    ['CBJ', 29, ['CBJ', 'CLB'], ['Columbus Blue Jackets', '哥倫布藍衣', '哥伦布蓝衣', '藍衣', '蓝衣']],
    ['DAL', 25, ['DAL'], ['Dallas Stars', '達拉斯星', '达拉斯星', '星隊']],
    ['DET', 17, ['DET'], ['Detroit Red Wings', '底特律紅翼', '底特律红翼', '紅翼', '红翼']],
    ['EDM', 22, ['EDM'], ['Edmonton Oilers', '艾德蒙頓油人', '埃德蒙頓油人', '埃德蒙顿油人', '油人']],
    ['FLA', 13, ['FLA', 'FLR'], ['Florida Panthers', '佛羅里達美洲豹', '佛罗里达美洲豹', '佛羅里達黑豹', '佛罗里达黑豹', '美洲豹']],
    ['LAK', 26, ['LAK', 'LA'], ['Los Angeles Kings', '洛杉磯國王', '洛杉矶国王', '國王', '国王']],
    ['MIN', 30, ['MIN'], ['Minnesota Wild', '明尼蘇達荒野', '明尼苏达荒野', '明尼蘇達狂野', '明尼苏达狂野', '荒野', '狂野']],
    ['MTL', 8, ['MTL', 'MON'], ['Montreal Canadiens', '蒙特婁加拿大人', '蒙特利爾加拿大人', '蒙特利尔加拿大人', '加拿大人']],
    ['NSH', 18, ['NSH', 'NAS'], ['Nashville Predators', '納許維爾掠奪者', '納什維爾掠奪者', '纳什维尔掠夺者', '掠奪者', '掠夺者']],
    ['NJD', 1, ['NJD', 'NJ'], ['New Jersey Devils', '紐澤西魔鬼', '新澤西魔鬼', '新泽西魔鬼', '魔鬼']],
    ['NYI', 2, ['NYI'], ['New York Islanders', '紐約島人', '纽约岛人', '島人', '岛人']],
    ['NYR', 3, ['NYR'], ['New York Rangers', '紐約遊騎兵', '纽约游骑兵', '遊騎兵', '游骑兵']],
    ['OTT', 9, ['OTT'], ['Ottawa Senators', '渥太華參議員', '渥太华参议员', '參議員', '参议员']],
    ['PHI', 4, ['PHI'], ['Philadelphia Flyers', '費城飛人', '费城飞人', '飛人', '飞人']],
    ['PIT', 5, ['PIT'], ['Pittsburgh Penguins', '匹茲堡企鵝', '匹兹堡企鹅', '企鵝', '企鹅']],
    ['SJS', 28, ['SJS', 'SJ'], ['San Jose Sharks', '聖荷西鯊魚', '聖何塞鯊魚', '圣何塞鲨鱼', '鯊魚', '鲨鱼']],
    ['SEA', 55, ['SEA'], ['Seattle Kraken', '西雅圖海怪', '西雅图海怪', '海怪']],
    ['STL', 19, ['STL'], ['St. Louis Blues', 'St Louis Blues', '聖路易藍調', '圣路易斯蓝调', '藍調', '蓝调']],
    ['TBL', 14, ['TBL', 'TB', 'TAM'], ['Tampa Bay Lightning', '坦帕灣閃電', '坦帕湾闪电', '閃電', '闪电']],
    ['TOR', 10, ['TOR'], ['Toronto Maple Leafs', '多倫多楓葉', '多伦多枫叶', '楓葉', '枫叶']],
    // NHL's current catalog assigns Mammoth 68, distinct from the former
    // Hockey Club 59; historical identities are never rewritten by the Reader.
    ['UTA', 68, ['UTA', 'UTAH'], ['Utah Mammoth', '猶他猛獁', '犹他猛犸', '猶他冰球', '犹他冰球', '猛獁', '猛犸']],
    ['VAN', 23, ['VAN'], ['Vancouver Canucks', '溫哥華加人', '温哥华加人', '加人']],
    ['VGK', 54, ['VGK', 'VEG'], ['Vegas Golden Knights', '維加斯黃金騎士', '维加斯黄金骑士', '拉斯維加斯黃金騎士', '黃金騎士', '黄金骑士']],
    ['WPG', 52, ['WPG', 'WIN'], ['Winnipeg Jets', '溫尼伯噴射機', '温尼伯喷气机', '噴射機', '喷气机']],
    ['WSH', 15, ['WSH', 'WAS'], ['Washington Capitals', '華盛頓首都', '华盛顿首都', '首都']],
  ];
  const teams = Object.freeze(rows.map(([code, teamId, codes, names]) => Object.freeze({ code, teamId, codes: Object.freeze(codes), names: Object.freeze(names) })));
  const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const byCode = value => teams.find(team => team.codes.includes(clean(value).toUpperCase())) || null;
  function named(value) {
    const text = clean(value).toLowerCase();
    return teams.filter(team => team.names.some(alias => text.includes(alias.toLowerCase())));
  }
  function resolve(value) {
    const text = clean(value);
    const code = text.match(/^([A-Z]{2,4})(?:\s*-\s*|\s+|$)/)?.[1];
    const coded = code ? byCode(code) : null;
    const names = named(text);
    if (names.length > 1 || (coded && names.length && coded.code !== names[0].code)) return null;
    return coded || (names.length === 1 ? names[0] : null);
  }
  globalThis.Tai888NhlTeams = Object.freeze({ teams, byCode, resolve });
})();
