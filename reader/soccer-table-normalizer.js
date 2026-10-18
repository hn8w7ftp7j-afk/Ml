(() => {
  const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const homeMarker = /[\[［【(（]\s*主\s*[\]］】)）]/u;
  const props = /角球|CORNERS?|罰牌|罚牌|卡牌|黃牌|黄牌|紅牌|红牌|BOOKINGS?/i;
  const date = /^\d{1,2}[/-]\d{1,2}$/;
  const time = /^(?:[01]?\d|2[0-3]):[0-5]\d$/;
  const water = /^\d{1,4}\.\d{1,3}$/;
  const line = '\\d+(?:\\.\\d+)?(?:平|[+-]\\d{1,3})?';
  const scope = /(?:全場|全场|上半場|上半场|上半|第[一1]半場|第[一1]半场|FULL[ -]?TIME|FIRST\s+HALF|1ST\s+HALF|\bFT\b|\bHT\b|\b1H\b)/gi;

  function columnKey(value) {
    const text = clean(value).replace(scope, '').replace(/[\s:：()（）-]/g, '');
    return ({ 時間: 'time', 时间: 'time', 主客隊伍: 'teams', 主客队伍: 'teams', 隊伍: 'teams', 队伍: 'teams',
      獨贏: 'moneyline', 独赢: 'moneyline', 讓球: 'runline', 让球: 'runline', 讓分: 'runline', 让分: 'runline',
      大小: 'total', 大小盤: 'total', 大小盘: 'total' })[text] || null;
  }

  function columns(record) {
    const values = (record.cells || []).map(cell => ({ key: columnKey(cell.text), text: clean(cell.text), left: cell.left, right: cell.right }));
    if (!values.some(cell => cell.key === 'time') || !values.some(cell => cell.key === 'teams')
      || !values.some(cell => cell.key === 'runline') || !values.some(cell => cell.key === 'total')) return null;
    if (values.some(cell => !Number.isFinite(cell.left) || !Number.isFinite(cell.right) || cell.right <= cell.left)) return null;
    return values.sort((a, b) => a.left - b.left);
  }

  // Use the complete header cell boundaries. A neighbouring odd/even or half
  // market never contributes text to a goal quote, including the final column.
  function bands(records, column) {
    const parts = [];
    for (const record of records) for (const cell of record.cells || []) {
      if (cell.left < column.left - 2 || cell.right > column.right + 2) continue;
      const rows = cell.rows?.length ? cell.rows : (cell.lines || [cell.text]).map((text, index) => ({ text, top: cell.top + index * 18, left: cell.left }));
      for (const part of rows) {
        const text = clean(part.text);
        if (text && Number.isFinite(part.top)) parts.push({ text, top: part.top, left: part.left ?? cell.left });
      }
    }
    const result = [];
    for (const part of parts.sort((a, b) => a.top - b.top || a.left - b.left)) {
      let band = result.find(value => Math.abs(value.top - part.top) <= 5);
      if (!band) { band = { top: part.top, parts: [] }; result.push(band); }
      if (!band.parts.some(value => value.text === part.text && Math.abs(value.left - part.left) < 2)) band.parts.push(part);
    }
    return result.map(band => ({ top: band.top, text: clean(band.parts.sort((a, b) => a.left - b.left).map(part => part.text).join(' ')) }));
  }

  function teamQuoteRows(rows, teams) {
    if (rows.length !== 2) return null;
    const aligned = teams.map(team => rows.filter(row => Math.abs(row.top - team.top) <= 6));
    return aligned.every(matches => matches.length === 1) && aligned[0][0] !== aligned[1][0] ? aligned.map(matches => matches[0].text) : null;
  }
  function quote(key, rows, teams, home) {
    if (!rows.length) return { pair: ['', ''] };
    if (rows.every(row => /^[-－—]$/.test(row.text))) {
      if (rows.length !== (key === 'moneyline' ? 3 : 2)) return null;
      return { pair: rows.map(row => row.text) };
    }
    const texts = rows.map(row => row.text);
    if (key === 'moneyline') {
      if (rows.length !== 3 || texts.some(text => !water.test(text))) return null;
      const sides = teams.map(team => rows.filter(row => Math.abs(row.top - team.top) <= 6));
      if (sides.some(values => values.length !== 1) || sides[0][0] === sides[1][0]) return null;
      const draw = rows.filter(row => !sides.some(values => values[0] === row));
      if (draw.length !== 1) return null;
      return { pair: [`主勝 ${sides[home][0].text}`, `和 ${draw[0].text}`, `客勝 ${sides[1 - home][0].text}`] };
    }
    if (key === 'runline') {
      const sides = teamQuoteRows(rows, teams);
      if (!sides) return null;
      const values = sides.map(text => clean(text).replace(/＋/g, '+').replace(/[－–—−]/g, '-'));
      const hasLine = new RegExp(`^${line}\\s+\\d{1,4}\\.\\d{1,3}$`);
      if (values.filter(text => hasLine.test(text)).length !== 1 || values.some(text => !hasLine.test(text) && !water.test(text))) return null;
      return { pair: [values[1 - home], values[home]] };
    }
    if (key === 'total') {
      if (rows.length !== 2) return null;
      // Preserve the line and price tokens; canonicalise only the display
      // order "3平 大" to the existing soccer parser's "大3平" grammar.
      const values = texts.map(text => text.replace(/＋/g, '+').replace(/[－–—−]/g, '-'));
      const before = new RegExp(`^(${line})\\s*大\\s+(\\d{1,4}\\.\\d{1,3})$`);
      const over = values.map(text => text.replace(before, '大$1 $2'));
      const overPattern = new RegExp(`^大${line}\\s+\\d{1,4}\\.\\d{1,3}$`);
      const upper = over.filter(text => overPattern.test(text)), lower = over.filter(text => /^小\s+\d{1,4}\.\d{1,3}$/.test(text));
      return upper.length === 1 && lower.length === 1 ? { pair: [upper[0], lower[0]] } : null;
    }
    return null;
  }

  function normalize(groups, league) {
    const registry = globalThis.Tai888LeagueRegistry, tables = new Map(), identities = new Set(), issues = new Set();
    let label = '', excludedProps = 0, rawTableRowCount = 0;
    for (const records of (Array.isArray(groups) ? groups : []).slice(0, 32)) {
      let header = null, sectionTitle = '', accepted = false, pending = [];
      function flush() {
        if (!pending.length || !accepted || !header) { pending = []; return; }
        const records = pending; pending = []; rawTableRowCount++;
        const timeColumn = header.find(cell => cell.key === 'time'), teamColumn = header.find(cell => cell.key === 'teams');
        const times = bands(records, timeColumn).map(row => row.text).filter(value => date.test(value) || time.test(value));
        const day = times.filter(value => date.test(value)), clock = times.filter(value => time.test(value));
        const names = bands(records, teamColumn).filter(row => !/^[★☆*\s]+$/.test(row.text));
        if (names.some(row => props.test(row.text))) { excludedProps++; return; }
        const teams = names.map(row => ({ ...row, team: globalThis.Tai888SoccerTeams?.resolve(row.text) }));
        if (day.length !== 1 || clock.length !== 1 || teams.length !== 2 || teams.some(row => !row.team)
          || teams[0].team.key === teams[1].team.key || teams.filter(row => homeMarker.test(row.text)).length !== 1) {
          issues.add('SOCCER_TABLE_IDENTITY_INVALID'); return;
        }
        const home = homeMarker.test(teams[0].text) ? 0 : 1, evidence = [];
        for (const column of header.filter(cell => ['runline', 'total', 'moneyline'].includes(cell.key))) {
          const period = registry.soccerPeriodEvidence({ sectionTitle, headers: header.map(cell => cell.text), marketHeader: column.text });
          if (period.status === 'EXCLUDED') continue;
          const raw = quote(column.key, bands(records, column), teams, home);
          if (!raw) { issues.add('SOCCER_TABLE_QUOTES_AMBIGUOUS'); return; }
          evidence.push({ key: column.key, header: column.text, period: period.period, ...raw });
        }
        if (!evidence.some(item => item.pair.some(Boolean))) return;
        if (new Set(evidence.map(item => `${item.key}:${item.period}`)).size !== evidence.length) { issues.add('SOCCER_TABLE_HEADERS_AMBIGUOUS'); return; }
        const boardTime = clock[0].padStart(5, '0');
        identities.add([day[0], boardTime, teams[1 - home].team.key, teams[home].team.key].join('|'));
        for (const period of new Set(evidence.map(item => item.period))) {
          const selected = evidence.filter(item => item.period === period);
          const rawHeaders = [timeColumn.text, teamColumn.text, ...['runline', 'total', 'moneyline'].map(key => selected.find(item => item.key === key)?.header || ''),
            ...header.filter(cell => !cell.key).map(cell => cell.text)];
          const periodEvidenceTruncated = rawHeaders.length > 12 || rawHeaders.some(value => value.length > 160);
          const headers = rawHeaders.slice(0, 12).map(value => value.slice(0, 160));
          const tableKey = JSON.stringify({ sectionTitle, headers, periodEvidenceTruncated });
          if (!tables.has(tableKey)) tables.set(tableKey, { sectionTitle, headers, ...(periodEvidenceTruncated ? { periodEvidenceTruncated: true } : {}), rows: [] });
          tables.get(tableKey).rows.push({ cells: [
            { pair: [day[0], boardTime] }, { pair: [teams[1 - home].text, teams[home].text] },
            ...['runline', 'total', 'moneyline'].map(key => ({ pair: selected.find(item => item.key === key)?.pair || ['', ''] })),
          ] });
        }
      }
      for (const record of records.slice(0, 1200)) {
        const nextHeader = columns(record), text = clean(record.text);
        if (nextHeader) { flush(); header = nextHeader; continue; }
        const identified = text.length <= 240 ? registry.identify(text) : null;
        const headingRow = header && record.cells?.length === 1 && text.length <= 240
          && record.cells[0].right - record.cells[0].left >= (header.at(-1).right - header[0].left) * 0.7
          && !homeMarker.test(text) && !/\d{1,2}[/-]\d{1,2}|\d{1,2}:\d{2}|\d+\.\d/.test(text);
        if (identified || headingRow || /^(?:聯盟|联盟)\s*[:：]?/.test(text)) {
          flush(); sectionTitle = text.slice(0, 240); accepted = identified === league && registry.standardMarker(text, league);
          if (accepted) label ||= sectionTitle;
          continue;
        }
        if (!accepted || !header) continue;
        const days = bands([record], header.find(cell => cell.key === 'time')).filter(row => date.test(row.text));
        if (days.length) flush();
        if (days.length || pending.length) pending.push(record);
      }
      flush();
    }
    return { tables: [...tables.values()], diagnostics: { league, pageLeagueLabel: label, sawLeagueMarker: Boolean(label),
      gameCount: identities.size, expectedGameCount: issues.size ? null : identities.size || null,
      gameCountBasis: 'UNIQUE_DATE_TIME_TEAMS', rawTableRowCount, excludedProps, tableIssues: [...issues], conflictingGameKeys: [] } };
  }
  globalThis.Tai888SoccerTableNormalizer = Object.freeze({ normalize });
})();
