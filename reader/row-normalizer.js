(() => {
  const clean = value => String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const DEFINITIONS = Object.freeze([
    { key: 'time', label: '時間', patterns: [/^時間$/, /^时间$/, /開賽/, /开赛/] },
    { key: 'teams', label: '主客隊伍', patterns: [/主客隊伍/, /主客队伍/, /^隊伍$/, /^队伍$/] },
    { key: 'runline', label: '讓球', patterns: [/^讓球$/, /^让球$/, /^全場讓球$/, /^全场让球$/] },
    { key: 'total', label: '大小盤', patterns: [/^大小盤$/, /^大小盘$/, /^全場大小$/, /^全场大小$/] },
    { key: 'moneyline', label: '獨贏', patterns: [/^獨贏$/, /^独赢$/] },
    { key: 'oneLoseTwoWin', label: '一輸二贏', patterns: [/一輸二贏/, /一输二赢/] },
    { key: 'first5Runline', label: '上半讓球', patterns: [/上半讓球/, /上半让球/, /前5.*讓球/, /前五.*讓球/] },
    { key: 'first5Total', label: '上半大小', patterns: [/上半大小/, /前5.*大小/, /前五.*大小/] },
  ]);

  const TEAM_CODE = /(?:^|\s)([A-Z]{2,4})\s*-/g;
  const leagueRegistry = globalThis.Tai888LeagueRegistry || Object.freeze({
    ids: ['MLB'],
    standardMarker: text => /(?:聯盟|联盟)\s*[:：]?\s*MLB\s*(?:美國職棒|美国职棒)/i.test(String(text || ''))
      && !/(?:走地|滾球|滚球|即時|即时|LIVE|IN[ -]?PLAY|總得分|总得分|主隊|主队|客隊|客队|單隊|单队|特殊)/i.test(String(text || '')),
  });
  // In-play rows can share the exact same MLB columns as the pre-game board.
  // They are a different contract and must never be merged into the official
  // pre-game slate merely because both league markers say MLB.
  const HOME_MARKER = /[\[［【(（]\s*主\s*[\]］】)）]/u;

  function number(value, fallback = 0) {
    const result = Number(value);
    return Number.isFinite(result) ? result : fallback;
  }

  function sortedRows(cell) {
    const rows = Array.isArray(cell?.rows) ? cell.rows : [];
    if (rows.length) {
      return rows
        .map(row => ({ text: clean(row?.text), top: number(row?.top), left: number(row?.left, number(cell?.left)) }))
        .filter(row => row.text)
        .sort((left, right) => left.top - right.top || left.left - right.left);
    }
    return (Array.isArray(cell?.lines) ? cell.lines : [])
      .map((text, index) => ({ text: clean(text), top: index * 20, left: number(cell?.left) }))
      .filter(row => row.text);
  }

  function headerDefinition(text) {
    const value = clean(text);
    return DEFINITIONS.find(definition => definition.patterns.some(pattern => pattern.test(value))) || null;
  }

  function buildHeaderProfile(record) {
    const columns = {};
    for (const cell of Array.isArray(record?.cells) ? record.cells : []) {
      const definition = headerDefinition(cell?.text || (cell?.lines || []).join(' '));
      if (!definition || columns[definition.key]) continue;
      const left = number(cell?.left, NaN);
      const right = number(cell?.right, NaN);
      if (!Number.isFinite(left) || !Number.isFinite(right) || right <= left) continue;
      columns[definition.key] = { left, right, label: definition.label };
    }
    const minimum = ['time', 'teams', 'runline', 'total', 'first5Runline', 'first5Total'];
    if (!minimum.every(key => columns[key])) return null;
    return {
      order: number(record?.order),
      top: number(record?.top),
      columns,
      headers: DEFINITIONS.map(definition => definition.label),
    };
  }

  function clusterRows(cells) {
    const fragments = [];
    for (const cell of cells) {
      for (const row of sortedRows(cell)) {
        fragments.push({ ...row, left: number(row.left, number(cell?.left)) });
      }
    }
    fragments.sort((left, right) => left.top - right.top || left.left - right.left);
    const clusters = [];
    for (const fragment of fragments) {
      let cluster = clusters.find(row => Math.abs(row.top - fragment.top) <= 6);
      if (!cluster) {
        cluster = { top: fragment.top, parts: [] };
        clusters.push(cluster);
      }
      cluster.parts.push(fragment);
    }
    return clusters
      .sort((left, right) => left.top - right.top)
      .map(cluster => ({
        top: cluster.top,
        text: clean(cluster.parts.sort((left, right) => left.left - right.left).map(part => part.text).join(' ')),
      }))
      .filter(row => row.text);
  }

  function mergeColumn(record, span) {
    if (!span) return { text: '', lines: [], rows: [] };
    const cells = (Array.isArray(record?.cells) ? record.cells : [])
      .filter(cell => {
        const left = number(cell?.left, NaN);
        const right = number(cell?.right, NaN);
        if (!Number.isFinite(left) || !Number.isFinite(right)) return false;
        const center = (left + right) / 2;
        return center >= span.left - 3 && center <= span.right + 3;
      })
      .sort((left, right) => number(left?.left) - number(right?.left));
    const rows = clusterRows(cells);
    const lines = rows.map(row => row.text);
    return { text: clean(lines.join(' ')), lines, rows };
  }

  function mapRecord(record, profile) {
    const mapped = {};
    for (const definition of DEFINITIONS) {
      mapped[definition.key] = mergeColumn(record, profile?.columns?.[definition.key]);
    }
    return {
      order: number(record?.order),
      top: number(record?.top),
      bottom: number(record?.bottom),
      rawText: clean(record?.text),
      marketLocked: record?.marketLocked === true,
      mapped,
      profile,
    };
  }

  function teamRows(mappedRow) {
    const sourceRows = mappedRow?.mapped?.teams?.rows?.length
      ? mappedRow.mapped.teams.rows
      : (mappedRow?.mapped?.teams?.lines || []).map((text, index) => ({ text, top: index * 20 }));
    const found = new Map();
    for (const row of sourceRows) {
      for (const match of clean(row.text).matchAll(TEAM_CODE)) {
        const code = match[1].toUpperCase();
        const candidate = {
          code,
          text: clean(row.text),
          top: number(row.top),
          homeMarked: HOME_MARKER.test(row.text),
        };
        const previous = found.get(code);
        if (!previous || candidate.homeMarked || candidate.text.length > previous.text.length) {
          found.set(code, candidate);
        }
      }
    }
    if (!found.size) {
      for (const match of clean(mappedRow?.rawText).matchAll(TEAM_CODE)) {
        const code = match[1].toUpperCase();
        if (!found.has(code)) {
          found.set(code, {
            code,
            text: clean(mappedRow?.rawText),
            top: number(mappedRow?.top),
            homeMarked: HOME_MARKER.test(mappedRow?.rawText),
          });
        }
      }
    }
    return [...found.values()].sort((left, right) => left.top - right.top).slice(0, 2);
  }

  function valueNear(cell, targetTop, fallbackIndex = 0) {
    const rows = Array.isArray(cell?.rows) ? cell.rows : [];
    if (rows.length && Number.isFinite(Number(targetTop))) {
      const nearest = [...rows].sort((left, right) => Math.abs(number(left.top) - targetTop) - Math.abs(number(right.top) - targetTop))[0];
      if (nearest && Math.abs(number(nearest.top) - targetTop) <= 14) return clean(nearest.text);
    }
    return clean(cell?.lines?.[fallbackIndex] || '');
  }

  function pairedCell(awayValue, homeValue) {
    const pair = [clean(awayValue), clean(homeValue)];
    return { pair, lines: pair.filter(Boolean) };
  }

  function buildFromSingle(mappedRow, teams) {
    if (teams.length !== 2) return null;
    const homeIndexes = teams
      .map((team, index) => team.homeMarked ? index : -1)
      .filter(index => index >= 0);
    if (homeIndexes.length !== 1) return null;
    const homeIndex = homeIndexes[0];
    const awayIndex = homeIndex === 0 ? 1 : 0;
    const away = teams[awayIndex];
    const home = teams[homeIndex];
    if (!away || !home || away.code === home.code) return null;

    const cells = DEFINITIONS.map(definition => {
      const cell = mappedRow.mapped[definition.key];
      return pairedCell(
        valueNear(cell, away.top, awayIndex),
        valueNear(cell, home.top, homeIndex),
      );
    });
    return { cells, text: mappedRow.rawText, awayCode: away.code, homeCode: home.code, marketLocked: mappedRow.marketLocked };
  }

  function buildFromSplit(awayRow, homeRow) {
    const awayTeams = teamRows(awayRow);
    const homeTeams = teamRows(homeRow);
    if (awayTeams.length !== 1 || homeTeams.length !== 1) return null;
    const away = awayTeams[0];
    const home = homeTeams[0];
    if (away.code === home.code || away.homeMarked || !home.homeMarked) return null;
    const awayTime = clean(awayRow.mapped.time?.text);
    const homeTime = clean(homeRow.mapped.time?.text);
    // Tai888 split rows carry the date on the away row and clock time on the
    // home row.  Requiring that structure prevents adjacent events from being
    // paired merely because their visual coordinates happen to be close.
    if (!/^\d{1,2}-\d{1,2}$/.test(awayTime) || !/^\d{1,2}:\d{2}$/.test(homeTime)) return null;
    const cells = DEFINITIONS.map(definition => pairedCell(
      awayRow.mapped[definition.key]?.text,
      homeRow.mapped[definition.key]?.text,
    ));
    return {
      cells,
      text: clean(`${awayRow.rawText} | ${homeRow.rawText}`),
      awayCode: away.code,
      homeCode: home.code,
      marketLocked: awayRow.marketLocked || homeRow.marketLocked,
    };
  }

  function isStandardLeagueRow(text, expectedLeague = 'MLB') {
    return leagueRegistry.standardMarker(clean(text), expectedLeague);
  }

  function isLeagueMarker(text) {
    return /(?:聯盟|联盟)\s*[:：]?/i.test(clean(text));
  }

  function normalizeRowRecords(records, options = {}) {
    const sorted = (Array.isArray(records) ? records : [])
      .filter(record => record && Array.isArray(record.cells))
      .sort((left, right) => number(left.order) - number(right.order));
    const headers = [];
    for (const record of sorted) {
      const profile = buildHeaderProfile(record);
      if (profile) headers.push(profile);
    }

    let currentProfile = null;
    const expectedLeague = leagueRegistry.ids.includes(options.expectedLeague) ? options.expectedLeague : 'MLB';
    let insideStandardLeague = false;
    let sawLeagueMarker = false;
    let pendingAway = null;
    let expectedGameCount = null;
    const games = [];
    let candidateRows = 0;
    let pairedRows = 0;
    let singleRows = 0;

    for (const record of sorted) {
      const profile = buildHeaderProfile(record);
      if (profile) {
        currentProfile = profile;
        pendingAway = null;
        continue;
      }

      if (isLeagueMarker(record.text)) {
        sawLeagueMarker = true;
        insideStandardLeague = isStandardLeagueRow(record.text, expectedLeague);
        if (insideStandardLeague) {
          const count = clean(record.text).match(/[（(]\s*(\d{1,2})\s*[）)]/);
          if (count) expectedGameCount = Math.max(Number(expectedGameCount || 0), Number(count[1]));
        }
        pendingAway = null;
        continue;
      }

      if (!currentProfile) {
        currentProfile = [...headers].reverse().find(item => item.order <= number(record.order)) || headers[0] || null;
      }
      if (!currentProfile) continue;
      const permitted = sawLeagueMarker ? insideStandardLeague : options.documentLooksStandardLeague === true || options.documentLooksStandardMlb === true;
      if (!permitted) continue;

      const mapped = mapRecord(record, currentProfile);
      const teams = teamRows(mapped);
      if (!teams.length) continue;
      candidateRows += 1;

      if (teams.length >= 2) {
        const game = buildFromSingle(mapped, teams);
        if (game) {
          games.push(game);
          singleRows += 1;
        }
        pendingAway = null;
        continue;
      }

      const one = teams[0];
      if (!one.homeMarked) {
        const awayTime = clean(mapped.mapped.time?.text);
        pendingAway = /^\d{1,2}-\d{1,2}$/.test(awayTime) ? mapped : null;
        continue;
      }
      if (!pendingAway) continue;
      const gap = Math.abs(number(mapped.top) - number(pendingAway.top));
      if (gap > 120) {
        pendingAway = null;
        continue;
      }
      const game = buildFromSplit(pendingAway, mapped);
      if (game) {
        games.push(game);
        pairedRows += 1;
      }
      pendingAway = null;
    }

    const unique = [];
    const seen = new Map();
    const conflictingGameKeys = [];
    for (const game of games) {
      const timeText = game.cells[0]?.pair?.join('|') || '';
      const key = `${game.awayCode}|${game.homeCode}|${timeText}`;
      const fingerprint = JSON.stringify({
        cells: game.cells.map(cell => cell?.pair || []),
        marketLocked: game.marketLocked === true,
      });
      if (seen.has(key)) {
        if (seen.get(key) !== fingerprint && !conflictingGameKeys.includes(key)) conflictingGameKeys.push(key);
        continue;
      }
      seen.set(key, fingerprint);
      unique.push(game);
    }

    return {
      tables: unique.length ? [{
        headers: DEFINITIONS.map(definition => definition.label),
        rows: unique.map(game => ({ cells: game.cells, text: game.text, marketLocked: game.marketLocked === true })),
      }] : [],
      diagnostics: {
        recordCount: sorted.length,
        headerCount: headers.length,
        candidateRows,
        gameCount: unique.length,
        pairedRows,
        singleRows,
        sawLeagueMarker,
        league: expectedLeague,
        expectedGameCount,
        conflictingGameKeys,
      },
    };
  }

  globalThis.Tai888RowNormalizer = Object.freeze({
    normalizeRowRecords,
    isStandardLeagueRow,
    version: 'TAI888-SPLIT-ROW-NORMALIZER-v2.1.0',
  });
})();
