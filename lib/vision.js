export const VISION_VERSION = 'MLB-VISION-2026-08-v8.2.1';

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const finiteOrNull = value => {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};
const shortText = (value, maximum = 120) => String(value || '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maximum);

export function cleanVisionJSON(text) {
  let value = String(text || '').trim();
  if (value.length > 500000) throw new Error('人工智慧回傳資料過大');
  value = value.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');
  if (start >= 0 && end > start) value = value.slice(start, end + 1);
  value = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
  const parsed = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('人工智慧回傳格式錯誤');
  return parsed;
}

function compactRunline(value) {
  const source = Array.isArray(value) ? {
    lineSide: value[0], line: value[1], awayWater: value[2], homeWater: value[3], confidence: value[4],
  } : value && typeof value === 'object' ? value : {};
  const lineSide = ['away', 'home'].includes(source.lineSide || source.listedSide || source.favoriteSide)
    ? (source.lineSide || source.listedSide || source.favoriteSide)
    : null;
  const favoriteWater = finiteOrNull(source.favoriteWater);
  const underdogWater = finiteOrNull(source.underdogWater);
  const awayWater = finiteOrNull(source.awayWater ?? (lineSide === 'away' ? favoriteWater : underdogWater));
  const homeWater = finiteOrNull(source.homeWater ?? (lineSide === 'home' ? favoriteWater : underdogWater));
  return {
    lineSide,
    favoriteSide: lineSide,
    line: shortText(source.line, 24),
    awayWater,
    homeWater,
    favoriteWater: lineSide === 'away' ? awayWater : lineSide === 'home' ? homeWater : favoriteWater,
    underdogWater: lineSide === 'away' ? homeWater : lineSide === 'home' ? awayWater : underdogWater,
    confidence: clamp(Number(source.confidence) || 0, 0, 1),
  };
}

function compactTotal(value) {
  if (Array.isArray(value)) {
    return {
      line: shortText(value[0], 24),
      overWater: finiteOrNull(value[1]),
      underWater: finiteOrNull(value[2]),
      confidence: clamp(Number(value[3]) || 0, 0, 1),
    };
  }
  const source = value && typeof value === 'object' ? value : {};
  return {
    line: shortText(source.line, 24),
    overWater: finiteOrNull(source.overWater),
    underWater: finiteOrNull(source.underWater),
    confidence: clamp(Number(source.confidence) || 0, 0, 1),
  };
}

export function expandVisionPayload(payload) {
  if (Array.isArray(payload?.games)) {
    return {
      games: payload.games.slice(0, 40).map(row => ({
        ...row,
        away: shortText(row?.away, 100),
        home: shortText(row?.home, 100),
        confidence: clamp(Number(row?.confidence) || 0, 0, 1),
        fullRunline: compactRunline(row?.fullRunline),
        fullTotal: compactTotal(row?.fullTotal),
        first5Runline: compactRunline(row?.first5Runline),
        first5Total: compactTotal(row?.first5Total),
      })),
    };
  }

  const rows = Array.isArray(payload?.g) ? payload.g : [];
  return {
    games: rows.slice(0, 40).map(row => ({
      gamePk: row?.id ?? row?.gamePk ?? null,
      away: shortText(row?.a ?? row?.away, 100),
      home: shortText(row?.h ?? row?.home, 100),
      confidence: clamp(Number(row?.c ?? row?.confidence) || 0, 0, 1),
      fullRunline: compactRunline(row?.fr ?? row?.fullRunline),
      fullTotal: compactTotal(row?.ft ?? row?.fullTotal),
      first5Runline: compactRunline(row?.r5 ?? row?.first5Runline),
      first5Total: compactTotal(row?.t5 ?? row?.first5Total),
    })),
  };
}

export function normalizeTeamName(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
}

function sameTeam(first, second) {
  const left = normalizeTeamName(first);
  const right = normalizeTeamName(second);
  return Boolean(left && right && (left === right || (left.length >= 2 && right.length >= 2 && (left.includes(right) || right.includes(left)))));
}

function sideMatches(rawName, game, side) {
  return [game?.[side], game?.[`${side}English`]].filter(Boolean).some(name => sameTeam(rawName, name));
}

export function matchScheduleGame(raw, schedule) {
  if (!Array.isArray(schedule) || !schedule.length) return null;
  if (raw?.gamePk != null) {
    const exact = schedule.find(game => String(game.gamePk) === String(raw.gamePk));
    if (exact) {
      const hasNames = Boolean(raw?.away || raw?.home);
      if (!hasNames || (sideMatches(raw?.away, exact, 'away') && sideMatches(raw?.home, exact, 'home'))) return exact;
    }
  }
  const matches = schedule.filter(game => sideMatches(raw?.away, game, 'away') && sideMatches(raw?.home, game, 'home'));
  return matches.length === 1 ? matches[0] : null;
}

function slateText(schedule) {
  return (schedule || []).map(game => {
    const away = game.awayEnglish ? `${game.away}/${game.awayEnglish}` : game.away;
    const home = game.homeEnglish ? `${game.home}/${game.homeEnglish}` : game.home;
    return `${game.gamePk}:${away}@${home}`;
  }).join('\n');
}

export function buildVisionDiscoveryPrompt(schedule) {
  return `你是 MLB 台灣信用盤圖片的「場次列舉器」。只找圖片中實際可見的對戰，不讀盤口、不做推薦。\n可配對賽事：\n${slateText(schedule) || '未提供'}\n\n從圖片最上方掃到最下方，回傳所有可見且能配對的 gamePk，順序與圖片一致。不能只回前幾場；局部裁切列也要盡量配對。只回 JSON：{"ids":[123,456]}`;
}

export function buildVisionPrompt(schedule, textMode = false) {
  return `你是台灣信用盤 MLB 盤口擷取器。${textMode ? '輸入含盤口文字。' : '輸入含盤口截圖。'}只擷取畫面中實際可見資料，不做推薦。\n可配對賽事：\n${slateText(schedule) || '未提供'}\n\n圖片表格欄位由左到右固定是：時間｜主客隊伍｜讓球｜大小盤｜獨贏｜一輸二贏｜上半讓球｜上半大小。獨贏與一輸二贏欄完全忽略，絕不可把其中數字當成讓分、大小或水位。\n規則：\n1. 客隊在上列、主隊在下列；awayWater 只取客隊列「讓球」欄的 0.xxx，homeWater 只取主隊列同一欄。上半讓球同理，只能取「上半讓球」欄。\n2. 非零讓分 line 印在哪一隊的列，該隊就是 lineSide／讓方；不得按球隊強弱猜。0 盤仍回傳 line 所在列。\n3. 大小 line 是大分方向的完整台灣盤尾數，例如 8-80、7+50、8平；大／小水位只能取同一大小欄的 0.xxx。\n4. line 的 +50/-80 是卡洞尾數，不是賠付水位。賠付水位是 0.940、0.950。\n5. 未開盤市場填 null；只看到一邊水位時另一邊必須 null；禁止拿相鄰欄或相鄰場補數字。\n6. 逐列輸出每一個可見對戰；部分欄位不清楚也不能漏掉整場。只回單一合法 JSON。\n\n短鍵格式：\n{"g":[{"id":gamePk,"a":"客隊","h":"主隊","c":0到1,"fr":["away或home或null","全場讓分line",客隊讓球水位或null,主隊讓球水位或null,信心],"ft":["全場大小line",大分水位或null,小分水位或null,信心],"r5":["away或home或null","上半讓分line",客隊上半讓球水位或null,主隊上半讓球水位或null,信心],"t5":["上半大小line",大分水位或null,小分水位或null,信心]}]}\n市場未開盤時該鍵填 null。`;
}

export function buildVisionTargetPrompt(schedule, targetGamePks) {
  const ids = new Set((targetGamePks || []).map(String));
  const target = (schedule || []).filter(game => ids.has(String(game.gamePk)));
  return `${buildVisionPrompt(target, false)}\n\n這是精準補掃。只輸出上述 ${target.length} 場；在整張圖片中定位各自的兩列，逐欄擷取。若某場確實不在圖片，該場不要輸出。`;
}
