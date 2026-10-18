(() => {
  const clean = value => String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  const homeMarker = /[\[［【(（]\s*主\s*[\]］】)）]/u;
  const clock = /^(\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):([0-5]\d)\s*(?:[（(]GMT\+8[）)])?$/i;
  const marketKey = text => ({ 獨贏: 'moneyline', 独赢: 'moneyline', 讓分: 'runline', 让分: 'runline', 讓球: 'runline', 让球: 'runline', 大小: 'total', 大小盤: 'total', 大小盘: 'total' })[clean(text)] || null;

  function bands(fragments) {
    const result = [];
    for (const fragment of [...fragments].sort((a, b) => a.top - b.top || a.left - b.left)) {
      let row = result.find(value => Math.abs(value.top - fragment.top) <= 6);
      if (!row) { row = { top: fragment.top, parts: [] }; result.push(row); }
      if (!row.parts.some(value => value.text === fragment.text && Math.abs(value.left - fragment.left) <= 2)) row.parts.push(fragment);
    }
    return result.map(row => ({ top: row.top, parts: row.parts.sort((a, b) => a.left - b.left), text: clean(row.parts.map(value => value.text).join(' ')) }));
  }

  function quotePair(fragments) {
    const rows = bands(fragments).map(row => row.text).filter(Boolean);
    if (rows.length === 2 && rows.every(row => /^[-－—]$/.test(row))) return rows;
    const pair = []; let buffer = [];
    for (const row of rows) {
      buffer.push(row);
      if (/(?:^|\s)[0-3]\.\d{2,3}$/.test(row)) { pair.push(clean(buffer.join(' '))); buffer = []; }
    }
    // No missing quote, third quote, or leftover line may be silently guessed.
    return pair.length === 2 && !buffer.length ? pair : null;
  }

  function normalize(sections) {
    const rows = []; const issues = []; let expected = 0; let label = '';
    for (const section of (Array.isArray(sections) ? sections : []).slice(0, 12)) {
      if (!globalThis.Tai888LeagueRegistry?.standardMarker(section?.label, 'NHL')) continue;
      const fragments = (Array.isArray(section.fragments) ? section.fragments : []).filter(value => clean(value?.text)
        && Number.isFinite(value.top) && Number.isFinite(value.left)).map(value => ({ text: clean(value.text), top: value.top, left: value.left }));
      if (!fragments.length || fragments.length > 1200) continue;
      // A bounded section must not cross into any other league/period board.
      const otherHeading = fragments.some(value => /^(?:(?:聯盟|联盟)\s*[:：]?|(?:NHL|KHL|AHL|SHL|DEL|NBA|MLB|NPB|KBO|CPBL)(?:國家|国家|美式|俄羅斯|俄罗斯|冰球))/i.test(value.text)
        && value.text !== clean(section.label) && !(clean(section.label).includes(value.text) && globalThis.Tai888LeagueRegistry.identify(value.text) === 'NHL'));
      if (otherHeading) { issues.push('NHL_CARD_MIXED_SECTION'); continue; }
      const allBands = bands(fragments);
      const dates = allBands.map(row => ({ ...row, match: row.text.replace(/\s*[（(]更多玩法[）)]\s*[>›]?$/, '').match(clock) })).filter(row => row.match);
      if (!dates.length) continue;
      label ||= clean(section.label);
      expected += Number(clean(section.label).match(/[（(](\d{1,2})[）)]$/)?.[1] || dates.length);
      for (let index = 0; index < dates.length; index += 1) {
        const date = dates[index]; const end = dates[index + 1]?.top ?? Infinity;
        const contents = fragments.filter(value => value.top > date.top + 6 && value.top < end - 6);
        const headerGroups = allBands.filter(row => row.top < end && row.parts.some(value => marketKey(value.text)))
          .map(row => ({ ...row, columns: row.parts.filter(value => marketKey(value.text)).map(value => ({ ...value, key: marketKey(value.text) })) }))
          .filter(row => row.columns.some(value => value.key === 'runline') && row.columns.some(value => value.key === 'total'));
        const header = headerGroups.filter(row => row.top <= date.top).at(-1) || headerGroups.find(row => row.top > date.top);
        if (!header || new Set(header.columns.map(value => value.key)).size !== header.columns.length) { issues.push('NHL_CARD_HEADERS_MISSING'); continue; }
        const columns = header.columns.sort((a, b) => a.left - b.left);
        if (columns.length < 2) continue;
        const firstBoundary = columns[0].left - (columns[1].left - columns[0].left) / 2;
        const teams = bands(contents.filter(value => value.left < firstBoundary)).map(row => ({ ...row, team: globalThis.Tai888NhlTeams?.resolve(row.text) })).filter(row => row.team);
        if (teams.length !== 2 || teams[0].team.code === teams[1].team.code || teams.filter(row => homeMarker.test(row.text)).length !== 1) { issues.push('NHL_CARD_TEAM_IDENTITY_INVALID'); continue; }
        const homeIndex = homeMarker.test(teams[0].text) ? 0 : 1; const awayIndex = 1 - homeIndex;
        const evidence = []; let invalid = false;
        for (let col = 0; col < columns.length; col += 1) {
          const column = columns[col];
          const left = col ? (columns[col - 1].left + column.left) / 2 : firstBoundary;
          const right = columns[col + 1] ? (column.left + columns[col + 1].left) / 2 : Infinity;
          const parts = contents.filter(value => value.left >= left && value.left < right && !marketKey(value.text) && !/更多玩法/.test(value.text));
          const pair = quotePair(parts);
          if (!pair) { invalid = true; break; }
          evidence.push({ key: column.key, label: column.text, pair: column.key === 'total' ? pair : [pair[awayIndex], pair[homeIndex]] });
        }
        if (invalid) { issues.push('NHL_CARD_QUOTES_AMBIGUOUS'); continue; }
        const pairCell = pair => ({ pair, lines: pair.filter(Boolean) });
        const cell = key => pairCell(evidence.find(value => value.key === key)?.pair || ['', '']);
        const [, month, day, hour, minute] = date.match;
        if (+month < 1 || +month > 12 || +day < 1 || +day > 31 || +hour > 23) { issues.push('NHL_CARD_DATE_INVALID'); continue; }
        const away = teams[awayIndex]; const home = teams[homeIndex];
        rows.push({ cells: [pairCell([`${month}-${day}`, `${hour.padStart(2, '0')}:${minute}`]),
          pairCell([`${away.team.code}-${away.text}`, `${home.team.code}-${home.text}`]), cell('runline'), cell('total'), cell('moneyline')],
          // Only the identified event/market evidence can leave the page.
          // Never forward unrelated text sharing the same vertical card band.
          text: clean(`${date.text.replace(/\s*[（(]更多玩法[）)]\s*[>›]?$/, '')} ${away.text} ${home.text} ${evidence.map(value => `${value.label} ${value.pair.join(' | ')}`).join(' ')}`).slice(0, 2000),
          teamEvidence: [away.text, home.text], marketEvidence: evidence, marketLocked: false });
      }
    }
    return { tables: rows.length ? [{ headers: ['時間', '主客隊伍', '讓分', '大小盤', '獨贏'], rows }] : [],
      diagnostics: { league: 'NHL', layout: 'NHL_RESPONSIVE_CARDS', gameCount: rows.length, expectedGameCount: expected || null,
        sawLeagueMarker: Boolean(label), pageLeagueLabel: label, cardIssues: [...new Set(issues)], conflictingGameKeys: [], sectionCount: label ? 1 : 0 } };
  }
  globalThis.Tai888NhlCardNormalizer = Object.freeze({ normalize });
})();
