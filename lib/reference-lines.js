export const REFERENCE_LINES_VERSION = 'REFERENCE-LINES-2026-08-v1.0.0';

const clean = value => String(value || '').trim();
const normalized = value => clean(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const median = values => {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
const latestIso = values => values.map(clean).filter(Boolean).sort().at(-1) || null;

const TEAM_ALIASES = {
  arizonadiamondbacks: ['亞利桑那響尾蛇', '亞歷桑那響尾蛇', '響尾蛇'],
  athletics: ['運動家', '奧克蘭運動家', '薩克拉門托運動家'],
  atlantabraves: ['亞特蘭大勇士', '亞特蘭大勇士隊', '勇士'],
  baltimoreorioles: ['巴爾的摩金鶯', '巴爾的摩金鶯隊', '金鶯'],
  bostonredsox: ['波士頓紅襪', '紅襪'],
  chicagocubs: ['芝加哥小熊', '小熊'],
  chicagowhitesox: ['芝加哥白襪', '白襪'],
  cincinnatireds: ['辛辛那提紅人', '紅人'],
  clevelandguardians: ['克里夫蘭守護者', '克里夫蘭守護神', '守護者'],
  coloradorockies: ['科羅拉多洛磯', '科羅拉多落磯', '洛磯', '落磯'],
  detroittigers: ['底特律老虎', '老虎'],
  houstonastros: ['休士頓太空人', '休斯頓太空人', '太空人'],
  kansascityroyals: ['堪薩斯市皇家', '堪薩斯皇家', '皇家'],
  losangelesangels: ['洛杉磯天使', '洛杉磯安那罕天使', '天使'],
  losangelesdodgers: ['洛杉磯道奇', '道奇'],
  miamimarlins: ['邁阿密馬林魚', '邁阿密馬林魚隊', '馬林魚'],
  milwaukeebrewers: ['密爾瓦基釀酒人', '釀酒人'],
  minnesotatwins: ['明尼蘇達雙城', '雙城'],
  newyorkmets: ['紐約大都會', '大都會'],
  newyorkyankees: ['紐約洋基', '洋基'],
  philadelphiaphillies: ['費城費城人', '費城人'],
  pittsburghpirates: ['匹茲堡海盜', '海盜'],
  sandiegopadres: ['聖地牙哥教士', '聖地亞哥教士', '教士'],
  sanfranciscogiants: ['舊金山巨人', '巨人'],
  seattlemariners: ['西雅圖水手', '水手'],
  stlouiscardinals: ['聖路易紅雀', '聖路易斯紅雀', '紅雀'],
  tampabayrays: ['坦帕灣光芒', '坦帕灣魔鬼魚', '光芒'],
  texasrangers: ['德州遊騎兵', '德州騎兵', '遊騎兵'],
  torontobluejays: ['多倫多藍鳥', '藍鳥'],
  washingtonnationals: ['華盛頓國民', '國民'],
};

const aliasLookup = new Map();
for (const [canonical, aliases] of Object.entries(TEAM_ALIASES)) {
  aliasLookup.set(normalized(canonical), canonical);
  for (const alias of aliases) aliasLookup.set(normalized(alias), canonical);
}

export function canonicalTeam(value) {
  const key = normalized(value);
  if (!key) return '';
  if (aliasLookup.has(key)) return aliasLookup.get(key);
  for (const [alias, canonical] of aliasLookup.entries()) {
    if (alias.length >= 3 && (key.includes(alias) || alias.includes(key))) return canonical;
  }
  return key;
}

function sameTeam(left, right) {
  const a = canonicalTeam(left);
  const b = canonicalTeam(right);
  return Boolean(a && b && a === b);
}

function scheduleMatch(event, schedule) {
  const candidates = (Array.isArray(schedule) ? schedule : []).filter(game => (
    sameTeam(event?.away, game?.away) || sameTeam(event?.away, game?.awayEnglish)
  ) && (
    sameTeam(event?.home, game?.home) || sameTeam(event?.home, game?.homeEnglish)
  ));
  if (candidates.length <= 1) return candidates[0] || null;
  const eventTime = Date.parse(event?.time || event?.commence_time || '');
  if (!Number.isFinite(eventTime)) return candidates[0];
  return [...candidates].sort((left, right) => (
    Math.abs(Date.parse(left.gameDate || '') - eventTime) - Math.abs(Date.parse(right.gameDate || '') - eventTime)
  ))[0];
}

function decimalOddsToWater(value) {
  const odds = Number(value);
  const water = odds - 1;
  if (!Number.isFinite(odds) || odds <= 1 || water < 0.5 || water > 1.5) return null;
  return Number(water.toFixed(6));
}

function lineText(value) {
  const number = Math.abs(Number(value));
  if (!Number.isFinite(number)) return '';
  if (Math.abs(number) < 1e-12) return '0平';
  return Number.isInteger(number) ? String(number) : String(Number(number.toFixed(2)));
}

function chooseMain(object) {
  const rows = Object.entries(object && typeof object === 'object' ? object : {});
  if (!rows.length) return null;
  return rows.find(([, value]) => value?.m === true) || rows[0];
}

function referenceRow({ market, pick, decimalOdds, observedAt, provider, sourceType, sourceLabel, eventId }) {
  const water = decimalOddsToWater(decimalOdds);
  if (water == null) return null;
  return {
    market,
    pick,
    water,
    rawDecimalOdds: Number(decimalOdds),
    priceFormat: 'DECIMAL_ODDS',
    waterEstimated: false,
    confidence: 1,
    sourceType,
    sourceLabel,
    provider,
    providerEventId: clean(eventId),
    lineAsOf: observedAt || new Date().toISOString(),
    executable: false,
    marketVerification: null,
  };
}

function jbotMarkets(raw, game) {
  const odds = Array.isArray(raw?.odds) ? raw.odds.at(-1) : null;
  if (!odds) return [];
  const provider = 'JBOT_TAIWAN_SPORTS_LOTTERY';
  const sourceType = 'REFERENCE';
  const sourceLabel = '台灣運彩參考盤｜JBot API';
  const observedAt = clean(odds.update || raw.time) || new Date().toISOString();
  const result = [];

  const spread = chooseMain(odds.handi);
  if (spread) {
    const [pointKey, prices] = spread;
    const point = Number(pointKey);
    const token = lineText(point);
    if (token) {
      const homeGiving = point <= 0;
      const homePick = `${game.home}${homeGiving ? '讓' : '受讓'}${token}`;
      const awayPick = `${game.away}${homeGiving ? '受讓' : '讓'}${token}`;
      const awayRow = referenceRow({ market: '全場讓分', pick: awayPick, decimalOdds: prices?.a, observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
      const homeRow = referenceRow({ market: '全場讓分', pick: homePick, decimalOdds: prices?.h, observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
      if (awayRow && homeRow) result.push(awayRow, homeRow);
    }
  }

  const total = chooseMain(odds.total);
  if (total) {
    const [pointKey, prices] = total;
    const token = lineText(pointKey);
    const over = referenceRow({ market: '全場大小', pick: `大${token}`, decimalOdds: prices?.o, observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
    const under = referenceRow({ market: '全場大小', pick: `小${token}`, decimalOdds: prices?.u, observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
    if (over && under) result.push(over, under);
  }
  return result;
}

export function normalizeJbotReference(payload, schedule = []) {
  if (payload?.status && String(payload.status).toUpperCase() !== 'OK') throw new Error(`JBot API 回覆：${payload.status}`);
  const matched = [];
  const unmatched = [];
  for (const raw of Array.isArray(payload?.data) ? payload.data : []) {
    const game = scheduleMatch(raw, schedule);
    if (!game) {
      unmatched.push({ away: clean(raw?.away), home: clean(raw?.home), time: clean(raw?.time), providerEventId: clean(raw?.id) });
      continue;
    }
    const markets = jbotMarkets(raw, game);
    if (!markets.length) continue;
    matched.push({
      gamePk: game.gamePk,
      game,
      source: {
        provider: 'JBOT_TAIWAN_SPORTS_LOTTERY',
        label: '台灣運彩參考盤｜JBot API',
        sourceType: 'REFERENCE',
        observedAt: latestIso(markets.map(row => row.lineAsOf)),
        providerEventId: clean(raw?.id),
        updateFrequency: '約10～20分鐘',
      },
      markets,
    });
  }
  return { games: matched, unmatched };
}

function groupedConsensus(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].sort((left, right) => right[1].length - left[1].length)[0] || null;
}

function oddsApiMarkets(raw, game) {
  const spreads = [];
  const totals = [];
  for (const bookmaker of Array.isArray(raw?.bookmakers) ? raw.bookmakers : []) {
    for (const market of Array.isArray(bookmaker?.markets) ? bookmaker.markets : []) {
      const observedAt = clean(bookmaker.last_update || raw.commence_time);
      if (market.key === 'spreads') {
        const home = market.outcomes?.find(row => sameTeam(row.name, raw.home_team));
        const away = market.outcomes?.find(row => sameTeam(row.name, raw.away_team));
        if (home && away && Number.isFinite(Number(home.point)) && Number.isFinite(Number(away.point))) spreads.push({ home, away, observedAt });
      }
      if (market.key === 'totals') {
        const over = market.outcomes?.find(row => /^over$/i.test(row.name));
        const under = market.outcomes?.find(row => /^under$/i.test(row.name));
        if (over && under && Number.isFinite(Number(over.point))) totals.push({ over, under, observedAt });
      }
    }
  }

  const provider = 'THE_ODDS_API_CONSENSUS';
  const sourceType = 'INTERNATIONAL';
  const sourceLabel = '國際市場參考盤｜The Odds API';
  const result = [];
  const spreadGroup = groupedConsensus(spreads, row => Number(row.home.point).toFixed(2));
  if (spreadGroup) {
    const rows = spreadGroup[1];
    const point = Number(rows[0].home.point);
    const token = lineText(point);
    const homeGiving = point <= 0;
    const awayOdds = median(rows.map(row => row.away.price));
    const homeOdds = median(rows.map(row => row.home.price));
    const observedAt = latestIso(rows.map(row => row.observedAt));
    const away = referenceRow({ market: '全場讓分', pick: `${game.away}${homeGiving ? '受讓' : '讓'}${token}`, decimalOdds: awayOdds, observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
    const home = referenceRow({ market: '全場讓分', pick: `${game.home}${homeGiving ? '讓' : '受讓'}${token}`, decimalOdds: homeOdds, observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
    if (away && home) result.push(away, home);
  }
  const totalGroup = groupedConsensus(totals, row => Number(row.over.point).toFixed(2));
  if (totalGroup) {
    const rows = totalGroup[1];
    const token = lineText(rows[0].over.point);
    const observedAt = latestIso(rows.map(row => row.observedAt));
    const over = referenceRow({ market: '全場大小', pick: `大${token}`, decimalOdds: median(rows.map(row => row.over.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
    const under = referenceRow({ market: '全場大小', pick: `小${token}`, decimalOdds: median(rows.map(row => row.under.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id });
    if (over && under) result.push(over, under);
  }
  return result;
}

export function normalizeOddsApiReference(payload, schedule = []) {
  const games = [];
  const unmatched = [];
  for (const raw of Array.isArray(payload) ? payload : []) {
    const event = { away: raw.away_team, home: raw.home_team, time: raw.commence_time };
    const game = scheduleMatch(event, schedule);
    if (!game) {
      unmatched.push({ away: clean(raw.away_team), home: clean(raw.home_team), time: clean(raw.commence_time), providerEventId: clean(raw.id) });
      continue;
    }
    const markets = oddsApiMarkets(raw, game);
    if (!markets.length) continue;
    games.push({
      gamePk: game.gamePk,
      game,
      source: {
        provider: 'THE_ODDS_API_CONSENSUS',
        label: '國際市場參考盤｜The Odds API',
        sourceType: 'INTERNATIONAL',
        observedAt: latestIso(markets.map(row => row.lineAsOf)),
        providerEventId: clean(raw.id),
      },
      markets,
    });
  }
  return { games, unmatched };
}

export function referenceProviderStatus(env = process.env) {
  const jbot = Boolean(env.JBOT_API_TOKEN || env.SPORTSBOT_API_TOKEN || env.JBOT_TOKEN);
  const odds = Boolean(env.THE_ODDS_API_KEY);
  return {
    configured: jbot || odds,
    primary: jbot ? 'JBOT_TAIWAN_SPORTS_LOTTERY' : odds ? 'THE_ODDS_API_CONSENSUS' : null,
    providers: [
      { id: 'JBOT_TAIWAN_SPORTS_LOTTERY', configured: jbot, label: '台灣運彩參考盤｜JBot API' },
      { id: 'THE_ODDS_API_CONSENSUS', configured: odds, label: '國際市場參考盤｜The Odds API' },
    ],
  };
}
