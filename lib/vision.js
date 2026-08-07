export function cleanVisionJSON(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  s = s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  return JSON.parse(s);
}

export function normalizeTeamName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sameTeam(a, b) {
  const x = normalizeTeamName(a), y = normalizeTeamName(b);
  return Boolean(x && y && (x === y || x.includes(y) || y.includes(x)));
}

export function matchScheduleGame(raw, schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return null;
  if (raw?.gamePk != null) {
    const exact = schedule.find(g => String(g.gamePk) === String(raw.gamePk));
    if (exact) return exact;
  }
  const matches = schedule.filter(g => sameTeam(raw?.away, g.away) && sameTeam(raw?.home, g.home));
  return matches.length === 1 ? matches[0] : null;
}

export function buildVisionPrompt(schedule, textMode = false) {
  const slate = (schedule || []).map(g => `${g.gamePk}: ${g.away} @ ${g.home}`).join('\n');
  return `你是台灣信用盤 MLB 盤口擷取器。${textMode ? '使用者提供的是盤口文字。' : '使用者提供的是盤口截圖。'}只擷取資料，不做投注推薦。
今天可配對的 MLB 賽事：\n${slate || '未提供'}

逐場輸出以下精簡結構：
- gamePk：能確定配對時填上方編號，否則 null
- away/home：客隊與主隊，順序不可顛倒
- fullRunline/first5Runline：favoriteSide 只能是 away、home 或 null；line 保留台灣格式（例 1平、1+50、1-20、0-70）；favoriteWater/underdogWater 為 0.940 等水位
- fullTotal/first5Total：line 保留台灣格式（例 8+50、8-30）；overWater/underWater 為水位
- confidence 0~1

重要規則：
1. 盤口數字不能和水位混淆；同一場不得串到相鄰場。
2. 讓分兩方共用同一條 line；大小兩方共用同一條 line。
3. 看不清楚使用空字串或 null，絕對不要猜數字。
4. 只回單一、完整、可直接 JSON.parse 的 JSON 物件；不要 markdown、不要解釋。
格式：{"games":[{"gamePk":null,"away":"","home":"","confidence":0,"fullRunline":{"favoriteSide":null,"line":"","favoriteWater":null,"underdogWater":null,"confidence":0},"fullTotal":{"line":"","overWater":null,"underWater":null,"confidence":0},"first5Runline":{"favoriteSide":null,"line":"","favoriteWater":null,"underdogWater":null,"confidence":0},"first5Total":{"line":"","overWater":null,"underWater":null,"confidence":0}}]}`;
}
