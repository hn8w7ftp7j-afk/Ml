import { cpblFeatureBindings } from './cpbl-feature-evidence-v1.js';
import { externalizeAsianSourceEvidence } from './asian-source-store-v1.js';
import * as cheerio from 'cheerio';
import { randomUUID } from 'node:crypto';
import { captureAsianSource } from './asian-source-evidence-v1.js';
import { parseKboOfficialTbf, kboTbfAcquisitionEligible } from './kbo-official-tbf.js';

export const ASIAN_PRODUCTION_FEATURES_V1_VERSION = 'ASIAN-OFFICIAL-PIT-PLAYER-PIPELINES-2026-09-v1.0.3';

const USER_AGENT = 'Baseball-Positive-EV/11.3 (+official-asian-pit-features)';
const RESPONSE_CACHE = globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__ || new Map();
globalThis.__ASIAN_OFFICIAL_FEATURE_RESPONSE_CACHE_V1__ = RESPONSE_CACHE;

const NPB_TEAM_SUFFIX = Object.freeze({
  YOM: 'g', HAN: 't', YDB: 'db', HIR: 'c', YAK: 's', CHU: 'd',
  SOF: 'h', NIP: 'f', LOM: 'm', RAK: 'e', ORI: 'b', SEI: 'l',
});
const KBO_TEAM_ID = Object.freeze({
  KIA: 'HT', SAM: 'SS', LGT: 'LG', DOO: 'OB', KTW: 'KT', SSG: 'SK',
  LOG: 'LT', HAN: 'HH', NCD: 'NC', KIW: 'WO',
});
const CPBL_TEAM_ID = Object.freeze({
  CTB: 'ACN011', UNI: 'ADD011', RKM: 'AJL011', FUB: 'AEO011', WCD: 'AAA011', TSG: 'AKP011',
});
const NPB_PRIMARY_VENUE = Object.freeze({
  YOM: /TOKYO DOME|東京ドーム/i,
  HAN: /KOSHIEN|甲子園/i,
  YDB: /YOKOHAMA|横浜/i,
  HIR: /MAZDA|マツダ/i,
  YAK: /JINGU|神宮/i,
  CHU: /VANTELIN|NAGOYA|バンテリン/i,
  SOF: /PAYPAY|MIZUHO|FUKUOKA DOME|みずほ/i,
  NIP: /ES CON|エスコン/i,
  LOM: /ZOZO|MARINE|マリン/i,
  RAK: /RAKUTEN MOBILE|MIYAGI|楽天モバイル/i,
  ORI: /KYOCERA|京セラ/i,
  SEI: /BELLUNA|ベルーナ/i,
});

const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
const clean = value => String(value ?? '').replace(/&nbsp;/gi, ' ').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
const number = value => {
  if (value == null || typeof value === 'boolean') return null;
  const text = String(value).replaceAll(',', '').replace('%', '').trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};
