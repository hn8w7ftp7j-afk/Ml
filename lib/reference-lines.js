import { providerTimestamp } from './reference-time.js';
import { parseTaiwanLine } from './markets.js';

export const REFERENCE_LINES_VERSION = 'REFERENCE-LINES-2026-08-v1.4.0';
export const MAX_REFERENCE_GAME_TIME_DISTANCE_MS = 90 * 60 * 1000;
export const MAX_REFERENCE_QUOTE_AGE_MS = 5 * 60 * 1000;
export const MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS = 90 * 1000;
export const MAX_CONSENSUS_QUOTE_SPAN_MS = 3 * 60 * 1000;
export const MAX_REFERENCE_PROBABILITY_SPREAD = 0.03;
export const MAX_REFERENCE_PROBABILITY_MAD = 0.01;
export const ODDS_API_EVENT_MARKETS = Object.freeze([
  'h2h',
  'spreads',
  'alternate_spreads',
  'totals',
  'alternate_totals',
  'spreads_1st_5_innings',
  'alternate_spreads_1st_5_innings',
  'totals_1st_5_innings',
  'alternate_totals_1st_5_innings',
]);

const clean = value => String(value || '').trim();
const normalized = value => clean(value).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');
const median = values => {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const middle = Math.floor(rows.length / 2);
  return rows.length % 2 ? rows[middle] : (rows[middle - 1] + rows[middle]) / 2;
};
const quantile = (values, probability) => {
  const rows = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!rows.length) return null;
  const position = Math.max(0, Math.min(rows.length - 1, Math.floor((rows.length - 1) * probability)));
  return rows[position];
};
const medianAbsoluteDeviation = values => {
  const centre = median(values);
  if (!Number.isFinite(centre)) return null;
  return median(values.map(value => Math.abs(Number(value) - centre)));
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

export function matchReferenceScheduleGame(event, schedule, {
  assumeTaipei = false,
  maximumDistanceMs = MAX_REFERENCE_GAME_TIME_DISTANCE_MS,
} = {}) {
  const candidates = (Array.isArray(schedule) ? schedule : []).filter(game => (
    sameTeam(event?.away, game?.away) || sameTeam(event?.away, game?.awayEnglish)
  ) && (
    sameTeam(event?.home, game?.home) || sameTeam(event?.home, game?.homeEnglish)
  ));
  const eventIso = providerTimestamp(event?.time || event?.commence_time, { assumeTaipei });
  const eventTime = Date.parse(eventIso || '');
  if (!candidates.length || !Number.isFinite(eventTime)) return null;
  const ranked = candidates.map(game => ({
    game,
    distance: Math.abs(Date.parse(game?.gameDate || '') - eventTime),
  })).filter(row => Number.isFinite(row.distance)).sort((left, right) => left.distance - right.distance);
  if (!ranked.length || ranked[0].distance > maximumDistanceMs) return null;
  if (ranked[1] && ranked[1].distance === ranked[0].distance) return null;
  return ranked[0].game;
}

export function filterReferenceGamesToTargets(games, targets) {
  if (!Array.isArray(targets) || !targets.length) return Array.isArray(games) ? games : [];
  const byGamePk = new Map(targets.map(target => {
    const contracts = (Array.isArray(target?.markets) ? target.markets : []).map(row => ({
      market: clean(row?.market),
      parsed: parseTaiwanLine(row?.pick),
    })).filter(row => row.parsed.valid && row.parsed.legs.length);
    return [Number(target?.gamePk), contracts];
  }));
  return (Array.isArray(games) ? games : []).map(game => {
    const contracts = byGamePk.get(Number(game?.gamePk || game?.game?.gamePk)) || [];
    const markets = (Array.isArray(game?.markets) ? game.markets : []).filter(reference => {
      const parsed = parseTaiwanLine(reference?.pick);
      if (!parsed.valid || parsed.legs.length !== 1) return false;
      const referenceLine = Number(parsed.legs[0]);
      // Keep both reference directions around every actual leg. Integer and
      // split Asian contracts need the adjacent half-lines to reconstruct
      // win/push/loss payoff vectors; anything farther away is unnecessary.
      return contracts.some(contract => contract.market === reference?.market
        && contract.parsed.legs.some(line => Math.abs(Number(line) - referenceLine) <= 0.500000001));
    });
    return { ...game, markets };
  }).filter(game => game.markets.length);
}

function decimalOddsToWater(value, { pairedPriceValidated = false } = {}) {
  const odds = Number(value);
  const water = odds - 1;
  // Alternate markets routinely contain asymmetric prices outside the old
  // 1.50-2.50 main-line band. Pair-level overround validation below is the
  // safety boundary; retain the original decimal price for payoff-aware
  // reconstruction instead of silently discarding a valid alternate line.
  const minimum = pairedPriceValidated ? 1.01 : 1.5;
  const maximum = pairedPriceValidated ? 50 : 2.5;
  if (!Number.isFinite(odds) || odds < minimum || odds > maximum || water < minimum - 1 || water > maximum - 1) return null;
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

function referenceRow({ market, pick, decimalOdds, observedAt, provider, sourceType, sourceLabel, eventId, probabilityEvidence = null, pairedPriceValidated = false }) {
  const water = decimalOddsToWater(decimalOdds, { pairedPriceValidated });
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
    ...(probabilityEvidence && typeof probabilityEvidence === 'object' ? probabilityEvidence : {}),
  };
}

function consensusProbabilityEvidence(rows, leftKey, rightKey, fetchedAt) {
  const fetchedTime = Date.parse(fetchedAt || '');
  const pairs = (Array.isArray(rows) ? rows : []).map(row => {
    const leftOdds = Number(row?.[leftKey]?.price);
    const rightOdds = Number(row?.[rightKey]?.price);
    const bookmakerKey = clean(row?.bookmakerKey);
    const observedTime = Date.parse(row?.observedAt || '');
    if (!bookmakerKey || !Number.isFinite(observedTime) || !Number.isFinite(fetchedTime)) return null;
    if (leftOdds < 1.01 || leftOdds > 50 || rightOdds < 1.01 || rightOdds > 50) return null;
    const leftImplied = 1 / leftOdds;
    const rightImplied = 1 / rightOdds;
    const total = leftImplied + rightImplied;
    if (total < 0.98 || total > 1.12) return null;
    return {
      bookmakerKey,
      observedAt: new Date(observedTime).toISOString(),
      observedTime,
      freshnessMs: fetchedTime - observedTime,
      left: leftImplied / total,
      right: rightImplied / total,
    };
  }).filter(Boolean);
  if (!pairs.length) return null;
  const bookmakerKeys = [...new Set(pairs.map(row => row.bookmakerKey))].sort();
  const observedTimes = pairs.map(row => row.observedTime);
  const oldestObservedTime = Math.min(...observedTimes);
  const newestObservedTime = Math.max(...observedTimes);
  const common = {
    consensusBookKeys: bookmakerKeys,
    consensusBookCount: bookmakerKeys.length,
    consensusOldestObservedAt: new Date(oldestObservedTime).toISOString(),
    consensusNewestObservedAt: new Date(newestObservedTime).toISOString(),
    consensusTimeSpanMs: newestObservedTime - oldestObservedTime,
    consensusFreshnessMaxMs: Math.max(...pairs.map(row => row.freshnessMs)),
  };
  const evidence = sideKey => {
    const values = pairs.map(row => row[sideKey]);
    const centre = median(values);
    const lowerBook = quantile(values, 0.10);
    const minimum = Math.min(...values);
    const maximum = Math.max(...values);
    const spread = maximum - minimum;
    const mad = medianAbsoluteDeviation(values);
    // Cross-book dispersion alone understates market/model uncertainty. Keep a
    // small explicit haircut until locked out-of-sample coverage is available.
    const robust = Math.max(0, Math.min(lowerBook, centre - 0.0075));
    return {
      referenceNoVigProbability: Number(centre.toFixed(8)),
      referenceRobustProbability: Number(robust.toFixed(8)),
      referenceProbabilityMinimum: Number(minimum.toFixed(8)),
      referenceProbabilityMaximum: Number(maximum.toFixed(8)),
      referenceProbabilitySpread: Number(spread.toFixed(8)),
      referenceProbabilityMad: Number(mad.toFixed(8)),
      referenceEvidenceEligible: bookmakerKeys.length >= 3
        && common.consensusTimeSpanMs <= MAX_CONSENSUS_QUOTE_SPAN_MS
        && common.consensusFreshnessMaxMs <= MAX_REFERENCE_QUOTE_AGE_MS
        && spread <= MAX_REFERENCE_PROBABILITY_SPREAD
        && mad <= MAX_REFERENCE_PROBABILITY_MAD,
      referenceBookProbabilities: pairs
        .map(row => ({
          bookmakerKey: row.bookmakerKey,
          observedAt: row.observedAt,
          probability: Number(row[sideKey].toFixed(8)),
        }))
        .sort((left, right) => left.bookmakerKey.localeCompare(right.bookmakerKey)),
      ...common,
    };
  };
  return {
    left: evidence('left'),
    right: evidence('right'),
  };
}

function jbotMarkets(raw, game, fetchedAt) {
  const odds = Array.isArray(raw?.odds) ? raw.odds.at(-1) : null;
  if (!odds) return [];
  const provider = 'JBOT_TAIWAN_SPORTS_LOTTERY';
  const sourceType = 'REFERENCE';
  const sourceLabel = '台灣運彩參考盤｜JBot API';
  const observedAt = providerTimestamp(odds.update, { assumeTaipei: true }) || fetchedAt;
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

export function normalizeJbotReference(payload, schedule = [], { fetchedAt = new Date().toISOString() } = {}) {
  if (payload?.status && String(payload.status).toUpperCase() !== 'OK') throw new Error(`JBot API 回覆：${payload.status}`);
  const serverObservedAt = providerTimestamp(fetchedAt) || new Date().toISOString();
  const matched = [];
  const unmatched = [];
  for (const raw of Array.isArray(payload?.data) ? payload.data : []) {
    const game = matchReferenceScheduleGame(raw, schedule, { assumeTaipei: true });
    if (!game) {
      unmatched.push({ away: clean(raw?.away), home: clean(raw?.home), time: clean(raw?.time), providerEventId: clean(raw?.id) });
      continue;
    }
    const markets = jbotMarkets(raw, game, serverObservedAt);
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

function synchronizedUniqueBookRows(rows, fetchedAt) {
  const fetchedTime = Date.parse(fetchedAt || '');
  if (!Number.isFinite(fetchedTime)) return [];
  const byBook = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const bookmakerKey = clean(row?.bookmakerKey);
    const observedTime = Date.parse(row?.observedAt || '');
    if (!bookmakerKey || !Number.isFinite(observedTime)) continue;
    const age = fetchedTime - observedTime;
    if (age < -MAX_REFERENCE_QUOTE_FUTURE_SKEW_MS || age > MAX_REFERENCE_QUOTE_AGE_MS) continue;
    const previous = byBook.get(bookmakerKey);
    if (!previous || observedTime > previous.observedTime) byBook.set(bookmakerKey, { ...row, observedTime });
  }
  const unique = [...byBook.values()].sort((left, right) => left.observedTime - right.observedTime);
  let best = [];
  for (let start = 0; start < unique.length; start += 1) {
    const window = unique.filter(row => row.observedTime >= unique[start].observedTime
      && row.observedTime - unique[start].observedTime <= MAX_CONSENSUS_QUOTE_SPAN_MS);
    const bestNewest = best.length ? Math.max(...best.map(row => row.observedTime)) : -Infinity;
    const windowNewest = window.length ? Math.max(...window.map(row => row.observedTime)) : -Infinity;
    if (window.length > best.length || (window.length === best.length && windowNewest > bestNewest)) best = window;
  }
  return best;
}

function groupedConsensus(rows, keyFn, fetchedAt) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()]
    .map(([key, groupRows]) => [key, synchronizedUniqueBookRows(groupRows, fetchedAt)])
    .filter(([, groupRows]) => groupRows.length)
    .sort((left, right) => right[1].length - left[1].length
      || Date.parse(latestIso(right[1].map(row => row.observedAt)) || '') - Date.parse(latestIso(left[1].map(row => row.observedAt)) || '')
      || Number(left[0]) - Number(right[0]));
}

function oddsApiMarkets(raw, game, fetchedAt) {
  const moneylineRows = [];
  const spreadFamilies = [
    { market: '全場讓分', rows: [] },
    { market: '上半讓分', rows: [] },
  ];
  const spreadRows = new Map([
    ['spreads', spreadFamilies[0]],
    ['alternate_spreads', spreadFamilies[0]],
    ['spreads_1st_5_innings', spreadFamilies[1]],
    ['alternate_spreads_1st_5_innings', spreadFamilies[1]],
  ]);
  const totalFamilies = [
    { market: '全場大小', rows: [] },
    { market: '上半大小', rows: [] },
  ];
  const totalRows = new Map([
    ['totals', totalFamilies[0]],
    ['alternate_totals', totalFamilies[0]],
    ['totals_1st_5_innings', totalFamilies[1]],
    ['alternate_totals_1st_5_innings', totalFamilies[1]],
  ]);
  const validPricePair = (left, right) => {
    const leftOdds = Number(left?.price);
    const rightOdds = Number(right?.price);
    if (leftOdds < 1.01 || leftOdds > 50 || rightOdds < 1.01 || rightOdds > 50) return false;
    const impliedTotal = 1 / leftOdds + 1 / rightOdds;
    return impliedTotal >= 0.98 && impliedTotal <= 1.12;
  };
  for (const bookmaker of Array.isArray(raw?.bookmakers) ? raw.bookmakers : []) {
    const bookmakerKey = clean(bookmaker?.key);
    if (!bookmakerKey) continue;
    for (const market of Array.isArray(bookmaker?.markets) ? bookmaker.markets : []) {
      const observedAt = providerTimestamp(market?.last_update || bookmaker?.last_update);
      if (!observedAt) continue;
      if (clean(market?.key) === 'h2h') {
        const away = (Array.isArray(market?.outcomes) ? market.outcomes : [])
          .find(row => sameTeam(row.name, raw.away_team));
        const home = (Array.isArray(market?.outcomes) ? market.outcomes : [])
          .find(row => sameTeam(row.name, raw.home_team));
        if (validPricePair(away, home)) {
          moneylineRows.push({
            away,
            home,
            observedAt,
            bookmakerKey,
            bookmakerTitle: clean(bookmaker?.title),
            providerMarketKey: 'h2h',
          });
        }
      }
      const spreadTarget = spreadRows.get(clean(market?.key));
      if (spreadTarget) {
        const homes = (Array.isArray(market?.outcomes) ? market.outcomes : [])
          .filter(row => sameTeam(row.name, raw.home_team) && Number.isFinite(Number(row.point)));
        const aways = (Array.isArray(market?.outcomes) ? market.outcomes : [])
          .filter(row => sameTeam(row.name, raw.away_team) && Number.isFinite(Number(row.point)));
        for (const home of homes) {
          const away = aways.find(row => Math.abs(Number(home.point) + Number(row.point)) <= 1e-9
            && validPricePair(home, row));
          if (!away) continue;
          spreadTarget.rows.push({
            home,
            away,
            observedAt,
            bookmakerKey,
            bookmakerTitle: clean(bookmaker?.title),
            providerMarketKey: clean(market.key),
          });
        }
      }
      const totalTarget = totalRows.get(clean(market?.key));
      if (totalTarget) {
        const overs = (Array.isArray(market?.outcomes) ? market.outcomes : [])
          .filter(row => /^over$/i.test(clean(row.name)) && Number.isFinite(Number(row.point)));
        const unders = (Array.isArray(market?.outcomes) ? market.outcomes : [])
          .filter(row => /^under$/i.test(clean(row.name)) && Number.isFinite(Number(row.point)));
        for (const over of overs) {
          const under = unders.find(row => Math.abs(Number(over.point) - Number(row.point)) <= 1e-9
            && validPricePair(over, row));
          if (!under) continue;
          totalTarget.rows.push({
            over,
            under,
            observedAt,
            bookmakerKey,
            bookmakerTitle: clean(bookmaker?.title),
            providerMarketKey: clean(market.key),
          });
        }
      }
    }
  }

  const provider = 'THE_ODDS_API_CONSENSUS';
  const sourceType = 'INTERNATIONAL';
  const sourceLabel = '國際市場參考盤｜The Odds API';
  const result = [];
  for (const { market, rows: rawRows } of spreadFamilies) {
    for (const [, rows] of groupedConsensus(rawRows, row => Number(row.home.point).toFixed(2), fetchedAt)) {
      const evidence = consensusProbabilityEvidence(rows, 'away', 'home', fetchedAt);
      if (!evidence) continue;
      const point = Number(rows[0].home.point);
      const token = lineText(point);
      const homeGiving = point <= 0;
      const observedAt = latestIso(rows.map(row => row.observedAt));
      const snapshotId = `THE_ODDS_API:${clean(raw.id)}:${market}:SPREAD:${Number(point).toFixed(2)}:${evidence.left.consensusBookKeys.join(',')}:${evidence.left.consensusOldestObservedAt}:${evidence.left.consensusNewestObservedAt}`;
      const away = referenceRow({ market, pick: `${game.away}${homeGiving ? '受讓' : '讓'}${token}`, decimalOdds: median(rows.map(row => row.away.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id, probabilityEvidence: { ...evidence.left, consensusSnapshotId: snapshotId }, pairedPriceValidated: true });
      const home = referenceRow({ market, pick: `${game.home}${homeGiving ? '讓' : '受讓'}${token}`, decimalOdds: median(rows.map(row => row.home.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id, probabilityEvidence: { ...evidence.right, consensusSnapshotId: snapshotId }, pairedPriceValidated: true });
      if (away && home) result.push(away, home);
    }
  }
  // In an official MLB full game there is no tied final result. Tai888's
  // full-game zero run line therefore has the same payoff as h2h/moneyline.
  // Normalize h2h to the zero contract so it can use the same exact-contract
  // three-book verification path without inventing adjacent +/-0.5 prices.
  const synchronizedMoneyline = synchronizedUniqueBookRows(moneylineRows, fetchedAt);
  const moneylineEvidence = consensusProbabilityEvidence(synchronizedMoneyline, 'away', 'home', fetchedAt);
  if (moneylineEvidence) {
    const observedAt = latestIso(synchronizedMoneyline.map(row => row.observedAt));
    const snapshotId = `THE_ODDS_API:${clean(raw.id)}:全場讓分:H2H:0.00:${moneylineEvidence.left.consensusBookKeys.join(',')}:${moneylineEvidence.left.consensusOldestObservedAt}:${moneylineEvidence.left.consensusNewestObservedAt}`;
    const away = referenceRow({ market: '全場讓分', pick: `${game.away}受讓0平`, decimalOdds: median(synchronizedMoneyline.map(row => row.away.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id, probabilityEvidence: { ...moneylineEvidence.left, consensusSnapshotId: snapshotId }, pairedPriceValidated: true });
    const home = referenceRow({ market: '全場讓分', pick: `${game.home}讓0平`, decimalOdds: median(synchronizedMoneyline.map(row => row.home.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id, probabilityEvidence: { ...moneylineEvidence.right, consensusSnapshotId: snapshotId }, pairedPriceValidated: true });
    if (away && home) result.push(away, home);
  }
  for (const { market, rows: rawRows } of totalFamilies) {
    for (const [, rows] of groupedConsensus(rawRows, row => Number(row.over.point).toFixed(2), fetchedAt)) {
      const evidence = consensusProbabilityEvidence(rows, 'over', 'under', fetchedAt);
      if (!evidence) continue;
      const point = Number(rows[0].over.point);
      const token = lineText(point);
      const observedAt = latestIso(rows.map(row => row.observedAt));
      const snapshotId = `THE_ODDS_API:${clean(raw.id)}:${market}:TOTAL:${Number(point).toFixed(2)}:${evidence.left.consensusBookKeys.join(',')}:${evidence.left.consensusOldestObservedAt}:${evidence.left.consensusNewestObservedAt}`;
      const over = referenceRow({ market, pick: `大${token}`, decimalOdds: median(rows.map(row => row.over.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id, probabilityEvidence: { ...evidence.left, consensusSnapshotId: snapshotId }, pairedPriceValidated: true });
      const under = referenceRow({ market, pick: `小${token}`, decimalOdds: median(rows.map(row => row.under.price)), observedAt, provider, sourceType, sourceLabel, eventId: raw.id, probabilityEvidence: { ...evidence.right, consensusSnapshotId: snapshotId }, pairedPriceValidated: true });
      if (over && under) result.push(over, under);
    }
  }
  const marketOrder = new Map([['全場讓分', 0], ['全場大小', 1], ['上半讓分', 2], ['上半大小', 3]]);
  // Array#sort is stable: sorting only by family preserves the deliberate
  // away/home and over/under insertion order inside every line group.
  const deduplicated = [...new Map(result.map(row => [`${row.market}/${row.pick}`, row])).values()];
  return deduplicated.sort((left, right) => (marketOrder.get(left.market) ?? 99) - (marketOrder.get(right.market) ?? 99));
}

export function normalizeOddsApiReference(payload, schedule = [], { fetchedAt = new Date().toISOString() } = {}) {
  const serverObservedAt = providerTimestamp(fetchedAt) || new Date().toISOString();
  const games = [];
  const unmatched = [];
  for (const raw of Array.isArray(payload) ? payload : []) {
    const event = { away: raw.away_team, home: raw.home_team, time: raw.commence_time };
    const game = matchReferenceScheduleGame(event, schedule);
    if (!game) {
      unmatched.push({ away: clean(raw.away_team), home: clean(raw.home_team), time: clean(raw.commence_time), providerEventId: clean(raw.id) });
      continue;
    }
    const markets = oddsApiMarkets(raw, game, serverObservedAt);
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
  const anyConfigured = jbot;
  return {
    configured: anyConfigured,
    anyConfigured,
    consensusReady: false,
    externalAuditEnabled: false,
    primary: jbot ? 'JBOT_TAIWAN_SPORTS_LOTTERY' : null,
    providers: [
      { id: 'JBOT_TAIWAN_SPORTS_LOTTERY', configured: jbot, label: '台灣運彩參考盤｜JBot API' },
    ],
  };
}
