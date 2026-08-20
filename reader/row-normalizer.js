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

  const TEAM_CODE = /(?:^|\s)([A-Z][A-Z0-9]{0,11})\s*-/g;
  const TEAM_NAME_ALIASES = Object.freeze({
    NPB: Object.freeze([
      ['YOM', ['讀賣巨人', '读卖巨人', '巨人']], ['HAN', ['阪神虎', '阪神']],
      ['YDB', ['橫濱DeNA海星', '横滨DeNA海星', '橫濱DeNA灣星', '横滨DeNA湾星', '橫濱海星', '横滨海星', '橫濱灣星', '横滨湾星']],
      ['HIR', ['廣島東洋鯉魚', '广岛东洋鲤鱼', '廣島鯉魚', '广岛鲤鱼']],
      ['YAK', ['養樂多燕子', '养乐多燕子', '養樂多', '养乐多']], ['CHU', ['中日龍', '中日龙']],
      ['SOF', ['軟銀鷹', '软银鹰', '福岡軟銀鷹', '福冈软银鹰']],
      ['NIP', ['日本火腿鬥士', '日本火腿斗士', '日本火腿']],
      ['LOM', ['羅德海洋', '罗德海洋', '千葉羅德', '千叶罗德']],
      ['RAK', ['樂天金鷲', '乐天金鹫', '東北樂天', '东北乐天']],
      ['ORI', ['歐力士猛牛', '欧力士猛牛', '歐力士', '欧力士']], ['SEI', ['西武獅', '西武狮']],
    ]),
    KBO: Object.freeze([
      ['KIA', ['起亞老虎', '起亚老虎', '起亞虎', '起亚虎']], ['SAM', ['三星獅子', '三星狮子', '三星獅', '三星狮']],
      ['LGT', ['LG雙子', 'LG双子', '雙子', '双子']], ['DOO', ['斗山熊']],
      ['KTW', ['KT巫師', 'KT巫师', '巫師', '巫师']], ['SSG', ['SSG登陸者', 'SSG登陆者', '登陸者', '登陆者']],
      ['LOG', ['樂天巨人', '乐天巨人']], ['HAN', ['韓華鷹', '韩华鹰']],
      ['NCD', ['NC恐龍', 'NC恐龙', '恐龍', '恐龙']], ['KIW', ['培證英雄', '培证英雄', 'Kiwoom英雄', '英雄']],
    ]),
    CPBL: Object.freeze([
      ['CTB', ['中信兄弟', '兄弟象']], ['UNI', ['統一7-ELEVEn獅', '统一7-ELEVEn狮', '統一獅', '统一狮']],
      ['RKM', ['樂天桃猿', '乐天桃猿']], ['FUB', ['富邦悍將', '富邦悍将']],
      ['WCD', ['味全龍', '味全龙']], ['TSG', ['台鋼雄鷹', '台钢雄鹰']],
    ]),
  });
  const leagueRegistry = globalThis.Tai888LeagueRegistry || Object.freeze({
    ids: ['MLB'],
    identify: text => /(?:聯盟|联盟)\s*[:：]?\s*MLB\s*(?:美國職棒|美国职棒)/i.test(String(text || ''))
      && !/(?:走地|滾球|滚球|即時|即时|LIVE|IN[ -]?PLAY|總得分|总得分|主隊|主队|客隊|客队|單隊|单队|特殊)/i.test(String(text || '')) ? 'MLB' : null,
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
    if (!columns.time || !columns.teams) return null;
    const marketKeys = ['runline', 'total', 'first5Runline', 'first5Total'];
    if (!marketKeys.some(key => columns[key])) return null;
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

  function namedTeamMatches(text, league) {
    const value = clean(text);
    const matches = [];
    for (const [code, aliases] of TEAM_NAME_ALIASES[league] || []) {
      let best = null;
      for (const alias of aliases) {
        const index = value.indexOf(alias);
        if (index < 0) continue;
        if (!best || index < best.index || (index === best.index && alias.length > best.alias.length)) best = { code, alias, index };
      }
      if (best) matches.push(best);
    }
    return matches.sort((left, right) => left.index - right.index || right.alias.length - left.alias.length);
  }

  function teamRows(mappedRow, expectedLeague = '') {
    const sourceRows = mappedRow?.mapped?.teams?.rows?.length
      ? mappedRow.mapped.teams.rows
      : (mappedRow?.mapped?.teams?.lines || []).map((text, index) => ({ text, top: index * 20 }));
    const found = new Map();
    for (const row of sourceRows) {
      const rowText = clean(row.text);
      const matches = [...rowText.matchAll(TEAM_CODE)];
      for (const [matchIndex, match] of matches.entries()) {
        const code = match[1].toUpperCase();
        const nextIndex = matches[matchIndex + 1]?.index ?? rowText.length;
        const teamText = clean(rowText.slice(match.index, nextIndex));
        const candidate = {
          code,
          text: teamText,
          top: number(row.top),
          homeMarked: HOME_MARKER.test(teamText),
        };
        const previous = found.get(code);
        if (!previous || candidate.homeMarked || candidate.text.length > previous.text.length) {
          found.set(code, candidate);
        }
      }
      if (!matches.length) {
        const named = namedTeamMatches(rowText, expectedLeague);
        for (const [matchIndex, match] of named.entries()) {
          const nextIndex = named[matchIndex + 1]?.index ?? rowText.length;
          const teamText = clean(rowText.slice(match.index, nextIndex));
          const candidate = { code: match.code, text: teamText, top: number(row.top), homeMarked: HOME_MARKER.test(teamText) };
          const previous = found.get(match.code);
          if (!previous || candidate.homeMarked || candidate.text.length > previous.text.length) found.set(match.code, candidate);
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

  function codedTeamText(team) {
    const value = clean(team?.text);
    return /(?:^|\s)[A-Z][A-Z0-9]{0,11}\s*-/.test(value) ? value : `${team?.code || ''}-${value}`;
  }

  function valueNear(cell, targetTop, fallbackIndex = 0) {
    const rows = Array.isArray(cell?.rows) ? cell.rows : [];
    if (rows.length && Number.isFinite(Number(targetTop))) {
      const nearest = [...rows].sort((left, right) => Math.abs(number(left.top) - targetTop) - Math.abs(number(right.top) - targetTop))[0];
      if (nearest && Math.abs(number(nearest.top) - targetTop) <= 14) return clean(nearest.text);
    }
    return clean(cell?.lines?.[fallbackIndex] || '');
  }

  function pairedValues(cell, away, home, awayIndex, homeIndex) {
    const rows = (Array.isArray(cell?.rows) ? cell.rows : [])
      .map((row, index) => ({ text: clean(row?.text), top: number(row?.top), index }))
      .filter(row => row.text)
      .sort((left, right) => left.top - right.top || left.index - right.index);

    // Some Tai888 responsive layouts report both team labels at effectively
    // the same Y coordinate.  Calling valueNear twice then selects the same
    // odds row for both sides, which makes every market look empty/locked.
    // When two visual rows exist, assign two distinct rows together instead
    // of resolving each side independently.
    const sameTeamBand = Math.abs(number(away?.top) - number(home?.top)) <= 6;
    if (rows.length === 1 && sameTeamBand) {
      // Preserve the combined visual market row only once.  The parser can
      // then split its two direction/water groups deterministically.
      return [clean(rows[0].text), ''];
    }
    if (rows.length >= 2) {
      if (sameTeamBand) {
        return [
          clean(rows[Math.min(awayIndex, rows.length - 1)]?.text),
          clean(rows[Math.min(homeIndex, rows.length - 1)]?.text),
        ];
      }

      let best = null;
      for (let awayRow = 0; awayRow < rows.length; awayRow += 1) {
        for (let homeRow = 0; homeRow < rows.length; homeRow += 1) {
          if (awayRow === homeRow) continue;
          const score = Math.abs(rows[awayRow].top - number(away?.top))
            + Math.abs(rows[homeRow].top - number(home?.top));
          if (!best || score < best.score) best = { awayRow, homeRow, score };
        }
      }
      if (best && best.score <= 56) {
        return [clean(rows[best.awayRow].text), clean(rows[best.homeRow].text)];
      }
    }

    return [
      valueNear(cell, away?.top, awayIndex),
      valueNear(cell, home?.top, homeIndex),
    ];
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
      const [awayValue, homeValue] = pairedValues(cell, away, home, awayIndex, homeIndex);
      return pairedCell(awayValue, homeValue);
    });
    cells[1] = pairedCell(codedTeamText(away), codedTeamText(home));
    return { cells, text: mappedRow.rawText, awayCode: away.code, homeCode: home.code, marketLocked: mappedRow.marketLocked };
  }

  function buildFromSplit(awayRow, homeRow, expectedLeague = '') {
    const awayTeams = teamRows(awayRow, expectedLeague);
    const homeTeams = teamRows(homeRow, expectedLeague);
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
    cells[1] = pairedCell(codedTeamText(away), codedTeamText(home));
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

  function partitionLeagueSections(sorted) {
    const sections = [];
    let current = null;
    let latestHeader = null;
    for (const record of sorted) {
      const profile = buildHeaderProfile(record);
      if (profile) latestHeader = record;
      if (isLeagueMarker(record.text)) {
        const league = leagueRegistry.identify?.(clean(record.text));
        current = league ? { league, records: latestHeader ? [latestHeader, record] : [record] } : null;
        if (current) sections.push(current);
        continue;
      }
      if (current && record !== latestHeader) current.records.push(record);
    }
    return sections;
  }

  function normalizeSection(sorted, expectedLeague, options = {}) {

    const originalRecordCount = number(options.originalRecordCount, sorted.length);
    const headers = [];
    for (const record of sorted) {
      const profile = buildHeaderProfile(record);
      if (profile) headers.push(profile);
    }

    let currentProfile = null;
    const sawLeagueMarker = true;
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
        if (isStandardLeagueRow(record.text, expectedLeague)) {
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
      const mapped = mapRecord(record, currentProfile);
      const teams = teamRows(mapped, expectedLeague);
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
      const game = buildFromSplit(pendingAway, mapped, expectedLeague);
      if (game) {
        games.push(game);
        pairedRows += 1;
      }
      pendingAway = null;
    }

    const unique = [];
    const seen = new Map();
    const conflictingGameKeys = [];
    const marketRichness = game => [2, 3, 6, 7].reduce((score, index) => {
      const pair = Array.isArray(game?.cells?.[index]?.pair) ? game.cells[index].pair : [];
      return score + pair.filter(value => clean(value)).length;
    }, 0);
    for (const game of games) {
      const timeText = game.cells[0]?.pair?.join('|') || '';
      const key = `${game.awayCode}|${game.homeCode}|${timeText}`;
      const fingerprint = JSON.stringify({
        cells: game.cells.map(cell => cell?.pair || []),
        marketLocked: game.marketLocked === true,
      });
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

    return {
      tables: unique.length ? [{
        headers: DEFINITIONS.map(definition => definition.label),
        rows: unique.map(game => ({ cells: game.cells, text: game.text, marketLocked: game.marketLocked === true })),
      }] : [],
      diagnostics: {
        recordCount: originalRecordCount,
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

  function normalizeRowRecords(records, options = {}) {
    const sorted = (Array.isArray(records) ? records : [])
      .filter(record => record && Array.isArray(record.cells))
      .sort((left, right) => number(left.order) - number(right.order));
    const expectedLeague = leagueRegistry.ids.includes(options.expectedLeague) ? options.expectedLeague : '';
    const sections = partitionLeagueSections(sorted).filter(section => !expectedLeague || section.league === expectedLeague);
    if (!sections.length) {
      return { tables: [], diagnostics: { recordCount: sorted.length, headerCount: 0, candidateRows: 0, gameCount: 0, pairedRows: 0, singleRows: 0, sawLeagueMarker: false, league: expectedLeague, expectedGameCount: null, conflictingGameKeys: [], sectionCount: 0 } };
    }
    const normalized = sections.map(section => normalizeSection(section.records, section.league, { originalRecordCount: sorted.length }));
    const games = normalized.flatMap(value => value.tables?.[0]?.rows || []);
    const conflicts = normalized.flatMap(value => value.diagnostics?.conflictingGameKeys || []);
    const expectedGameCount = normalized.reduce((count, value) => Math.max(count, number(value.diagnostics?.expectedGameCount)), 0) || null;
    return {
      tables: games.length ? [{ headers: DEFINITIONS.map(definition => definition.label), rows: games }] : [],
      diagnostics: {
        recordCount: sorted.length,
        headerCount: normalized.reduce((count, value) => count + number(value.diagnostics?.headerCount), 0),
        candidateRows: normalized.reduce((count, value) => count + number(value.diagnostics?.candidateRows), 0),
        gameCount: games.length,
        pairedRows: normalized.reduce((count, value) => count + number(value.diagnostics?.pairedRows), 0),
        singleRows: normalized.reduce((count, value) => count + number(value.diagnostics?.singleRows), 0),
        sawLeagueMarker: true,
        league: expectedLeague || sections[0].league,
        expectedGameCount,
        conflictingGameKeys: [...new Set(conflicts)],
        sectionCount: sections.length,
      },
    };
  }

  globalThis.Tai888RowNormalizer = Object.freeze({
    normalizeRowRecords,
    isStandardLeagueRow,
    partitionLeagueSections,
    version: 'TAI888-SPLIT-ROW-NORMALIZER-v2.2.0',
  });
})();