const mean = values => {
  const rows = values.filter(value => Number.isFinite(value));
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) / rows.length : null;
};
const compactName = value => clean(value).replace(/[＊*#.,·・\-_'’\s]/g, '').toUpperCase();

export function baseballInnings(value, fractionValue = '') {
  const joined = `${clean(value)}${clean(fractionValue)}`.replace(/\s+/g, '');
  const mixed = joined.match(/^(\d+)(?:[.](1|2)|(?:\+)?([12])\/3)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2] || mixed[3]) / 3;
  const decimal = joined.match(/^(\d+)[.](\d)$/);
  if (decimal && ['1', '2'].includes(decimal[2])) return Number(decimal[1]) + Number(decimal[2]) / 3;
  const integer = number(joined);
  return integer == null ? null : integer;
}

function officialError(message, code = 'ASIAN_OFFICIAL_FEATURE_SOURCE_UNAVAILABLE') {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

async function officialFetch(url, {
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  method = 'GET',
  body,
  headers = {},
  format = 'json',
  cacheMs = 120_000,
  sourceObservations,
  sourceContents,
} = {}) {
  if (typeof fetchImpl !== 'function') throw officialError('官方特徵資料讀取器不存在');
  const key = `${method}|${url}|${String(body || '')}`;
  const cached = RESPONSE_CACHE.get(key);
  if (cached && Date.now() - cached.at <= cacheMs) {
    sourceObservations?.push({ ...cached.event, url, observedAt: new Date(cached.at).toISOString(), fromCache: true });
    if (cached.content && sourceContents) sourceContents[cached.content.contentHash] = cached.content;
    return cached.value;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let httpStatus = null;
  try {
    const response = await fetchImpl(url, {
      method,
      body,
      headers: {
        Accept: format === 'json' ? 'application/json' : 'text/html,application/xhtml+xml',
        'User-Agent': USER_AGENT,
        ...headers,
      },
      cache: 'no-store',
      signal: controller.signal,
    });
    httpStatus = response?.status || null;
    if (!response?.ok) throw officialError(`官方特徵資料讀取失敗（${response?.status || 'network'}）`);
    const rawAvailable = typeof response.text === 'function';
    const raw = rawAvailable ? await response.text() : JSON.stringify(await response.json());
    const value = format === 'text' ? raw : JSON.parse(raw);
    const observedAt = Date.now();
    const captured = captureAsianSource({ url, method, requestBody: body, raw,
      representation: rawAvailable ? 'HTTP_RESPONSE_TEXT' : 'DECODED_JSON_TEST_ADAPTER',
      fetchedAt: new Date(observedAt).toISOString(), httpStatus });
    RESPONSE_CACHE.set(key, { at: observedAt, value, ...captured });
    if (sourceContents) sourceContents[captured.content.contentHash] = captured.content;
    sourceObservations?.push({ ...captured.event, observedAt: captured.event.fetchedAt, fromCache: false });
    while (RESPONSE_CACHE.size > 160) RESPONSE_CACHE.delete(RESPONSE_CACHE.keys().next().value);
    return value;
  } catch (error) {
    sourceObservations?.push({ id: randomUUID(), url, method, httpStatus, success: false,
      failedAt: new Date().toISOString(), fetchedAt: null, contentHash: null, fromCache: false });
    if (error?.code === 'ASIAN_OFFICIAL_FEATURE_SOURCE_UNAVAILABLE') throw error;
    throw officialError(controller.signal.aborted ? '官方特徵資料讀取逾時' : '官方特徵資料目前無法讀取');
  } finally {
    clearTimeout(timer);
  }
}

function kboPost(path, data, options = {}, cookie = '') {
  return officialFetch(`https://www.koreabaseball.com${path}`, {
    ...options,
    method: 'POST',
    format: 'json',
    body: new URLSearchParams(data),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: 'https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx',
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

function rowCells($, row) {
  return $(row).children('th,td').map((_, cell) => clean($(cell).text())).get();
}

const NPB_PITCHING_HEADER_ALIASES = Object.freeze({
  NAME: Object.freeze(['選手', 'PLAYER', 'PITCHER', '氏名']),
  G: Object.freeze(['G', '登板']),
  SV: Object.freeze(['SV', 'セーブ']),
  HLD: Object.freeze(['HLD', 'HOLD', 'ホールド']),
  BF: Object.freeze(['BF', '打者']),
  IP: Object.freeze(['IP', '投球回']),
  H: Object.freeze(['H', '安打']),
  BB: Object.freeze(['BB', '四球']),
  SO: Object.freeze(['SO', '三振']),
  ER: Object.freeze(['ER', '自責点']),
  ERA: Object.freeze(['ERA', '防御率']),
});

function npbHeaderKey(value) {
  return clean(value).normalize('NFKC').toUpperCase();
}

function npbHeaderIndexes(values) {
  const headers = values.map(npbHeaderKey);
  const indexes = Object.fromEntries(Object.entries(NPB_PITCHING_HEADER_ALIASES).map(([key, aliases]) => [
    key,
    headers.findIndex(value => aliases.map(npbHeaderKey).includes(value)),
  ]));
  const required = ['NAME', 'G', 'BF', 'IP', 'H', 'BB', 'SO', 'ER', 'ERA'];
  return required.every(key => indexes[key] >= 0) ? indexes : null;
}

function npbNameKey(value) {
  return clean(value).normalize('NFKC').replace(/[＊*#.,·・\-_'’\s]/g, '').toUpperCase();
}

function npbNameWithoutLatinInitial(value) {
  const key = npbNameKey(value);
  const stripped = key.replace(/^[A-Z]{1,3}(?=[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}])/u, '');
  return stripped === key ? '' : stripped;
}

export function parseNpbPitchingStatsHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const parsed = new Map();
  $('table').each((_, table) => {
    const tableRows = $(table).find('tr').toArray();
    const headerPosition = tableRows.findIndex(row => npbHeaderIndexes(rowCells($, row)) != null);
    if (headerPosition < 0) return;
    const indexes = npbHeaderIndexes(rowCells($, tableRows[headerPosition]));
    const at = (cells, name) => indexes[name] >= 0 ? cells[indexes[name]] : undefined;
    for (const row of tableRows.slice(headerPosition + 1)) {
      const node = $(row);
      const cellNodes = node.children('th,td');
      const cells = rowCells($, row);
      if (!cellNodes.length || cells.length <= Math.max(...Object.values(indexes))) continue;
      const nameCell = cellNodes.eq(indexes.NAME);
      const rawName = clean(nameCell.text());
      const name = rawName.replace(/^[＊*]\s*/, '');
      if (!name || npbHeaderKey(name) === '選手') continue;
      const href = String(nameCell.find('a[href*="/players/"]').first().attr('href') || '');
      const id = href.match(/\/players\/(\d+)\.html/i)?.[1] || null;
      const ipCell = cellNodes.eq(indexes.IP);
      const inningsInteger = ipCell.find('.integer').text();
      const innings = inningsInteger
        ? baseballInnings(inningsInteger, ipCell.find('.decimal, .fraction').first().text())
        : baseballInnings(at(cells, 'IP'));
      const hits = number(at(cells, 'H'));
      const walks = number(at(cells, 'BB'));
      const leftHanded = /^[＊*]/.test(rawName) || nameCell.hasClass('left-hand');
      const parsedRow = {
        id,
        name,
        throws: leftHanded ? 'L' : 'R',
        appearances: number(at(cells, 'G')),
        saves: number(at(cells, 'SV')),
        holds: number(at(cells, 'HLD')),
        battersFaced: number(at(cells, 'BF')),
        inningsPitched: innings,
        hits,
        walks,
        strikeouts: number(at(cells, 'SO')),
        earnedRuns: number(at(cells, 'ER')),
        era: number(at(cells, 'ERA')),
        whip: innings > 0 && hits != null && walks != null ? (hits + walks) / innings : null,
      };
      parsed.set(id ? `ID:${id}` : `NAME:${npbNameKey(name)}`, parsedRow);
    }
  });
  return [...parsed.values()];
}

export function matchNpbStarterStats(rows, identity) {
  const candidates = Array.isArray(rows) ? rows : [];
  const id = clean(identity?.id);
  if (id) {
    const byId = candidates.filter(row => clean(row?.id) === id);
    if (byId.length === 1) return byId[0];
    if (byId.length > 1) return null;
  }
  const compatible = candidates.filter(row => !id || !clean(row?.id) || clean(row.id) === id);
  const exactName = npbNameKey(identity?.name);
  if (exactName) {
    const exact = compatible.filter(row => npbNameKey(row?.name) === exactName);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  const abbreviatedName = npbNameWithoutLatinInitial(identity?.name);
  if (abbreviatedName) {
    const abbreviated = compatible.filter(row => npbNameKey(row?.name) === abbreviatedName);
    if (abbreviated.length === 1) return abbreviated[0];
    if (abbreviated.length > 1) return null;
  }
  // The official monthly schedule intentionally shows only a Japanese
  // pitcher's surname. Accept it only when it identifies exactly one pitcher
  // in that club's official individual pitching table.
  const uniqueOfficialPrefix = compatible.filter(row => {
    const candidate = npbNameKey(row?.name);
    return exactName.length >= 2 && candidate.length > exactName.length && candidate.startsWith(exactName);
  });
  return uniqueOfficialPrefix.length === 1 ? uniqueOfficialPrefix[0] : null;
}

// The English official batting table uses the same names as English box scores.
// Headers are matched by meaning, never by an assumed numeric column position.
export function parseNpbBattingStatsHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const aliases = {
    name: ['PLAYER', '選手'], plateAppearances: ['PA', '打席'], atBats: ['AB', '打数'],
    hits: ['H', '安打'], battingAverage: ['AVG', '打率'],
    onBasePercentage: ['OBP', '出塁率'], sluggingPercentage: ['SLG', '長打率'],
  };
  const output = [];
  $('table').each((_, table) => {
    const rows = $(table).find('tr').toArray();
    const headerAt = rows.findIndex(row => {
      const values = rowCells($, row).map(npbHeaderKey);
      return aliases.name.some(value => values.includes(value))
        && aliases.atBats.some(value => values.includes(value))
        && aliases.battingAverage.some(value => values.includes(value));
    });
    if (headerAt < 0) return;
    const headers = rowCells($, rows[headerAt]).map(npbHeaderKey);
    const indexes = Object.fromEntries(Object.entries(aliases).map(([key, values]) => [key, headers.findIndex(value => values.includes(value))]));
    for (const row of rows.slice(headerAt + 1)) {
      const cells = rowCells($, row);
      const nameCell = $(row).children('th,td').eq(indexes.name);
      const name = clean(cells[indexes.name]).replace(/^[＊*+]\s*/, '');
      if (!name || indexes.atBats >= cells.length) continue;
      const href = nameCell.find('a[href*="/players/"]').attr('href') || '';
      const id = href.match(/\/players\/(\d+)\.html/i)?.[1] || null;
      const parsed = Object.fromEntries(Object.keys(aliases).filter(key => key !== 'name')
        .map(key => [key, number(indexes[key] >= 0 ? cells[indexes[key]] : null)]));
      const hasAtBats = parsed.atBats > 0;
      output.push({
        id, officialPlayerId: id, name, ...parsed,
        battingAverage: hasAtBats ? parsed.battingAverage : null,
        onBasePercentage: parsed.plateAppearances > 0 ? parsed.onBasePercentage : null,
        sluggingPercentage: hasAtBats ? parsed.sluggingPercentage : null,
        ops: hasAtBats && parsed.onBasePercentage != null && parsed.sluggingPercentage != null
          ? parsed.onBasePercentage + parsed.sluggingPercentage : null,
        battingStatsScope: 'CURRENT_SEASON', battingStatsSource: 'NPB_OFFICIAL_INDIVIDUAL_SEASON_BATTING',
      });
    }
  });
  return output;
}

export function matchNpbHitterStats(rows, player) {
  const id = clean(player?.officialPlayerId);
  const compatible = rows.filter(row => !id || !clean(row.officialPlayerId) || clean(row.officialPlayerId) === id);
  if (id) {
    const exact = compatible.filter(row => clean(row.officialPlayerId) === id);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1) return null;
  }
  const name = compactName(player?.name);
  if (!name) return null;
  const exact = compatible.filter(row => compactName(row.name) === name);
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  // A box score may abbreviate to surname. Ambiguous surnames stay missing.
  const surname = compatible.filter(row => compactName(row.name.split(',')[0]) === name);
  return surname.length === 1 ? surname[0] : null;
}

function npbPitchingTable($, table) {
  const rows = $(table).find('tbody tr, tr.gmstats').map((_, row) => {
    const cells = $(row).children('td');
    const pitcherNode = cells.filter('.gmpitcher').first();
    if (!pitcherNode.length) return null;
    const values = cells.map((_, cell) => clean($(cell).text())).get();
    const name = clean(pitcherNode.text()).replace(/,.*$/, '');
    return {
      name,
      starter: false,
      inningsPitched: baseballInnings(values[1], values[2]),
      battersFaced: number(values[3]),
      hits: number(values[4]),
      walks: number(values[5]),
      strikeouts: number(values[7]),
      earnedRuns: number(values[8]),
    };
  }).get().filter(Boolean);
  if (rows[0]) rows[0].starter = true;
  return rows;
}

function npbBattingTable($, table) {
  const seen = new Set();
  return $(table).find('tbody tr, tr.gmstats').map((_, row) => {
    const cell = $(row).children('td.gmbatter').first();
    if (!cell.length) return null;
    const text = clean(cell.text());
    const name = text.replace(/,.*$/, '');
    if (!name || seen.has(compactName(name)) || /,\s*P(?:-|$)/i.test(text)) return null;
    seen.add(compactName(name));
    return { id: compactName(name), name, position: clean(text.split(',').slice(1).join(',')) };
  }).get().filter(Boolean).slice(0, 9);
}

export function parseNpbGameDetailHtml(html) {
  const $ = cheerio.load(String(html || ''));
  const all = $('#gmdivtbl table.gmtbltop').toArray();
  const batting = all.filter(table => {
    const header = clean($(table).find('tr').first().text()).toUpperCase();
    return header.includes('AB') && header.includes('RBI') && $(table).find('td.gmbatter').length;
  });
  const pitching = all.filter(table => {
    const header = clean($(table).find('tr').first().text()).toUpperCase();
    return header.includes('IP') && header.includes('BF') && $(table).find('td.gmpitcher').length;
  });
  const venue = clean($('#gmdivinfo td').first().text());
  return {
    venue,
    away: { lineup: batting[0] ? npbBattingTable($, batting[0]) : [], pitchers: pitching[0] ? npbPitchingTable($, pitching[0]) : [] },
    home: { lineup: batting[1] ? npbBattingTable($, batting[1]) : [], pitchers: pitching[1] ? npbPitchingTable($, pitching[1]) : [] },
  };
}

export function parseKboGameListPayload(payload, providerGameId = '', awayCode = '', homeCode = '') {
  const expectedAway = KBO_TEAM_ID[awayCode] || awayCode;
  const expectedHome = KBO_TEAM_ID[homeCode] || homeCode;
  return (Array.isArray(payload?.game) ? payload.game : []).find(row => (
    (providerGameId && clean(row?.G_ID) === clean(providerGameId))
    || (clean(row?.AWAY_ID) === expectedAway && clean(row?.HOME_ID) === expectedHome)
  )) || null;
}

export function parseKboStarterAnalysisPayload(payload) {
  return (Array.isArray(payload?.rows) ? payload.rows : []).map((row, index) => {
    const cells = Array.isArray(row?.row) ? row.row : [];
    const values = cells.map(cell => clean(cell?.Text));
    const identity = cheerio.load(String(values[0] || ''));
    const style = clean(identity('.style').text());
    const expected = number(values[4]);
    const appearances = number(values[3]);
    return {
      side: index === 0 ? 'away' : 'home',
      name: clean(identity('.name').text()),
      throws: style.startsWith('좌') ? 'L' : style.startsWith('우') ? 'R' : null,
      era: number(values[1]),
      war: number(values[2]),
      gamesStarted: appearances,
      expectedInnings: expected,
      inningsPitched: appearances > 0 && expected > 0 ? appearances * expected : null,
      inningsPitchedEstimated: true,
      inningsPitchedMethod: 'OFFICIAL_APPEARANCES_TIMES_ROUNDED_AVERAGE_INNINGS',
      whip: number(values[6]),
    };
  });
}

function kboJsonTable(value) {
  if (!value) return { rows: [], headers: [] };
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return { rows: [], headers: [] }; }
}

export function parseKboBoxScorePayload(payload) {
  const sides = ['away', 'home'];
  const output = { away: { lineup: [], pitchers: [] }, home: { lineup: [], pitchers: [] } };
  sides.forEach((side, index) => {
    const hitterTable = kboJsonTable(payload?.arrHitter?.[index]?.table1);
    const orders = new Set();
    output[side].lineup = (Array.isArray(hitterTable?.rows) ? hitterTable.rows : []).map(row => {
      const values = (Array.isArray(row?.row) ? row.row : []).map(cell => clean(cell?.Text));
      const order = number(values[0]);
      if (!(order >= 1 && order <= 9) || orders.has(order)) return null;
      orders.add(order);
      return { id: compactName(values[2]), name: values[2], order, position: values[1] };
    }).filter(Boolean).sort((a, b) => a.order - b.order);
    const pitcherTable = kboJsonTable(payload?.arrPitcher?.[index]?.table);
    output[side].pitchers = (Array.isArray(pitcherTable?.rows) ? pitcherTable.rows : []).map((row, pitcherIndex) => {
      const values = (Array.isArray(row?.row) ? row.row : []).map(cell => clean(cell?.Text));
      return {
        name: values[0], starter: pitcherIndex === 0 && values[1] === '선발',
        inningsPitched: baseballInnings(values[6]), battersFaced: number(values[7]),
        hits: number(values[10]), walks: number(values[12]), strikeouts: number(values[13]),
        runs: number(values[14]), earnedRuns: number(values[15]),
      };
    }).filter(row => row.name && row.inningsPitched != null);
  });
  return output;
}

export function parseCpblGameDetailPayload(payload) {
  const root = payload?.Data?.Game || payload?.data?.game || payload?.Data || payload?.data || {};
  const parseSide = block => {
    const lineup = (Array.isArray(block?.Hitters) ? block.Hitters : [])
      .filter(row => number(row?.Lineup) >= 1 && number(row?.Lineup) <= 9 && number(row?.PlateAppearances) > 0)
      .sort((a, b) => number(a.Lineup) - number(b.Lineup));
    const unique = new Map();
    for (const row of lineup) if (!unique.has(number(row.Lineup))) unique.set(number(row.Lineup), {
      id: clean(row?.HitterAcnt), officialPlayerId: clean(row?.HitterAcnt) || null,
      name: clean(row?.HitterName), order: number(row?.Lineup),
      position: clean(row?.DefendStation), battingAverage: number(row?.Avg),
    });
    const pitchers = (Array.isArray(block?.Pitchers) ? block.Pitchers : []).map(row => ({
      id: clean(row?.PitcherAcnt), officialPlayerId: clean(row?.PitcherAcnt) || null,
      name: clean(row?.PitcherName), starter: clean(row?.RoleType) === '先發',
      inningsPitched: number(row?.InningPitchedCnt) != null && number(row?.InningPitchedDiv3Cnt) != null
        ? number(row.InningPitchedCnt) + number(row.InningPitchedDiv3Cnt) / 3 : null,
      battersFaced: number(row?.PlateAppearances), hits: number(row?.HittingCnt), walks: number(row?.BasesONBallsCnt),
      strikeouts: number(row?.StrikeOutCnt), earnedRuns: number(row?.EarnedRunCnt), era: number(row?.Era), whip: number(row?.Whip),
    }));
    return { teamCode: clean(block?.Team?.Code), lineup: [...unique.values()], pitchers };
  };
  return {
    venue: clean(root?.Field?.Abbe || root?.Field?.Name),
    away: parseSide(root?.Visiting || {}),
    home: parseSide(root?.Home || {}),
  };
}

function teamLineStarter(line, teamName, home) {
  const text = clean(line).replace(/[［]/g, '[').replace(/[］]/g, ']');
  const teamAt = text.indexOf(clean(teamName));
  if (teamAt < 0 || (home && !/\[主\]/.test(text))) return null;
  const tail = text.slice(teamAt + clean(teamName).length).replace(/\[主\]/g, '').trim();
  const match = tail.match(/^(.+?)\s*\[([左右])\]/);
  if (!match) return null;
  const name = clean(match[1]).replace(/^[-–—:：]/, '').trim();
  if (!name || /^(投手|先發|待定|TBD)$/i.test(name)) return null;
  return { name, throws: match[2] === '左' ? 'L' : 'R', source: 'SERVER_ATTESTED_TAI888_IDENTITY_VALIDATED_BY_CPBL_ROSTER' };
}

export function extractAsianStarterEvidence(markets, game) {
  const lines = [...new Set((Array.isArray(markets) ? markets : [])
    .flatMap(row => clean(row?.rawText).split('|'))
    .map(clean).filter(Boolean))];
  return {
    away: lines.map(line => teamLineStarter(line, game?.away, false)).find(Boolean) || null,
    home: lines.map(line => teamLineStarter(line, game?.home, true)).find(Boolean) || null,
  };
}

function teamRunRows(history, teamId) {
  return (Array.isArray(history) ? history : []).filter(game => (
    Number(game?.awayTeamId) === Number(teamId) || Number(game?.homeTeamId) === Number(teamId)
  )).map(game => {
    const away = Number(game.awayTeamId) === Number(teamId);
    return {
      date: game.gameDate, scored: Number(away ? game.awayScore : game.homeScore),
      allowed: Number(away ? game.homeScore : game.awayScore), home: !away, venue: clean(game.venue), game,
    };
  }).filter(row => Number.isFinite(row.scored) && Number.isFinite(row.allowed));
}

function strengthSnapshot(leagueId, history, teamId) {
  const rows = teamRunRows(history, teamId);
  const recent = [...rows].sort((a, b) => Date.parse(b.date) - Date.parse(a.date)).slice(0, 10);
  return {
    available: rows.length >= 8,
    metricScope: 'TEAM_STRENGTH_BASELINE',
    baselineMethod: 'OFFICIAL_ROLLING_3_MONTH_RUN_ENVIRONMENT_WITH_ACTIVE_LINEUP_ROSTER',
    priorSeasonRegressed: false,
    currentSeasonGames: rows.length,
    source: `${leagueId}_OFFICIAL_COMPLETED_GAMES_TEAM_STRENGTH_PIT`,
    seasonHitting: { gamesPlayed: rows.length, runsPerGame: mean(rows.map(row => row.scored)) },
    recentHitting: { gamesPlayed: recent.length, runsPerGame: mean(recent.map(row => row.scored)) },
  };
}

function selectedRecentGames(history, game, limit = 3) {
  const select = teamId => [...history]
    .filter(row => Number(row?.awayTeamId) === Number(teamId) || Number(row?.homeTeamId) === Number(teamId))
    .sort((a, b) => Date.parse(b.gameDate) - Date.parse(a.gameDate)).slice(0, limit);
  return [...new Map([...select(game.awayTeamId), ...select(game.homeTeamId)].map(row => [row.gamePk, row])).values()];
}

export function detailSide(detail, game, teamId) {
  if (Number(game?.awayTeamId) === Number(teamId)) return detail?.away || null;
  if (Number(game?.homeTeamId) === Number(teamId)) return detail?.home || null;
  return null;
}

export function projectedLineup(details, teamId, baseline, battingStats = [], battingStatsObservedAt = null) {
  const latest = [...details].sort((a, b) => Date.parse(b.game.gameDate) - Date.parse(a.game.gameDate))
    .find(row => detailSide(row.detail, row.game, teamId)?.lineup?.length >= 8);
  if (!latest) return null;
  const players = detailSide(latest.detail, latest.game, teamId).lineup.slice(0, 9)
    .map(player => {
      const stats = baseline === 'NPB' ? matchNpbHitterStats(battingStats, player) : null;
      const combined = { ...player, ...(stats || {}) };
      const statsAvailable = number(combined.battingAverage) != null && number(combined.atBats) > 0
        && combined.battingStatsScope === 'CURRENT_SEASON';
      return {
        ...combined, teamId: Number(teamId), officialPlayerId: clean(combined.officialPlayerId) || null,
        statsAvailable, battingStatsObservedAt: stats ? battingStatsObservedAt : null,
        battingStatsStatus: statsAvailable ? 'OBSERVED_SEASON_SAMPLE' : 'MISSING_VERIFIED_SEASON_SAMPLE',
      };
    });
  const measuredPlayers = players.filter(row => row.statsAvailable);
  const observedAtBats = measuredPlayers.reduce((sum, row) => sum + row.atBats, 0);
  const observedHits = measuredPlayers.every(row => number(row.hits) != null)
    ? measuredPlayers.reduce((sum, row) => sum + row.hits, 0) : null;
  const playerAverage = observedAtBats > 0 && observedHits != null ? observedHits / observedAtBats : null;
  const statsCoverage = measuredPlayers.length / 9;
  return {
    available: true, official: false, projected: true, credibleScenario: true, teamId: Number(teamId), players,
    assignmentStatus: 'HISTORICAL_LINEUP_PROJECTION', rosterConfirmedToday: false,
    statsCoverage, fullStatsCoverage: measuredPlayers.length === 9,
    observedAtBats, observedHits, observedBattingAverage: playerAverage,
    incompleteReasons: [
      'CURRENT_GAME_STARTING_LINEUP_NOT_CONFIRMED',
      ...(measuredPlayers.length < 9 ? [`VERIFIED_SEASON_BATTING_MISSING_FOR_${9 - measuredPlayers.length}_SLOTS`] : []),
      'INJURY_AVAILABILITY_AND_HANDEDNESS_SPLITS_NOT_VERIFIED',
    ],
    offensiveIndex: playerAverage == null ? 1 : clamp(1 + (playerAverage - 0.255) * 0.8, 0.90, 1.10),
    offensiveIndexMethod: playerAverage == null ? 'ROSTER_ONLY_NO_UNVERIFIED_RUN_DELTA' : 'OFFICIAL_LINEUP_POOLED_HITS_PER_AT_BAT_SHRUNK',
    offensiveIndexIsFallback: playerAverage == null,
    source: `${baseline}_LATEST_OFFICIAL_STARTING_LINEUP_PROJECTED_PIT`,
    asOfGamePk: latest.game.gamePk, asOfProviderGameId: latest.game.providerGameId, historicalLineupGameDate: latest.game.gameDate,
    battingStatsObservedAt,
  };
}

export function bullpenSnapshot(details, teamId, leagueId, referenceEra, firstPitch) {
  const rows = details.flatMap(item => {
    const side = detailSide(item.detail, item.game, teamId);
    return (side?.pitchers || []).filter(pitcher => pitcher.starter !== true).map(pitcher => ({
      ...pitcher,
      teamId: Number(teamId),
      officialPlayerId: clean(pitcher?.officialPlayerId) || null,
      date: item.game.gameDate, gamePk: item.game.gamePk, providerGameId: item.game.providerGameId,
    }));
  });
  const performanceRows = rows.filter(row => number(row.inningsPitched) != null && number(row.inningsPitched) >= 0 && number(row.earnedRuns) != null);
  const innings = performanceRows.reduce((sum, row) => sum + number(row.inningsPitched), 0);
  const earnedRuns = performanceRows.reduce((sum, row) => sum + number(row.earnedRuns), 0);
  if (!(innings >= 3)) return null;
  const rawEra = earnedRuns * 9 / innings;
  const reliability = innings / (innings + 18);
  const qualityFactor = clamp(Math.exp(Math.log(clamp(rawEra / referenceEra, 0.45, 2.2)) * reliability), 0.78, 1.28);
  const recentFour = rows.filter(row => {
    const age = (Date.parse(firstPitch) - Date.parse(row.date)) / 86_400_000;
    return age > 0 && age <= 4;
  });
  const recentInnings = recentFour.reduce((sum, row) => sum + (number(row.inningsPitched) || 0), 0);
  const fatigueIndex = clamp(recentInnings / 16 + recentFour.length * 0.018, 0.04, 0.92);
  return {
    available: true, pureRelief: true, usageAvailable: true, qualityScope: 'PURE_RELIEF', teamId: Number(teamId),
    source: `${leagueId}_OFFICIAL_BOX_SCORE_RELIEF_INNINGS_ONLY_PIT`, projectionBased: true,
    qualityFactor, referenceEra, observedEra: rawEra, sampleInnings: innings,
    performanceRows: performanceRows.length, missingPerformanceRows: rows.length - performanceRows.length,
    pitcherIds: [...new Set(rows.map(row => row.officialPlayerId).filter(Boolean))],
    players: [...new Set(rows.map(row => row.officialPlayerId).filter(Boolean))].map(id => ({ id, name: rows.find(row => row.officialPlayerId === id)?.name || null, usageComplete: false, usageGames: rows.filter(row => row.officialPlayerId === id), metricScope: 'OBSERVED_RECENT_RELIEF_APPEARANCES' })),
    usageCoverage: { sampledGames: new Set(rows.map(row => row.gamePk)).size, startDate: rows.map(row => row.date).sort()[0] || null, endDate: rows.map(row => row.date).sort().at(-1) || null, complete: false, pitchCountsAvailable: false },
    qualityFactorCalculation: { method: 'ERA_RATIO_LOG_SHRINK', referenceEra, earnedRuns, innings, priorInnings: 18, reliability, eraRatioLimits: [0.45, 2.2], limits: [0.78, 1.28] },
    fatigueIndex, highLeverageAvailability: clamp(0.94 - fatigueIndex * 0.58, 0.35, 0.92),
  };
}

function parkSnapshot(leagueId, history, game, details, baseline) {
  const venue = clean(game?.venue);
  if (!venue || /待確認|TBD|UNKNOWN/i.test(venue)) return null;
  const exact = history.filter(row => clean(row?.venue).toUpperCase() === venue.toUpperCase());
  const primaryHome = history.filter(row => Number(row?.homeTeamId) === Number(game?.homeTeamId));
  const npbPrimary = leagueId === 'NPB' && NPB_PRIMARY_VENUE[game?.homeCode]?.test(venue);
  const sample = exact.length >= 6 ? exact : npbPrimary ? primaryHome : [];
  if (sample.length < 8) return null;
  const observed = mean(sample.map(row => (Number(row.awayScore) + Number(row.homeScore)) / 2));
  if (!(observed > 0) || !(baseline > 0)) return null;
  const prior = 18;
  const runFactor = clamp(((observed * sample.length + baseline * prior) / (sample.length + prior)) / baseline, 0.84, 1.18);
  const dome = /DOME|巨蛋|고척|GOCHEOK|VANTELIN|KYOCERA|BELLUNA|PAYPAY|ES CON/i.test(venue);
  return {
    available: true, recognized: true, isNeutralPlaceholder: false, name: venue, runFactor,
    sampleGames: sample.length, source: `${leagueId}_OFFICIAL_VENUE_COMPLETED_GAME_RUNS_PIT`,
    factorMethod: exact.length >= 6 ? 'OFFICIAL_VENUE_RUN_ENVIRONMENT_EMPIRICAL_BAYES' : 'OFFICIAL_PRIMARY_HOME_RUN_ENVIRONMENT_EMPIRICAL_BAYES',
    dome, roof: dome ? 'dome' : 'outdoor', roofConfirmed: dome,
  };
}

export function starterSnapshot({ leagueId, game, side, identity, stats, referenceEra, recentStarts = [] }) {
  if (!identity?.name || !stats) return null;
  const expectedFromRecent = mean(recentStarts.map(row => number(row.inningsPitched)));
  const expectedInnings = expectedFromRecent ?? number(stats.expectedInnings)
    ?? (number(stats.inningsPitched) > 0 && number(stats.appearances) > 0 ? number(stats.inningsPitched) / number(stats.appearances) : null);
  const battersFaced = number(stats.battersFaced)
    ?? (number(stats.inningsPitched) > 0 ? number(stats.inningsPitched) * 4.25 : null);
  const era = number(stats.era);
  const whip = number(stats.whip);
  const minimumBattersFaced = identity?.projected === true
    && identity?.officialRosterValidated === true
    && recentStarts.length > 0 ? 12 : 30;
  if (!(expectedInnings > 0) || !(battersFaced >= minimumBattersFaced) || (era == null && number(stats.qualityFactor) == null)) return null;
  const sampleReliability = battersFaced / (battersFaced + 180);
  const observedQualityFactor = number(stats.qualityFactor);
  if (era == null && !(observedQualityFactor > 0)) return null;
  const eraFactor = era == null ? observedQualityFactor : clamp(era / referenceEra, 0.55, 1.75);
  const whipFactor = whip == null ? null : clamp(whip / 1.28, 0.65, 1.55);
  // Missing WHIP is absence of evidence, not a measured neutral WHIP.
  // An independently supplied wOBA ratio is already the ability metric.
  const logAbility = era == null || whipFactor == null
    ? Math.log(eraFactor)
    : Math.log(eraFactor) * 0.78 + Math.log(whipFactor) * 0.22;
  const qualityFactor = clamp(Math.exp(logAbility * sampleReliability), 0.76, 1.30);
  const performanceMetric = era == null
    ? (stats.performanceMetric || 'OFFICIAL_INDIVIDUAL_QUALITY_FACTOR')
    : whip == null ? 'ERA' : 'ERA_AND_WHIP';
  return {
    id: clean(identity.id), officialPlayerId: clean(identity.id) || null,
    teamId: Number(side === 'away' ? game.awayTeamId : game.homeTeamId), name: clean(identity.name),
    identityConfirmed: true, identitySource: clean(identity.source), performanceAvailable: true,
    performanceScope: 'INDIVIDUAL_STARTER', independentOfTeamResults: true, projectedFromTeamPitching: false,
    performanceSource: stats.performanceSource || `${leagueId}_OFFICIAL_INDIVIDUAL_STARTER`,
    performanceMetric, performanceObservedAt: stats.observedAt || null,
    qualityFactorInputs: { era, whip, observedQualityFactor, sampleReliability, woba: number(stats.woba), leagueWoba: number(stats.leagueWoba) },
    dataCoverage: { era: era != null, whip: whip != null, independentQualityMetric: observedQualityFactor != null },
    throws: identity.throws || stats.throws || null,
    officialThrows: stats.throws || identity.throws || null, expectedInnings: clamp(expectedInnings, 2.5, 7.2), qualityFactor,
    expectedInningsSource: expectedFromRecent != null ? 'OBSERVED_RECENT_STARTS_AVERAGE'
      : number(stats.expectedInnings) != null ? 'OFFICIAL_REPORTED_AVERAGE_INNINGS' : 'OBSERVED_SEASON_INNINGS_PER_APPEARANCE',
    expectedInningsEvidence: { method: expectedFromRecent != null ? 'MEAN_RECENT_START_INNINGS' : 'REPORTED_OR_SEASON_AVERAGE', limits: [2.5, 7.2], games: recentStarts.map(row => ({ gamePk: row.gamePk || null, date: row.date || null, inningsPitched: row.inningsPitched })), unboundedValue: expectedInnings },
    expectedInningsSampleGames: recentStarts.filter(row => number(row.inningsPitched) != null).length,
    qualityMetricScope: 'INDIVIDUAL_STARTER_RUN_PREVENTION', referenceEra,
    season: {
      inningsPitched: number(stats.inningsPitched), gamesStarted: number(stats.gamesStarted), appearances: number(stats.appearances),
      era, whip, battersFaced, war: number(stats.war), qualityFactor,
      // Retain the legacy numeric input for immutable replay compatibility.
      // It is not an observed count when derived from innings.
      observedBattersFaced: Number.isSafeInteger(number(stats.battersFaced)) && number(stats.battersFaced) >= 0 ? number(stats.battersFaced) : null,
      effectiveBattersFaced: battersFaced,
      battersFacedSourceEvidence: stats.battersFacedSourceEvidence || null,
      battersFacedAcquisitionStatus: stats.battersFacedAcquisitionStatus || null,
      sampleSizeEvidence: {
        version: 'ASIAN-STARTER-SAMPLE-DEFINITION-v1',
        status: number(stats.battersFaced) == null ? 'ESTIMATED'
          : Number.isSafeInteger(number(stats.battersFaced)) && number(stats.battersFaced) >= 0 ? 'REPORTED_INTEGER' : 'INVALID_REPORTED_COUNT',
        rawReportedBattersFaced: stats.battersFaced ?? null,
        formula: number(stats.battersFaced) == null ? 'inningsPitched * 4.25' : 'reported battersFaced',
        inningsPitched: number(stats.inningsPitched),
        coefficient: number(stats.battersFaced) == null ? 4.25 : null,
        legacyBattersFacedIsEffectiveSample: true,
        consumers: ['qualityFactor.sampleReliability', 'starterReadiness', 'jointScore.uncertaintyFor'],
        externallyValidated: false,
      },
      inningsPitchedEstimated: stats.inningsPitchedEstimated === true,
      inningsPitchedMethod: stats.inningsPitchedMethod || (number(stats.inningsPitched) == null ? 'UNAVAILABLE' : 'OFFICIAL_OBSERVED_INNINGS'),
      estimatedInningsPitched: number(stats.estimatedInningsPitched),
      battersFacedEstimated: number(stats.battersFaced) == null,
      woba: number(stats.woba), leagueWoba: number(stats.leagueWoba),
    },
    recent: {
      inningsPitched: recentStarts.reduce((sum, row) => sum + (number(row.inningsPitched) || 0), 0),
      gamesStarted: recentStarts.length,
    },
    ...(identity.projected ? {
      assignmentStatus: 'PROJECTED_ROTATION_SCENARIO',
      projectionMethod: identity.projectionMethod,
      projectionConfidence: identity.projectionConfidence,
      rotationCandidates: identity.candidates,
    } : { assignmentStatus: 'OFFICIAL_CONFIRMED' }),
  };
}

async function npbDetails(games, options) {
  const settled = await Promise.allSettled(games.map(async game => {
    const id = clean(game.providerGameId);
    if (!/^s\d+$/i.test(id)) throw officialError('NPB逐場官方識別碼缺失');
    const year = clean(game.officialDate).slice(0, 4);
    const html = await officialFetch(`https://npb.jp/bis/eng/${year}/games/${id}.html`, { ...options, format: 'text' });
    return { game, detail: parseNpbGameDetailHtml(html) };
  }));
  return settled.filter(row => row.status === 'fulfilled').map(row => row.value);
}

async function kboSession(game, options) {
  const htmlResponse = await officialFetch(`https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx?gameDate=${clean(game.officialDate).replaceAll('-', '')}`, {
    ...options, format: 'text', cacheMs: 60_000,
  });
  // Node fetch does not expose Set-Cookie through the text result. KBO's AJAX
  // endpoints currently accept the same-origin request without a cookie, so
  // retain this explicit session bootstrap and use an empty cookie if hidden.
  void htmlResponse;
  return '';
}

async function kboDetails(games, options, cookie) {
  const settled = await Promise.allSettled(games.map(async game => ({
    game,
    detail: parseKboBoxScorePayload(await kboPost('/ws/Schedule.asmx/GetBoxScoreScroll', {
      leId: '1', srId: '0', seasonId: clean(game.officialDate).slice(0, 4), gameId: clean(game.providerGameId),
    }, options, cookie)),
  })));
  return settled.filter(row => row.status === 'fulfilled').map(row => row.value);
}

async function cpblDetails(games, options) {
  const settled = await Promise.allSettled(games.map(async game => ({
    game,
    detail: parseCpblGameDetailPayload(await officialFetch(`https://stats.cpbl.com.tw/api/proxy/v1/games/${encodeURIComponent(clean(game.providerGameId))}`, {
      ...options,
      timeoutMs: Math.max(25_000, Number(options?.timeoutMs) || 0),
    })),
  })));
  return settled.filter(row => row.status === 'fulfilled').map(row => row.value);
}

function recentStarterRows(details, teamId, identity) {
  const officialPlayerId = clean(identity?.id);
  const name = compactName(identity?.name);
  return details.flatMap(item => (detailSide(item.detail, item.game, teamId)?.pitchers || [])
    .filter(row => row.starter === true && (
      officialPlayerId
        ? clean(row?.id) === officialPlayerId
        : name && compactName(row?.name) === name
    ))
    .map(row => ({ ...row, gamePk: item.game.gamePk, date: item.game.gameDate, teamId: Number(teamId), officialPlayerId: clean(row?.id) || null })));
}

export function rotationPrediction(details, teamId, firstPitch, leagueId) {
  const targetRestDays = leagueId === 'NPB' ? 6 : 5;
  const grouped = new Map();
  for (const item of details) {
    const gameTime = Date.parse(item?.game?.gameDate || '');
    if (!Number.isFinite(gameTime) || gameTime >= Date.parse(firstPitch || '')) continue;
    for (const pitcher of detailSide(item.detail, item.game, teamId)?.pitchers || []) {
      if (pitcher?.starter !== true || !clean(pitcher?.name)) continue;
      const officialPlayerId = clean(pitcher.officialPlayerId) || null;
      const providerPlayerId = clean(pitcher.id) || null;
      const key = `${Number(teamId)}:${officialPlayerId || providerPlayerId || compactName(pitcher.name)}`;
      const existing = grouped.get(key) || {
        id: providerPlayerId, officialPlayerId, teamId: Number(teamId), name: clean(pitcher.name), throws: pitcher.throws || null, starts: [],
      };
      existing.starts.push({ ...pitcher, teamId: Number(teamId), officialPlayerId, gameDate: item.game.gameDate, gamePk: item.game.gamePk });
      if (!existing.id && pitcher.id) existing.id = clean(pitcher.id);
      if (!existing.throws && pitcher.throws) existing.throws = pitcher.throws;
      grouped.set(key, existing);
    }
  }
  const candidates = [...grouped.values()].map(candidate => {
    candidate.starts.sort((left, right) => Date.parse(right.gameDate) - Date.parse(left.gameDate));
    const lastStartAt = candidate.starts[0]?.gameDate || '';
    const restDays = Math.max(0, (Date.parse(firstPitch) - Date.parse(lastStartAt)) / 86_400_000);
    const inningsPitched = candidate.starts.reduce((sum, row) => sum + (number(row.inningsPitched) || 0), 0);
    const earnedRuns = candidate.starts.every(row => number(row.earnedRuns) != null)
      ? candidate.starts.reduce((sum, row) => sum + number(row.earnedRuns), 0) : null;
    const hits = candidate.starts.every(row => number(row.hits) != null)
      ? candidate.starts.reduce((sum, row) => sum + number(row.hits), 0) : null;
    const walks = candidate.starts.every(row => number(row.walks) != null)
      ? candidate.starts.reduce((sum, row) => sum + number(row.walks), 0) : null;
    const battersFaced = candidate.starts.reduce((sum, row) => sum + (number(row.battersFaced) || 0), 0)
      || inningsPitched * 4.25;
    const rotationFit = restDays < 3 ? 0 : Math.exp(-Math.abs(restDays - targetRestDays) / 1.6);
    return {
      id: candidate.id || null,
      officialPlayerId: candidate.officialPlayerId || null,
      teamId: Number(teamId),
      name: candidate.name,
      throws: candidate.throws,
      lastStartAt,
      restDays,
      priorStarts: candidate.starts.length,
      inningsPitched,
      battersFaced,
      era: inningsPitched > 0 && earnedRuns != null ? earnedRuns * 9 / inningsPitched : null,
      whip: inningsPitched > 0 && hits != null && walks != null ? (hits + walks) / inningsPitched : null,
      expectedInnings: candidate.starts.length ? inningsPitched / candidate.starts.length : null,
      rawWeight: rotationFit * Math.min(1, 0.65 + candidate.starts.length * 0.18),
      evidenceGamePks: candidate.starts.map(row => row.gamePk).filter(Boolean),
    };
  }).filter(candidate => candidate.rawWeight > 0)
    .sort((left, right) => right.rawWeight - left.rawWeight)
    .slice(0, 4);
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.rawWeight, 0);
  if (!(totalWeight > 0)) return null;
  return {
    available: true,
    teamId: Number(teamId),
    projectionBased: true,
    projectionMode: 'OFFICIAL_PRIOR_START_ROTATION_MIXTURE',
    source: `${leagueId}_OFFICIAL_PRIOR_STARTS_ROTATION_FORECAST_PIT`,
    candidates: candidates.map(candidate => ({
      ...candidate,
      probability: candidate.rawWeight / totalWeight,
      rawWeight: undefined,
    })),
  };
}

function featureOfficialIds(team) {
  return new Set([
    clean(team?.starter?.id),
    ...(Array.isArray(team?.starter?.candidates) ? team.starter.candidates.map(row => clean(row?.officialPlayerId)) : []),
    ...(Array.isArray(team?.lineup?.players) ? team.lineup.players.map(row => clean(row?.officialPlayerId)) : []),
    ...(Array.isArray(team?.bullpen?.pitcherIds) ? team.bullpen.pitcherIds.map(clean) : []),
  ].filter(Boolean));
}

export function validateAsianTeamFeatureOwnership(featureSnapshot, awayTeamId, homeTeamId) {
  const expected = { away: Number(awayTeamId), home: Number(homeTeamId) };
  for (const side of ['away', 'home']) {
    const team = featureSnapshot?.[side] || {};
    for (const value of [team.starter, team.lineup, team.bullpen]) {
      if (value && Number(value.teamId) !== expected[side]) {
        throw new Error(`ASIAN_CROSS_TEAM_FEATURE_OWNERSHIP:${side}:${value.teamId}:${expected[side]}`);
      }
    }
    for (const candidate of team.starter?.candidates || []) {
      if (Number(candidate?.teamId) !== expected[side]) {
        throw new Error(`ASIAN_CROSS_TEAM_STARTER_CANDIDATE:${side}:${candidate?.teamId}:${expected[side]}`);
      }
    }
    for (const player of team.lineup?.players || []) {
      if (Number(player?.teamId) !== expected[side]) {
        throw new Error(`ASIAN_CROSS_TEAM_LINEUP_PLAYER:${side}:${player?.teamId}:${expected[side]}`);
      }
    }
  }
  const awayIds = featureOfficialIds(featureSnapshot?.away);
  const duplicateOfficialId = [...featureOfficialIds(featureSnapshot?.home)].find(id => awayIds.has(id));
  if (duplicateOfficialId) throw new Error(`ASIAN_CROSS_TEAM_OFFICIAL_PLAYER_ID:${duplicateOfficialId}`);
  return true;
}

export function projectCpblRotationStarter(details, teamId, firstPitch) {
  const firstPitchAt = Date.parse(firstPitch || '');
  if (!Number.isFinite(firstPitchAt)) return null;
  const appearances = (Array.isArray(details) ? details : []).flatMap(item => {
    const gameAt = Date.parse(item?.game?.gameDate || '');
    if (!Number.isFinite(gameAt) || gameAt >= firstPitchAt) return [];
    return (detailSide(item?.detail, item?.game, teamId)?.pitchers || [])
      .filter(row => row?.starter === true && clean(row?.id) && clean(row?.name))
      .map(row => ({
        id: clean(row.id), name: clean(row.name), gameAt, gameDate: item.game.gameDate,
        inningsPitched: number(row.inningsPitched),
      }));
  });
  const latestByPitcher = new Map();
  for (const row of appearances) {
    const previous = latestByPitcher.get(row.id);
    if (!previous || row.gameAt > previous.gameAt) latestByPitcher.set(row.id, row);
  }
  const candidates = [...latestByPitcher.values()].map(row => {
    const restDays = (firstPitchAt - row.gameAt) / 86_400_000;
    const workloadFactor = Number.isFinite(row.inningsPitched) ? clamp(row.inningsPitched / 4, 0.18, 1) : 1;
    // CPBL announces and schedules by local game date. A four-date rotation can
    // be slightly under 96 hours when start times differ, so allow a six-hour
    // clock tolerance without admitting a pitcher from the previous two days.
    const rotationScore = restDays >= 3.75 && restDays <= 10
      ? Math.exp(-Math.abs(restDays - 5) * 0.72) * workloadFactor
      : 0;
    return { ...row, restDays, rotationScore };
  }).filter(row => row.rotationScore > 0)
    .sort((left, right) => right.rotationScore - left.rotationScore || right.gameAt - left.gameAt);
  if (!candidates.length) return null;
  const total = candidates.reduce((sum, row) => sum + row.rotationScore, 0);
  const weighted = candidates.map(row => ({
    id: row.id,
    name: row.name,
    lastStart: row.gameDate,
    restDays: Number(row.restDays.toFixed(2)),
    weight: total > 0 ? row.rotationScore / total : 0,
  }));
  const primary = weighted[0];
  return {
    id: primary.id,
    name: primary.name,
    source: 'CPBL_OFFICIAL_ROTATION_PROJECTED_STARTER',
    projected: true,
    projectionMethod: 'OFFICIAL_RECENT_STARTS_REST_DAY_ROTATION',
    projectionConfidence: primary.weight,
    candidates: weighted,
  };
}

async function buildNpb(game, history, options) {
  const year = clean(game.officialDate).slice(0, 4);
  const recentGames = selectedRecentGames(history, game, 8);
  const [details, awayStatsHtml, homeStatsHtml, awayBattingHtml, homeBattingHtml] = await Promise.all([
    npbDetails(recentGames, options),
    officialFetch(`https://npb.jp/bis/${year}/stats/idp1_${NPB_TEAM_SUFFIX[game.awayCode]}.html`, { ...options, format: 'text' }).catch(() => ''),
    officialFetch(`https://npb.jp/bis/${year}/stats/idp1_${NPB_TEAM_SUFFIX[game.homeCode]}.html`, { ...options, format: 'text' }).catch(() => ''),
    officialFetch(`https://npb.jp/bis/eng/${year}/stats/idb1_${NPB_TEAM_SUFFIX[game.awayCode]}.html`, { ...options, format: 'text' }).catch(() => ''),
    officialFetch(`https://npb.jp/bis/eng/${year}/stats/idb1_${NPB_TEAM_SUFFIX[game.homeCode]}.html`, { ...options, format: 'text' }).catch(() => ''),
  ]);
  const statRows = { away: parseNpbPitchingStatsHtml(awayStatsHtml), home: parseNpbPitchingStatsHtml(homeStatsHtml) };
  const identity = {
    away: { id: game.awayProbableId, name: game.awayProbable, source: game.probableSource },
    home: { id: game.homeProbableId, name: game.homeProbable, source: game.probableSource },
  };
  const findStats = side => {
    const row = matchNpbStarterStats(statRows[side], identity[side]);
    const observedAt = options.sourceObservations?.find(item => item.url.endsWith(`/idp1_${NPB_TEAM_SUFFIX[game[`${side}Code`]]}.html`))?.observedAt || null;
    return row ? { ...row, observedAt } : null;
  };
  return {
    details, identity, starterStats: { away: findStats('away'), home: findStats('home') }, gamePatch: {},
    battingStats: { away: parseNpbBattingStatsHtml(awayBattingHtml), home: parseNpbBattingStatsHtml(homeBattingHtml) },
    battingStatsObservedAt: Object.fromEntries(['away', 'home'].map(side => [side,
      options.sourceObservations?.find(row => row.url.endsWith(`/idb1_${NPB_TEAM_SUFFIX[game[`${side}Code`]]}.html`))?.observedAt || null,
    ])),
  };
}

async function buildKbo(game, history, options) {
  const cookie = '';
  const compactDate = clean(game.officialDate).replaceAll('-', '');
  const metaPayload = await kboPost('/ws/Main.asmx/GetKboGameList', {
    leId: '1', srId: '0,1,3,4,5,6,7,8,9', date: compactDate,
  }, options, cookie);
  const meta = parseKboGameListPayload(metaPayload, game.providerGameId, game.awayCode, game.homeCode);
  if (!meta || !meta.T_PIT_P_ID || !meta.B_PIT_P_ID) return { details: [], identity: {}, starterStats: {}, gamePatch: {} };
  const [analysis, details, weatherPayload] = await Promise.all([
    kboPost('/ws/Schedule.asmx/GetPitcherRecordAnalysis', {
      leId: '1', srId: String(meta.SR_ID ?? 0), seasonId: String(meta.SEASON_ID),
      awayTeamId: clean(meta.AWAY_ID), awayPitId: String(meta.T_PIT_P_ID),
      homeTeamId: clean(meta.HOME_ID), homePitId: String(meta.B_PIT_P_ID), groupSc: 'SEASON',
    }, options, cookie),
    kboDetails(selectedRecentGames(history, game, 8), options, cookie),
    kboPost('/ws/Schedule.asmx/GetTodayGames', {
      gameDate: compactDate, leId: '1', srId: '0,1,2,3,4,5,6,7,8,9', headerCk: '1',
    }, options, cookie).catch(() => null),
  ]);
  const statsObservedAt = options.sourceObservations?.find(row => row.url.endsWith('/GetPitcherRecordAnalysis'))?.observedAt || null;
  const statsRows = parseKboStarterAnalysisPayload(analysis).map(row => ({ ...row, observedAt: statsObservedAt }));
  const gamePatch = {
    providerGameId: clean(meta.G_ID), awayProbableId: Number(meta.T_PIT_P_ID), homeProbableId: Number(meta.B_PIT_P_ID),
    awayProbable: clean(meta.T_PIT_P_NM), homeProbable: clean(meta.B_PIT_P_NM), probableSource: 'KBO_OFFICIAL_GAMECENTER_STARTER',
  };
  const identity = {
    away: { id: gamePatch.awayProbableId, name: gamePatch.awayProbable, source: gamePatch.probableSource, throws: statsRows[0]?.throws },
    home: { id: gamePatch.homeProbableId, name: gamePatch.homeProbable, source: gamePatch.probableSource, throws: statsRows[1]?.throws },
  };
  await Promise.all(['away', 'home'].map(async (side, index) => {
    const stats = statsRows[index];
    if (!stats) return;
    stats.battersFacedAcquisitionStatus = 'UNAVAILABLE_OR_IDENTITY_MISMATCH';
    if (compactName(stats.name) !== compactName(identity[side].name)
      || String(meta.SEASON_ID) !== clean(game.officialDate).slice(0, 4)) return;
    // Live cumulative pages cannot be used to repair historical snapshots.
    if (!kboTbfAcquisitionEligible(game, new Date().toISOString())) {
      stats.battersFacedAcquisitionStatus = 'EXCLUDED_NOT_CURRENT_SEASON_PREGAME';
      return;
    }
    const url = `https://www.koreabaseball.com/Record/Player/PitcherDetail/Basic.aspx?playerId=${identity[side].id}`;
    try {
      const html = await officialFetch(url, { ...options, format: 'text' });
      const parsed = parseKboOfficialTbf(html, { playerId: identity[side].id, name: identity[side].name,
        teamCode: clean(side === 'away' ? meta.AWAY_ID : meta.HOME_ID), season: clean(game.officialDate).slice(0, 4) });
      const event = options.sourceObservations?.filter(row => row.url === url && row.success).at(-1);
      if (!parsed || !event || !kboTbfAcquisitionEligible(game, event.fetchedAt)
        || !kboTbfAcquisitionEligible(game, new Date().toISOString())) return;
      stats.battersFaced = parsed.battersFaced;
      stats.battersFacedAcquisitionStatus = 'OFFICIAL_TBF_PARSED';
      stats.battersFacedSourceEvidence = { ...parsed, url, sourceEventId: event.id,
        contentHash: event.contentHash, fetchedAt: event.fetchedAt };
    } catch { /* Existing estimated input remains explicitly disclosed; no fabricated count. */ }
  }));
  const weatherRows = weatherPayload?.gameList || weatherPayload?.game || [];
  const weatherRow = (Array.isArray(weatherRows) ? weatherRows : []).find(row => clean(row?.gameId || row?.G_ID) === clean(meta.G_ID)) || null;
  return {
    details, identity, gamePatch,
    starterStats: { away: statsRows[0], home: statsRows[1] },
    weatherRow,
  };
}

function cpblRosterPlayers(payload) {
  return payload?.Data?.Players || payload?.data?.players || [];
}

function findCpblPlayer(players, evidence, teamCode) {
  if (!evidence?.name) return null;
  const match = players.find(row => compactName(row?.CHName) === compactName(evidence.name)
    && clean(row?.Team?.Code) === teamCode && clean(row?.DefendStation) === '1');
  return match ? { id: clean(match.Acnt), name: clean(match.CHName).replace(/^[*#]/, ''), source: evidence.source, throws: evidence.throws } : null;
}

async function buildCpbl(game, history, options, starterEvidence) {
  const [details, rosterPayload, pitcherPayload] = await Promise.all([
    cpblDetails(selectedRecentGames(history, game, 6), options),
    officialFetch('https://stats.cpbl.com.tw/api/proxy/v1/players/autocomplete', options).catch(() => ({ Data: { Players: [] } })),
    officialFetch(`https://stats.cpbl.com.tw/api/proxy/v1/leaderboards/pr-table?searchType=pitcher&gameKind=A&year=${clean(game.officialDate).slice(0, 4)}`, options).catch(() => ({ Data: [] })),
  ]);
  const players = cpblRosterPlayers(rosterPayload);
  const currentDetail = await officialFetch(`https://stats.cpbl.com.tw/api/proxy/v1/games/${encodeURIComponent(clean(game.providerGameId))}`, options)
    .then(parseCpblGameDetailPayload).catch(() => null);
  const currentStarter = side => currentDetail?.[side]?.pitchers?.find(row => row.starter === true) || null;
  const identity = {};
  for (const side of ['away', 'home']) {
    const teamCode = CPBL_TEAM_ID[side === 'away' ? game.awayCode : game.homeCode];
    const teamId = side === 'away' ? game.awayTeamId : game.homeTeamId;
    const officialCurrent = currentStarter(side);
    identity[side] = officialCurrent
      ? { id: officialCurrent.id, name: officialCurrent.name, source: 'CPBL_OFFICIAL_CURRENT_GAME_STARTER' }
      : findCpblPlayer(players, starterEvidence?.[side], teamCode)
        || projectCpblRotationStarter(details, teamId, game.gameDate);
  }
  const leaderRows = pitcherPayload?.Data?.Leaderboard || pitcherPayload?.Data?.Rows || pitcherPayload?.Data?.Table || pitcherPayload?.Data || [];
  const rows = Array.isArray(leaderRows) ? leaderRows : [];
  const validWobaRows = rows.filter(row => number(row?.Woba) != null && number(row?.Woba) >= 0 && number(row?.Pa) > 0);
  const leaguePa = validWobaRows.reduce((sum, row) => sum + number(row.Pa), 0);
  const leagueWoba = leaguePa > 0 ? validWobaRows.reduce((sum, row) => sum + number(row.Woba) * number(row.Pa), 0) / leaguePa : null;
  const profiles = await Promise.all(['away', 'home'].map(side => identity[side]?.id
    ? officialFetch(`https://stats.cpbl.com.tw/api/proxy/v1/players/${encodeURIComponent(identity[side].id)}`, options).catch(() => null)
    : null));
  const starterStats = {};
  for (const [index, side] of ['away', 'home'].entries()) {
    const row = rows.find(item => clean(item?.Player?.Acnt) === clean(identity[side]?.id));
    const profile = profiles[index]?.Data?.Player?.Basic || null;
    if (identity[side] && profile) {
      const officialThrows = clean(profile.PitchingHabbit).toUpperCase();
      identity[side].throws = ['L', 'R'].includes(officialThrows) ? officialThrows : identity[side].throws;
      identity[side].isForeign = clean(profile.IsForeign) === '1';
      identity[side].officialRosterValidated = clean(profile.Acnt) === clean(identity[side].id)
        && clean(profile.Team?.Code) === CPBL_TEAM_ID[side === 'away' ? game.awayCode : game.homeCode];
    }
    const woba = number(row?.Woba);
    const battersFaced = number(row?.Pa);
    if (row && woba != null && woba >= 0 && battersFaced > 0 && leagueWoba > 0) starterStats[side] = {
      battersFaced, woba, leagueWoba, qualityFactor: clamp(woba / leagueWoba, 0.65, 1.45),
      observedAt: options.sourceObservations?.find(item => item.url.includes('/leaderboards/pr-table?searchType=pitcher'))?.observedAt || null,
      performanceMetric: 'WOBA_ALLOWED_RELATIVE_TO_OFFICIAL_PITCHER_SAMPLE',
      performanceSource: 'CPBL_OFFICIAL_INDIVIDUAL_PITCHER_WOBA',
      inningsPitched: null, estimatedInningsPitched: battersFaced / 4.25,
      inningsPitchedEstimated: false, inningsPitchedMethod: 'UNAVAILABLE_BF_PROXY_RETAINED_SEPARATELY',
      appearances: null, throws: identity[side]?.throws,
    };
    if (!starterStats[side] && identity[side]) {
      const teamId = side === 'away' ? game.awayTeamId : game.homeTeamId;
      const recent = recentStarterRows(details, teamId, identity[side]);
      const inningsPitched = recent.reduce((sum, item) => sum + (number(item.inningsPitched) || 0), 0);
      const recentBattersFaced = recent.reduce((sum, item) => sum + (number(item.battersFaced) || 0), 0);
      const earnedRuns = recent.every(item => number(item.earnedRuns) != null)
        ? recent.reduce((sum, item) => sum + number(item.earnedRuns), 0) : null;
      const hits = recent.every(item => number(item.hits) != null)
        ? recent.reduce((sum, item) => sum + number(item.hits), 0) : null;
      const walks = recent.every(item => number(item.walks) != null)
        ? recent.reduce((sum, item) => sum + number(item.walks), 0) : null;
      if (recent.length && inningsPitched > 0 && recentBattersFaced >= 12) starterStats[side] = {
        battersFaced: recentBattersFaced,
        inningsPitched,
        appearances: recent.length,
        gamesStarted: recent.length,
        era: earnedRuns == null ? null : earnedRuns * 9 / inningsPitched,
        whip: hits == null || walks == null ? null : (hits + walks) / inningsPitched,
        throws: identity[side]?.throws,
        performanceSource: 'CPBL_OFFICIAL_RECENT_INDIVIDUAL_STARTS_REGRESSED',
      };
    }
  }
  const gamePatch = identity.away && identity.home ? {
    awayProbableId: identity.away.id, homeProbableId: identity.home.id,
    awayProbable: identity.away.name, homeProbable: identity.home.name,
    awayProbableThrows: identity.away.throws || null, homeProbableThrows: identity.home.throws || null,
    probableSource: identity.away.projected || identity.home.projected
      ? 'CPBL_OFFICIAL_ROTATION_PROJECTED_STARTER'
      : 'CPBL_OFFICIAL_ROSTER_VALIDATED_STARTER_IDENTITY',
  } : {};
  return { details, identity, starterStats, gamePatch };
}

export async function buildAsianProductionFeatureSnapshot({
  leagueId,
  game,
  history,
  fetchImpl = globalThis.fetch,
  timeoutMs = 12_000,
  starterEvidence = null,
} = {}) {
  const league = clean(leagueId).toUpperCase();
  if (!['NPB', 'KBO', 'CPBL'].includes(league)) throw new Error(`不支援的亞洲Production特徵聯盟：${league}`);
  const sourceObservations = [];
  const sourceContents = {};
  const options = { fetchImpl, timeoutMs, sourceObservations, sourceContents };
  const firstPitchAt = Date.parse(game?.gameDate || '');
  history = (Array.isArray(history) ? history : []).filter(row => {
    const at = Date.parse(row?.gameDate || '');
    return Number.isFinite(at) && Number.isFinite(firstPitchAt) && at < firstPitchAt
      && number(row?.awayScore) != null && number(row?.homeScore) != null;
  });
  let source;
  try {
    source = league === 'NPB'
      ? await buildNpb(game, history, options)
      : league === 'KBO'
        ? await buildKbo(game, history, options)
        : await buildCpbl(game, history, options, starterEvidence);
  } catch (error) {
    source = { details: [], identity: {}, starterStats: {}, gamePatch: {}, pipelineError: clean(error?.message) };
  }
  const resolvedGame = { ...game, ...source.gamePatch };
  const leagueRuns = mean(history.map(row => (Number(row.awayScore) + Number(row.homeScore)) / 2));
  const referenceEra = clamp((leagueRuns || 4.3) * 0.90, 2.6, 5.4);
  const park = parkSnapshot(league, history, resolvedGame, source.details, leagueRuns || 4.3);
  const observedAt = sourceObservations.filter(row => row.success === true).map(row => row.fetchedAt).sort().at(-1) || new Date().toISOString();
  const featureSnapshot = {
    version: ASIAN_PRODUCTION_FEATURES_V1_VERSION,
    asOf: observedAt,
    observedAt,
    collectedAt: new Date().toISOString(),
    sourceObservations,
    sourceEvidence: { version: 'ASIAN-SOURCE-EVIDENCE-v1', contents: sourceContents,
      events: [...new Map(sourceObservations.filter(row => row.id).map(row => [row.id, row])).values()],
      features: [] },
    temporalProvenance: {
      currentSeasonStatsFetchedNow: true,
      historicalReplayEligible: Date.parse(observedAt) < firstPitchAt,
      historicalReplayReason: Date.parse(observedAt) < firstPitchAt
        ? 'ACTUAL_OBSERVATION_PRECEDES_TARGET_FIRST_PITCH'
        : 'CURRENT_OFFICIAL_SEASON_TOTALS_REQUIRE_ARCHIVED_PRE_GAME_SNAPSHOT',
      targetFirstPitch: resolvedGame.gameDate,
    },
    away: {}, home: {}, park,
    weather: { available: false, scenarioAvailable: false, source: 'UNAVAILABLE' },
    rules: {},
    ...(source.pipelineError ? { pipelineError: source.pipelineError } : {}),
  };
  for (const side of ['away', 'home']) {
    const teamId = side === 'away' ? resolvedGame.awayTeamId : resolvedGame.homeTeamId;
    const identity = source.identity?.[side];
    const recentStarts = identity ? recentStarterRows(source.details, teamId, identity) : [];
    const starter = starterSnapshot({ leagueId: league, game: resolvedGame, side, identity,
      stats: source.starterStats?.[side] ? { ...source.starterStats[side], observedAt: source.starterStats[side].observedAt || observedAt } : null,
      referenceEra, recentStarts });
    const starterPrediction = starter ? null : rotationPrediction(source.details, teamId, resolvedGame.gameDate, league);
    featureSnapshot[side] = {
      teamStrength: strengthSnapshot(league, history, teamId),
      starter: starter || starterPrediction,
      lineup: projectedLineup(source.details, teamId, league, source.battingStats?.[side], source.battingStatsObservedAt?.[side]),
      bullpen: bullpenSnapshot(source.details, teamId, league, referenceEra, resolvedGame.gameDate),
    };
  }
  validateAsianTeamFeatureOwnership(featureSnapshot, resolvedGame.awayTeamId, resolvedGame.homeTeamId);
  if (league === 'KBO') {
    const dome = park?.dome === true;
    const weather = source.weatherRow || null;
    featureSnapshot.weather = dome ? {
      available: true, scenarioAvailable: true, meanRunFactor: 1, dome: true, roofConfirmed: true,
      source: 'KBO_OFFICIAL_RECOGNIZED_DOME_BYPASS',
    } : weather ? {
      available: true, scenarioAvailable: true, meanRunFactor: 1, dome: false, roofConfirmed: false,
      temperatureC: number(weather.gameTemp ?? weather.TEMP), precipitation: number(weather.gameRain ?? weather.RAIN),
      source: 'KBO_OFFICIAL_STADIUM_WEATHER_PIT_NO_UNVERIFIED_RUN_DELTA',
    } : featureSnapshot.weather;
    const secondGame = Number(resolvedGame.gameNumber || 1) > 1;
    const firstGameIncluded = history.some(row => row.officialDate === resolvedGame.officialDate
      && Number(row.gameNumber || 1) < Number(resolvedGame.gameNumber || 1));
    // Preserve the legacy model input; expose its weaker evidence independently.
    // A final score alone does not establish that first-game pitcher usage was consumed.
    featureSnapshot.rules.doubleheader = { secondGameBullpenRecomputed: !secondGame || firstGameIncluded,
      firstGameUsageVerified: false, legacyRecomputedFlagDoesNotProveUsage: true };
  }
  if (league === 'CPBL') {
    const foreignApplies = source.identity?.away?.isForeign === true || source.identity?.home?.isForeign === true;
    featureSnapshot.rules.foreignPlayerConstraint = foreignApplies ? {
      status: 'DIAGNOSTIC_ONLY', applies: true,
      pitcherExitLineupTransitionModeled: false, first5FullDifferentiated: false,
      source: 'CPBL_OFFICIAL_PLAYER_PROFILE_FOREIGN_STATUS',
    } : {
      status: 'NOT_APPLICABLE', applies: false,
      source: 'CPBL_OFFICIAL_PLAYER_PROFILE_FOREIGN_STATUS_AUDIT',
    };
  }
  featureSnapshot.sourceEvidence.features = ['away', 'home'].flatMap(side =>
    ['starter', 'lineup', 'bullpen'].map(key => ({
      featureName: `${side}.${key}`, complete: !source.pipelineError,
      requiredFeatures: ['gameIdentity', 'history'],
      dependencyScope: 'CONSERVATIVE_FEATURE_PIPELINE_INPUT_GROUP',
      sourceEventIds: [...new Set(sourceObservations.filter(row => row.success).map(row => row.id))],
      sourcePaths: ['$'], derivationVersion: ASIAN_PRODUCTION_FEATURES_V1_VERSION,
      parsedInput: featureSnapshot[side][key],
    })));
  if (league === 'CPBL') {
    for (const row of featureSnapshot.sourceEvidence.features) {
      row.sourceBindings = cpblFeatureBindings({ featureName: row.featureName, parsedInput: row.parsedInput, game: resolvedGame, events: featureSnapshot.sourceEvidence.events, contents: sourceContents });
      row.sourceEventIds = [...new Set(row.sourceBindings.map(binding => binding.eventId))];
      row.sourcePaths = row.sourceBindings.map(binding => binding.path);
      row.dependencyScope = 'CPBL_FEATURE_SOURCE_SECTIONS_AND_HISTORY';
    }
  }
  try { featureSnapshot.sourceEvidence = (await externalizeAsianSourceEvidence({ sourceEvidence: featureSnapshot.sourceEvidence })).sourceEvidence; }
  catch { featureSnapshot.sourceEvidence.persistenceStatus = 'SOURCE_STORE_UNAVAILABLE_INLINE_EVIDENCE_RETAINED'; }
  return { featureSnapshot, gamePatch: source.gamePatch, game: resolvedGame };
}
