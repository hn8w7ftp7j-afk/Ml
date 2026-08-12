const LINE_TOKEN = /^(?:\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(?:平|[+-]\d{1,3})?$/;
const WATER_TOKEN = /^(?:0|1)\.\d{3}$/;

const clean = value => String(value || '')
  .replace(/[\u0000-\u001F\u007F]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

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
  const match = clean(value).match(/(?:^|\s)((?:0|1)\.\d{3})(?=\s|$)/);
  const number = match ? Number(match[1]) : null;
  return number != null && number >= 0.5 && number <= 1.5 ? number : null;
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
  if (pair) return pair;
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
  const line = awayLine || homeLine;
  if (!line) return null;
  return {
    lineSide: awayLine ? 'away' : homeLine ? 'home' : null,
    line,
    awayWater: waterIn(awayRow),
    homeWater: waterIn(homeRow),
    confidence: awayLine && homeLine ? 0.5 : 1,
    rawRows: [awayRow, homeRow],
  };
}

function parseTotal(cell) {
  const [topRow, bottomRow] = pairLines(cell);
  const line = lineTokenIn(topRow) || lineTokenIn(bottomRow);
  if (!line) return null;
  const topWater = waterIn(topRow);
  const bottomWater = waterIn(bottomRow);
  const topIsUnder = /(?:^|\s)小(?:\s|$)/.test(topRow);
  const bottomIsOver = /(?:^|\s)大(?:\s|$)/.test(bottomRow);
  return {
    line,
    overWater: topIsUnder ? bottomWater : topWater,
    underWater: bottomIsOver ? topWater : bottomWater,
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
  const found = [];
  for (const line of lines) {
    for (const match of line.matchAll(/(?:^|\s)([A-Z]{2,4})\s*-/g)) {
      const code = match[1].toUpperCase();
      if (!found.some(row => row.code === code)) {
        found.push({ code, text: line, homeMarked: /\[主\]/.test(line) });
      }
    }
  }
  return found.slice(0, 2);
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
    if (current.month === 12 && month === 1) year += 1;
    else if (current.month === 1 && month === 12) year -= 1;
    boardDate = `${year}-${String(month).padStart(2, '0')}-${String(Number(date[2])).padStart(2, '0')}`;
  }
  return {
    boardDate,
    time: time ? `${String(Number(time[1])).padStart(2, '0')}:${time[2]}` : '',
  };
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
      const homeIndex = teams.findIndex(team => team.homeMarked);
      const awayIndex = homeIndex === 0 ? 1 : 0;
      const normalizedHomeIndex = homeIndex >= 0 ? homeIndex : 1;
      const away = teams[awayIndex];
      const home = teams[normalizedHomeIndex];
      if (!away || !home || away.code === home.code) continue;
      const timing = parseDateTime(cells[map.time], now);
      const game = {
        awayCode: away.code,
        homeCode: home.code,
        awayRaw: away.text,
        homeRaw: home.text,
        boardDate: timing.boardDate,
        boardTime: timing.time,
        fullRunline: map.runline >= 0 ? parseRunline(cells[map.runline]) : null,
        fullTotal: map.total >= 0 ? parseTotal(cells[map.total]) : null,
        first5Runline: map.first5Runline >= 0 ? parseRunline(cells[map.first5Runline]) : null,
        first5Total: map.first5Total >= 0 ? parseTotal(cells[map.first5Total]) : null,
        rawRowText: clean(row?.text || ''),
      };
      if (![game.fullRunline, game.fullTotal, game.first5Runline, game.first5Total].some(Boolean)) continue;
      games.push(game);
    }
  }

  const unique = [];
  const seen = new Set();
  for (const game of games) {
    const key = `${game.boardDate}|${game.awayCode}|${game.homeCode}|${game.boardTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(game);
  }
  const boardDate = unique.map(game => game.boardDate).find(Boolean) || '';
  return {
    version: 'TAI888-READER-DOM-v2.0.2',
    sourceHost: clean(capture?.sourceHost).toLowerCase(),
    pageUrl: clean(capture?.pageUrl).slice(0, 500),
    pageTitle: clean(capture?.pageTitle).slice(0, 200),
    observedAt: clean(capture?.observedAt) || new Date().toISOString(),
    boardDate,
    games: unique.slice(0, 40),
  };
}

export function canonicalReaderPayload(payload) {
  return JSON.stringify({
    version: payload?.version || '',
    sourceHost: payload?.sourceHost || '',
    boardDate: payload?.boardDate || '',
    games: (payload?.games || []).map(game => ({
      awayCode: game.awayCode,
      homeCode: game.homeCode,
      boardDate: game.boardDate,
      boardTime: game.boardTime,
      fullRunline: game.fullRunline,
      fullTotal: game.fullTotal,
      first5Runline: game.first5Runline,
      first5Total: game.first5Total,
    })),
  });
}
