const LINE_TOKEN = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/;
const WATER_TOKEN = /^\d(?:\.\d{3})$/;
const HOME_MARKER = /[\[［【(（]\s*主\s*[\]］】)）]/u;
const TEAM_CODE = /(?:^|\s)([A-Z][A-Z0-9]{0,11})\s*-/g;
const LEAGUES = Object.freeze(['MLB', 'NPB', 'KBO', 'CPBL']);

const clean = value => String(value || '')
  .replace(/[\u0000-\u001F\u007F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

function sanitizeTai888Host(value) {
  try {
    const text = clean(value);
    if (!text) return '';
    const parsed = text.includes('://') ? new URL(text) : new URL(`https://${text}`);
    const host = parsed.hostname.toLowerCase();
    return host === 'tai888.in' || host.endsWith('.tai888.in') ? host : '';
  } catch {
    return '';
  }
}

export function sanitizeTai888PageUrl(value) {
  try {
    const parsed = new URL(String(value || ''));
    const host = parsed.hostname.toLowerCase();
    if (parsed.protocol !== 'https:'
      || (host !== 'tai888.in' && !host.endsWith('.tai888.in'))) return '';
    const marker = /^#\/BS(?:$|[/?&])/i.test(parsed.hash || '') ? '#/BS' : '';
    return `${parsed.origin}${parsed.pathname || '/'}${marker}`.slice(0, 500);
  } catch {
    return '';
  }
}

function explicitPair(cell) {
  if (!Array.isArray(cell?.pair) || cell.pair.length < 2) return null;
  return [clean(cell.pair[0]), clean(cell.pair[1])];
}

function cellLines(cell) {
  const pair = explicitPair(cell);
  if (pair) return pair.filter(Boolean);
  const raw = Array.isArray(cell?.lines)
    ? cell.lines
    : typeof cell === 'string' ? cell.split(/\r?\n/) : [];
  return raw.map(clean).filter(Boolean).slice(0, 24);
}

function waterIn(value) {
  const match = clean(value).match(/(?:^|[^0-9.])(\d\.\d{3})(?![0-9.])/);
  const number = match ? Number(match[1]) : null;
  return number != null && number >= 0.01 && number <= 3 ? number : null;
}

function tokenCandidates(value) {
  return clean(value)
    .replace(/[＋]/g, '+')
    .replace(/[－–—]/g, '-')
    .split(/\s+/)
    .map(token => token.replace(/^[^0-9]+|[^0-9平+\-./]+$/g, ''))
    .filter(token => token && LINE_TOKEN.test(token) && !WATER_TOKEN.test(token));
}

function lineTokenIn(value) {
  const candidates = tokenCandidates(value);
  return candidates.find(token => /平|[+-]|\//.test(token))
    || candidates.find(token => /^\d+\.5$/.test(token))
    || candidates[0]
    || '';
}

function pairLines(cell) {
  const pair = explicitPair(cell);
  if (pair) {
    const nonempty = pair.filter(Boolean);
    if (nonempty.length === 1) {
      const combined = nonempty[0];
      const waters = [...combined.matchAll(/(?:^|\s)(\d\.\d{3})(?=\s|$)/g)];
      if (waters.length === 2) {
        const firstEnd = Number(waters[0].index) + waters[0][0].length;
        return [clean(combined.slice(0, firstEnd)), clean(combined.slice(firstEnd))];
      }
    }
    return pair;
  }
  const lines = cellLines(cell);
  if (lines.length <= 2) return [lines[0] || '', lines[1] || ''];

  const rows = [];
  let buffer = [];
  for (const line of lines) {
    buffer.push(line);
    if (waterIn(line) != null) {
      rows.push(clean(buffer.join(' ')));
      buffer = [];
      if (rows.length === 2) break;
    }
  }
  if (buffer.length && rows.length < 2) rows.push(clean(buffer.join(' ')));
  if (rows.length >= 2) return [rows[0], rows[1]];
  const midpoint = Math.ceil(lines.length / 2);
  return [clean(lines.slice(0, midpoint).join(' ')), clean(lines.slice(midpoint).join(' '))];
}

function parseRunline(cell) {
  const [awayRow, homeRow] = pairLines(cell);
  const awayLine = lineTokenIn(awayRow);
  const homeLine = lineTokenIn(homeRow);
  // A Tai888 runline belongs to exactly one side.  If both visual rows contain
  // a line token, ownership cannot be proven and guessing would invert the bet.
  if ((!awayLine && !homeLine) || (awayLine && homeLine)) return null;
  const line = awayLine || homeLine;
  const awayWater = waterIn(awayRow);
  const homeWater = waterIn(homeRow);
  if (awayWater == null || homeWater == null) return null;
  return {
    lineSide: awayLine ? 'away' : 'home',
    line,
    awayWater,
    homeWater,
    confidence: 1,
    rawRows: [awayRow, homeRow],
  };
}

function parseTotal(cell) {
  const [topRow, bottomRow] = pairLines(cell);
  const topLine = lineTokenIn(topRow);
  const bottomLine = lineTokenIn(bottomRow);
  if (topLine && bottomLine && topLine !== bottomLine) return null;
  const line = topLine || bottomLine;
  if (!line) return null;
  const topWater = waterIn(topRow);
  const bottomWater = waterIn(bottomRow);
  if (topWater == null || bottomWater == null) return null;
  const topOver = /大/u.test(topRow);
  const topUnder = /小/u.test(topRow);
  const bottomOver = /大/u.test(bottomRow);
  const bottomUnder = /小/u.test(bottomRow);
  const normal = topOver && !topUnder && bottomUnder && !bottomOver;
  const inverted = topUnder && !topOver && bottomOver && !bottomUnder;
  // Row order is not a direction signal.  Both complementary labels must be
  // present, and a repeated line (when shown twice) must agree exactly.
  if (!normal && !inverted) return null;
  return {
    line,
    overWater: normal ? topWater : bottomWater,
    underWater: normal ? bottomWater : topWater,
    confidence: 1,
    rawRows: [topRow, bottomRow],
  };
}

function headerIndex(headers, patterns) {
  return headers.findIndex(value => patterns.some(pattern => pattern.test(clean(value))));
}

function mapHeaders(headers) {
  return {
    time: headerIndex(headers, [/^時間$/, /^时间$/, /開賽/, /开赛/]),
    teams: headerIndex(headers, [/主客隊伍/, /主客队伍/, /^隊伍$/, /^队伍$/]),
    runline: headerIndex(headers, [/^讓球$/, /^让球$/, /^全場讓球$/, /^全场让球$/]),
    total: headerIndex(headers, [/^大小盤$/, /^大小盘$/, /^全場大小$/, /^全场大小$/]),
    first5Runline: headerIndex(headers, [/上半讓球/, /上半让球/, /前5.*讓球/, /前五.*讓球/]),
    first5Total: headerIndex(headers, [/上半大小/, /前5.*大小/, /前五.*大小/]),
  };
}

function teamCodes(cell) {
  const pair = explicitPair(cell);
  const lines = pair || cellLines(cell);
  const found = new Map();
  for (const [index, line] of lines.entries()) {
    const matches = [...line.matchAll(TEAM_CODE)];
    for (const [matchIndex, match] of matches.entries()) {
      const code = match[1].toUpperCase();
      const nextIndex = matches[matchIndex + 1]?.index ?? line.length;
      const teamText = clean(line.slice(match.index, nextIndex));
      const candidate = {
        code,
        text: teamText,
        homeMarked: HOME_MARKER.test(teamText),
        order: index,
      };
      const previous = found.get(code);
      if (!previous || candidate.homeMarked || candidate.text.length > previous.text.length) {
        found.set(code, candidate);
      }
    }
  }
  return [...found.values()].sort((left, right) => left.order - right.order).slice(0, 2);
}

function taipeiParts(now) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(now)
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
}

function parseDateTime(cell, now = new Date()) {
  const pair = explicitPair(cell);
  const text = (pair || cellLines(cell)).join(' ');
  const date = text.match(/\b(\d{1,2})-(\d{1,2})\b/);
  const time = text.match(/\b(\d{1,2}):(\d{2})\b/);
  let boardDate = '';
  if (date) {
    const current = taipeiParts(now);
    let year = current.year;
    const month = Number(date[1]);
    const day = Number(date[2]);
    if (current.month === 12 && month === 1) year += 1;
    else if (current.month === 1 && month === 12) year -= 1;
    const check = new Date(Date.UTC(year, month - 1, day));
    if (month >= 1 && month <= 12 && day >= 1
      && check.getUTCFullYear() === year
      && check.getUTCMonth() === month - 1
      && check.getUTCDate() === day) {
      boardDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const hour = time ? Number(time[1]) : NaN;
  const minute = time ? Number(time[2]) : NaN;
  return {
    boardDate,
    time: Number.isInteger(hour) && hour >= 0 && hour <= 23
      && Number.isInteger(minute) && minute >= 0 && minute <= 59
      ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
      : '',
  };
}

function fallbackDateTime(row, cells, timeIndex, now) {
  const primary = parseDateTime(cells[timeIndex], now);
  if (primary.boardDate && primary.time) return primary;
  // Tai888 occasionally splits the month/day and clock into separate visual
  // fragments inside the same time column.  Only inspect that column plus the
  // row's non-market prefix; never scan runline/total cells where `1-20`
  // could be a price token mistaken for January 20.
  const source = cells[timeIndex];
  const rowText = clean(row?.text || '');
  const firstTeam = rowText.match(/(?:^|\s)[A-Z][A-Z0-9]{0,11}\s*-/);
  const prefix = firstTeam?.index > 0 ? rowText.slice(0, firstTeam.index) : '';
  const fallback = parseDateTime({
    lines: [...cellLines(source), prefix].filter(Boolean),
  }, now);
  return {
    boardDate: primary.boardDate || fallback.boardDate,
    time: primary.time || fallback.time,
  };
}

function marketFingerprint(game) {
  return JSON.stringify({
    fullRunline: canonicalRunline(game?.fullRunline),
    fullTotal: canonicalTotal(game?.fullTotal),
    first5Runline: canonicalRunline(game?.first5Runline),
    first5Total: canonicalTotal(game?.first5Total),
  });
}

function marketRichness(game) {
  return [game?.fullRunline, game?.fullTotal, game?.first5Runline, game?.first5Total]
    .reduce((count, market) => count + (market ? 1 : 0), 0);
}

function canonicalRunline(market) {
  if (!market) return null;
  return {
    lineSide: market.lineSide || '',
    line: market.line || '',
    awayWater: typeof market.awayWater === 'number' && Number.isFinite(market.awayWater) ? market.awayWater : null,
    homeWater: typeof market.homeWater === 'number' && Number.isFinite(market.homeWater) ? market.homeWater : null,
  };
}

function canonicalTotal(market) {
  if (!market) return null;
  return {
    line: market.line || '',
    overWater: typeof market.overWater === 'number' && Number.isFinite(market.overWater) ? market.overWater : null,
    underWater: typeof market.underWater === 'number' && Number.isFinite(market.underWater) ? market.underWater : null,
  };
}

const MARKET_FIELDS = Object.freeze([
  ['FULL_HANDICAP', 'fullRunline', 'runline', parseRunline],
  ['FULL_TOTAL', 'fullTotal', 'total', parseTotal],
  ['FIRST_HALF_HANDICAP', 'first5Runline', 'first5Runline', parseRunline],
  ['FIRST_HALF_TOTAL', 'first5Total', 'first5Total', parseTotal],
]);

function marketCellState(cell, parsed, explicitLock = false) {
  if (parsed) return 'AVAILABLE';
  const content = cellLines(cell).join(' ').trim();
  if (!content || explicitLock) return 'UNAVAILABLE';
  return 'BLOCKED';
}

export function parseTai888Capture(capture, now = new Date()) {
  const tables = Array.isArray(capture?.tables) ? capture.tables : [];
  const games = [];
  for (const table of tables.slice(0, 12)) {
    const headers = (table?.headers || []).map(clean);
    const map = mapHeaders(headers);
    if (map.teams < 0 || map.time < 0) continue;
    for (const row of (table?.rows || []).slice(0, 60)) {
      const cells = Array.isArray(row?.cells) ? row.cells : [];
      const requiredIndexes = Object.values(map).filter(index => index >= 0);
      if (!requiredIndexes.length || cells.length <= Math.max(...requiredIndexes)) continue;
      const teams = teamCodes(cells[map.teams]);
      if (teams.length !== 2) continue;
      const homeIndexes = teams
        .map((team, index) => team.homeMarked ? index : -1)
        .filter(index => index >= 0);
      if (homeIndexes.length !== 1) continue;
      const homeIndex = homeIndexes[0];
      const awayIndex = homeIndex === 0 ? 1 : 0;
      const away = teams[awayIndex];
      const home = teams[homeIndex];
      if (!away || !home || away.code === home.code) continue;
      const timing = fallbackDateTime(row, cells, map.time, now);
      if (!timing.boardDate || !timing.time) continue;
      const parsedMarkets = {};
      const marketStates = {};
      for (const [marketName, property, headerKey, parser] of MARKET_FIELDS) {
        const index = map[headerKey];
        const cell = index >= 0 ? cells[index] : null;
        const parsed = index >= 0 ? parser(cell) : null;
        parsedMarkets[property] = parsed;
        marketStates[marketName] = marketCellState(cell, parsed, row?.marketLocked === true);
      }
      const game = {
        awayCode: away.code,
        homeCode: home.code,
        awayRaw: away.text,
        homeRaw: home.text,
        boardDate: timing.boardDate,
        boardTime: timing.time,
        ...parsedMarkets,
        marketStates,
        rawRowText: clean(row?.text || ''),
        marketStatus: row?.marketLocked === true ? 'locked' : 'open',
      };
      const markets = [game.fullRunline, game.fullTotal, game.first5Runline, game.first5Total];
      // A complete date/time/team identity with zero captured market values is
      // non-executable by definition. Tai888 renders some locked games without
      // textual lock metadata, so retain it only as an unopened game. Partial
      // markets remain open and will fail the strict 4-market/8-direction gate.
      if (!markets.some(Boolean)) game.marketStatus = 'locked';
      if (game.marketStatus === 'locked' && markets.some(Boolean)) game.marketStatus = 'open';
      games.push(game);
    }
  }

  const unique = [];
  const seen = new Map();
  const conflictingGameKeys = [];
  for (const game of games) {
    const key = `${game.boardDate}|${game.awayCode}|${game.homeCode}|${game.boardTime}`;
    const fingerprint = marketFingerprint(game);
    if (seen.has(key)) {
      const previous = seen.get(key);
      const richness = marketRichness(game);
      if (richness > previous.richness) {
        unique[previous.index] = game;
        seen.set(key, { fingerprint, richness, index: previous.index });
        continue;
      }
      if (richness < previous.richness) continue;
      if (previous.fingerprint !== fingerprint && !conflictingGameKeys.includes(key)) conflictingGameKeys.push(key);
      continue;
    }
    seen.set(key, { fingerprint, richness: marketRichness(game), index: unique.length });
    unique.push(game);
  }
  const boardDate = unique.map(game => game.boardDate).find(Boolean) || '';
  const pageUrl = sanitizeTai888PageUrl(capture?.pageUrl);
  return {
    // Keep the wire contract at v2.1.0 until every deployed backend has been
    // upgraded. Capture internals are v2.2.0, but the v2.1 payload shape is a
    // strict compatible subset and avoids rejecting Reader 2.1.12 during rollout.
    version: 'TAI888-READER-DOM-v2.1.0',
    league: LEAGUES.includes(capture?.league) ? capture.league : '',
    sourceHost: sanitizeTai888Host(capture?.sourceHost) || sanitizeTai888Host(pageUrl),
    pageUrl,
    observedAt: clean(capture?.observedAt) || new Date().toISOString(),
    boardDate,
    games: unique.slice(0, 40),
    parseIssues: conflictingGameKeys.map(key => `conflicting-duplicate:${key}`),
  };
}

export function canonicalReaderPayload(payload) {
  const orderedGames = [...(payload?.games || [])].sort((left, right) => {
    const leftKey = `${left?.boardDate || ''}|${left?.boardTime || ''}|${left?.awayCode || ''}|${left?.homeCode || ''}`;
    const rightKey = `${right?.boardDate || ''}|${right?.boardTime || ''}|${right?.awayCode || ''}|${right?.homeCode || ''}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return JSON.stringify({
    version: payload?.version || '',
    league: LEAGUES.includes(payload?.league) ? payload.league : '',
    sourceHost: payload?.sourceHost || '',
    boardDate: payload?.boardDate || '',
    games: orderedGames.map(game => ({
      awayCode: game.awayCode,
      homeCode: game.homeCode,
      boardDate: game.boardDate,
      boardTime: game.boardTime,
      marketStatus: game.marketStatus === 'locked' ? 'locked' : 'open',
      ...(payload?.version === 'TAI888-READER-DOM-v2.2.0'
        && game.marketStates && Object.keys(game.marketStates).length ? { marketStates: game.marketStates } : {}),
      fullRunline: canonicalRunline(game.fullRunline),
      fullTotal: canonicalTotal(game.fullTotal),
      first5Runline: canonicalRunline(game.first5Runline),
      first5Total: canonicalTotal(game.first5Total),
    })),
  });
}
