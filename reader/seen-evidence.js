(() => {
  const REASONS = new Set(['PRE_NORMALIZATION', 'MUTATION', 'SCAN', 'BEFORE_SELECTION', 'SOURCE_PARTIAL']);
  const privateText = /(?:password|passwd|cookie|session|secret|authorization|bearer|account|balance|username|user[ _-]?id|private[ _-]?key|\bmember\b|\bcredit\b|帳號|账号|帳戶|账户|餘額|余额|額度|额度|登入|登录|密碼|密码|會員|会员|用戶名|用户名|(?:^|[^a-z])token(?:[^a-z]|$)|https?:|[<>=@\\]|[A-Za-z0-9_-]{40,})/i;
  function isPrivate(value) {
    if (typeof value !== 'string') return false;
    let result = value.normalize('NFKC').replace(/\p{Cf}/gu, '');
    try {
      for (let count = 0; count < 4 && /%[a-f0-9]{2}/i.test(result); count += 1) result = decodeURIComponent(result).normalize('NFKC').replace(/\p{Cf}/gu, '');
    } catch { return true; }
    return /%[a-f0-9]{2}/i.test(result) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || privateText.test(result);
  }
  const clean = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
  const compact = value => clean(value).replace(/\s+/g, '');
  const parts = cell => Array.isArray(cell?.pair) ? cell.pair : Array.isArray(cell?.lines) ? cell.lines
    : Array.isArray(cell?.rows) ? cell.rows.map(row => row?.text) : [cell?.text];
  const cellText = cell => parts(cell).map(clean).filter(Boolean).join(' ');
  const rawCellText = cell => typeof cell?.text === 'string' ? cell.text : parts(cell).filter(value => typeof value === 'string').join('\n');
  const recordText = row => clean(row?.text) || (row?.cells || []).map(cellText).filter(Boolean).join(' ');
  function headingLeague(row) {
    const text = recordText(row);
    if (!text || isPrivate(text) || /\d{1,2}[/-]\d{1,2}|\d{1,2}:\d{2}|\d+\.\d|[\[［【(（]\s*主\s*[\]］】)）]/u.test(text)) return '';
    return globalThis.Tai888LeagueRegistry?.identify(text) || '';
  }
  function sportsHeader(row) {
    const labels = (row?.cells || []).map(cell => compact(cellText(cell)));
    return labels.some(text => /^(?:時間|时间|開賽時間|开赛时间)$/.test(text))
      && labels.some(text => /^(?:主客隊伍|主客队伍|隊伍|队伍)$/.test(text))
      && labels.some(text => /讓球|让球|讓分|让分|大小|獨贏|独赢/.test(text));
  }
  function bounds(row) {
    const cells = (row?.cells || []).filter(cell => Number.isFinite(cell?.left) && Number.isFinite(cell?.right));
    return { left: cells.length ? Math.min(...cells.map(cell => cell.left)) : Number(row?.left),
      right: cells.length ? Math.max(...cells.map(cell => cell.right)) : Number(row?.right) };
  }
  function overlaps(left, right) {
    return Number.isFinite(left.left) && Number.isFinite(left.right) && Number.isFinite(right.left) && Number.isFinite(right.right)
      ? Math.min(left.right, right.right) - Math.max(left.left, right.left) > 0 : true;
  }
  function inside(row, lane) {
    const box = bounds(row);
    return Number.isFinite(box.left) && Number.isFinite(box.right) && Number.isFinite(lane.left) && Number.isFinite(lane.right)
      ? box.left >= lane.left - 2 && box.right <= lane.right + 2 : true;
  }
  function source(meta) {
    try {
      const url = new URL(meta.pageUrl), host = String(meta.sourceHost || '').toLowerCase();
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hostname !== host
        || host !== 'tai888.in' && !host.endsWith('.tai888.in')) return null;
      const marker = /^#\/(?:BS|BB|FT)(?:$|[/?&])/i.test(url.hash) ? url.hash.match(/^#\/(?:BS|BB|FT)/i)[0] : '';
      const result = { sourceHost: host, pageUrl: `${url.origin}${url.pathname}${marker}` };
      if (meta.frameUrl) {
        const frame = new URL(meta.frameUrl);
        if (frame.protocol === 'https:' && (frame.hostname === 'tai888.in' || frame.hostname.endsWith('.tai888.in'))
          && !frame.username && !frame.password && !frame.port) {
          const hint = /^#\/(?:BS|BB|FT)(?:$|[/?&])/i.test(frame.hash) ? frame.hash.match(/^#\/(?:BS|BB|FT)/i)[0] : '';
          result.frameUrl = `${frame.origin}${frame.pathname}${hint}`;
        }
      }
      return result;
    } catch { return null; }
  }
  function evidence(league, tables, meta, partial) {
    const safeSource = source(meta);
    if (!safeSource) throw Object.assign(new Error('SEEN_SOURCE_INVALID'), { code: 'SEEN_SOURCE_INVALID' });
    if (!league || !tables.length) return null;
    const reasons = [...new Set(['PRE_NORMALIZATION', ...(meta.captureReasons || []).filter(reason => REASONS.has(reason)),
      ...(partial || meta.completeCapture !== true ? ['SOURCE_PARTIAL'] : [])])];
    return { version: 'TAI888-DOM-CAPTURE-v2.2.0', league, readerVersion: meta.readerVersion, observedAt: meta.observedAt,
      ...(meta.pageActivityAt ? { pageActivityAt: meta.pageActivityAt } : {}), ...safeSource,
      captureReasons: reasons, completeCapture: !partial && meta.completeCapture === true, tables };
  }
  function safeRow(row) {
    const cells = Array.isArray(row?.cells) ? row.cells : [];
    // A private label contaminates its whole row: keeping the adjacent numeric
    // cell could otherwise retain an account balance after its label is redacted.
    const privateRow = isPrivate(recordText(row)) || cells.some(cell => parts(cell).some(isPrivate));
    return { partial: privateRow, row: { marketLocked: row?.marketLocked === true,
      cells: cells.map(cell => ({ pair: parts(cell).map(value => privateRow || typeof value !== 'string' ? '' : value) })) } };
  }
  function collect(records, meta = {}) {
    const lanes = [], pending = [], outputs = new Map();
    const ordered = (Array.isArray(records) ? records : []).map((row, index) => ({ row, index }))
      .sort((a, b) => Number(a.row.top || 0) - Number(b.row.top || 0) || Number(a.row.left || 0) - Number(b.row.left || 0) || a.index - b.index);
    const output = league => {
      if (!outputs.has(league)) outputs.set(league, { tables: [], partial: false });
      return outputs.get(league);
    };
    for (const { row } of ordered) {
      const league = headingLeague(row), box = bounds(row);
      if (league) {
        const label = recordText(row), targets = lanes.filter(lane => overlaps(box, lane));
        pending.push({ league, label, ...box });
        for (const lane of targets) {
          lane.league = league; lane.table = { sectionTitle: label, headers: [...lane.headers], rows: [] };
          output(league).tables.push(lane.table);
        }
        if (!targets.length) {
          const lane = { ...box, headers: [], league, table: { sectionTitle: label, headers: [], rows: [] } };
          lanes.push(lane); output(league).tables.push(lane.table); output(league).partial = true;
        }
        continue;
      }
      if (sportsHeader(row)) {
        const last = [...pending].reverse().find(item => overlaps(box, item));
        const lane = { ...box, headers: row.cells.map(rawCellText), league: last?.league || '', table: null };
        if (lane.league) {
          lane.table = { sectionTitle: last.label, headers: [...lane.headers], rows: [] };
          output(lane.league).tables.push(lane.table);
        }
        lanes.push(lane);
        continue;
      }
      // An explicit foreign/unidentified league boundary closes the previous
      // lane instead of attributing its rows to the preceding known league.
      if (/^(?:聯盟|联盟)\s*[:：]?/.test(recordText(row))) {
        for (const lane of lanes.filter(item => overlaps(box, item))) { lane.league = ''; lane.table = null; }
        continue;
      }
      const target = [...lanes].reverse().find(lane => lane.league && lane.table && inside(row, lane));
      if (!target) continue;
      const cells = Array.isArray(row.cells) ? row.cells : [];
      if (!cells.length) continue;
      const text = recordText(row);
      if (/(?:每\s*60\s*秒更新|更新倒數|更新倒计时)/i.test(text)) continue;
      const safe = safeRow(row);
      output(target.league).partial ||= safe.partial;
      target.table.rows.push(safe.row);
    }
    // A heading without a usable layout is still captured as partial source
    // evidence; an empty parse can never erase the visible sport heading.
    for (const item of pending) if (!output(item.league).tables.length) {
      output(item.league).tables.push({ sectionTitle: item.label, headers: [], rows: [] });
      output(item.league).partial = true;
    }
    return [...outputs].map(([league, value]) => evidence(league, value.tables, meta, value.partial)).filter(Boolean);
  }
  function collectSections(sections, league, meta = {}) {
    const tables = [];
    let partial = false;
    for (const section of Array.isArray(sections) ? sections : []) {
      if (headingLeague({ text: section?.label }) !== league) continue;
      const rows = [];
      const fragments = Array.isArray(section.fragments) ? section.fragments : [];
      const privateSection = fragments.some(fragment => isPrivate(fragment?.text));
      for (const fragment of fragments) {
        const raw = safeRow({ cells: [{ pair: [privateSection ? '' : fragment?.text] }] });
        partial ||= raw.partial; rows.push(raw.row);
      }
      tables.push({ sectionTitle: clean(section.label), headers: [], rows });
      partial ||= privateSection;
    }
    // Geometry/card fragments alone never establish whole-source completeness.
    return evidence(league, tables, meta, true);
  }
  globalThis.Tai888SeenEvidence = Object.freeze({ collect, collectSections, headingLeague, sportsHeader, recordText,
    version: 'TAI888-SEEN-EVIDENCE-v1' });
})();
