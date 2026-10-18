(() => {
  if (globalThis.__TAI888_READER_CAPTURE_V209__) return;
  globalThis.__TAI888_READER_CAPTURE_V209__ = true;

  const policy = globalThis.Tai888CapturePolicy;
  const normalizer = globalThis.Tai888RowNormalizer;
  if (!policy?.shouldKeepRecord || !normalizer?.normalizeRowRecords) return;
  const clean = policy.clean;
  const READER_VERSION = '2.1.37';
  function notifyBackground(message) {
    // An extension update can invalidate this context and throw synchronously.
    try {
      if (!chrome.runtime?.id) return;
      Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
    } catch {}
  }
  // This timestamp is deliberately independent from capture().observedAt.
  // A capture request must not make a frozen page look newly active.
  const activityByLeague = Object.fromEntries((globalThis.Tai888LeagueRegistry?.ids || []).map(league => [league, 0]));
  const fingerprintByLeague = {};
  let sectionDiagnostics = [];
  let soccerLayouts = [];

  // Never read or forward the full document URL.  The Reader only needs a
  // route hint, so retain the Tai888 origin/pathname and one fixed board marker.
  // Query strings and every other hash fragment are deliberately discarded.
  function currentTai888PageUrl() {
    try {
      const host = String(document.location.hostname || '').toLowerCase();
      if (document.location.protocol !== 'https:'
        || (host !== 'tai888.in' && !host.endsWith('.tai888.in'))) return '';
      const marker = /^#\/BS(?:$|[/?&])/i.test(document.location.hash || '') ? '#/BS' : '';
      return `${document.location.origin}${document.location.pathname || '/'}${marker}`.slice(0, 500);
    } catch {
      return '';
    }
  }

  function tai888SourceHost() {
    const candidates = [location.hostname];
    try {
      candidates.push(...Array.from(document.location.ancestorOrigins || []).map(origin => new URL(origin).hostname));
    } catch {}
    try { candidates.push(new URL(document.referrer || '').hostname); } catch {}
    return candidates.find(host => host === 'tai888.in' || host?.endsWith('.tai888.in')) || '';
  }

  function visible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 1 && rectangle.height > 1;
  }

  function openRoots() {
    const roots = [document];
    const queued = [document];
    const seen = new Set(roots);
    while (queued.length && roots.length < 32) {
      const root = queued.shift();
      let elements = [];
      try { elements = [...root.querySelectorAll('*')]; } catch {}
      for (const element of elements) {
        const shadow = element.shadowRoot;
        if (!shadow || seen.has(shadow)) continue;
        seen.add(shadow);
        roots.push(shadow);
        queued.push(shadow);
        if (roots.length >= 32) break;
      }
    }
    return roots;
  }

  function queryAcrossRoots(roots, selector) {
    const result = [];
    const seen = new Set();
    for (const root of roots) {
      let rows = [];
      try { rows = [...root.querySelectorAll(selector)]; } catch {}
      for (const row of rows) {
        if (seen.has(row)) continue;
        seen.add(row);
        result.push(row);
      }
    }
    return result;
  }

  function textRows(element, { fragmentsOnly = false, limit = 24 } = {}) {
    const fragments = [];
    const owner = element.ownerDocument || document;
    const walker = owner.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        const value = clean(node.nodeValue || '');
        if (!parent || !value || !visible(parent)) return NodeFilter.FILTER_REJECT;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/i.test(parent.tagName)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = clean(node.nodeValue || '');
      if (!value) continue;
      const range = owner.createRange();
      range.selectNodeContents(node);
      const rectangles = [...range.getClientRects()].filter(rectangle => rectangle.width > 0 && rectangle.height > 0);
      if (!rectangles.length) continue;
      for (const rectangle of rectangles.slice(0, 4)) {
        fragments.push({ text: value, top: rectangle.top, left: rectangle.left });
      }
    }

    if (!fragments.length) {
      const rectangle = element.getBoundingClientRect();
      return clean(element.innerText || element.textContent || '')
        .split(/\r?\n/)
        .map(clean)
        .filter(Boolean)
        .slice(0, limit)
        .map((text, index) => ({ text, top: rectangle.top + index * 18, left: rectangle.left }));
    }

    fragments.sort((left, right) => left.top - right.top || left.left - right.left);
    if (fragmentsOnly) return fragments.slice(0, limit);
    const rows = [];
    for (const fragment of fragments) {
      let row = rows.find(item => Math.abs(item.top - fragment.top) <= 6);
      if (!row) {
        row = { top: fragment.top, parts: [] };
        rows.push(row);
      }
      const duplicate = row.parts.some(part => part.text === fragment.text && Math.abs(part.left - fragment.left) <= 2);
      if (!duplicate) row.parts.push(fragment);
    }
    return rows
      .sort((left, right) => left.top - right.top)
      .map(row => ({
        top: row.top,
        left: Math.min(...row.parts.map(part => part.left)),
        text: clean(row.parts.sort((left, right) => left.left - right.left).map(part => part.text).join(' ')),
      }))
      .filter(row => row.text)
      .slice(0, 24);
  }

  function rowCellElements(row) {
    let cells = [...row.children].filter(cell => /^(TD|TH)$/i.test(cell.tagName) && visible(cell));
    if (cells.length < 1 && row.getAttribute?.('role') === 'row') {
      cells = [...row.children].filter(cell => /^(cell|columnheader|rowheader)$/i.test(cell.getAttribute?.('role') || '') && visible(cell));
    }
    if (cells.length < 1 && /^(TR)$/i.test(row.tagName)) {
      cells = [...row.querySelectorAll('th,td')]
        .filter(cell => cell.closest('tr') === row && visible(cell));
    }
    if (cells.length < 1 && !/^(TR)$/i.test(row.tagName)) {
      cells = [...row.children]
        .filter(cell => visible(cell) && clean(cell.innerText || cell.textContent || ''));
    }
    return cells;
  }

  function cellRecord(cell) {
    const rectangle = cell.getBoundingClientRect();
    const rows = textRows(cell);
    return {
      text: clean(rows.map(row => row.text).join(' ')),
      lines: rows.map(row => row.text),
      rows,
      left: rectangle.left,
      right: rectangle.right,
      top: rectangle.top,
      bottom: rectangle.bottom,
    };
  }

  function hasExplicitMarketLock(element) {
    const text = clean(element?.innerText || element?.textContent || '');
    if (/(?:未開盤|未开盘|封盤|封盘|鎖盤|锁盘|暫停受注|暂停受注|🔒)/u.test(text)) return true;
    const selector = [
      '[class*="lock" i]', '[id*="lock" i]', '[title*="lock" i]',
      '[aria-label*="lock" i]', '[alt*="lock" i]', 'img[src*="lock" i]',
      '[title*="鎖" i]', '[title*="锁" i]', '[aria-label*="鎖" i]', '[aria-label*="锁" i]',
      '[aria-disabled="true"]', '[data-disabled="true"]',
      '[class*="disabled" i]', '[class*="closed" i]', '[class*="suspend" i]',
      '[class*="unavailable" i]', '[class*="seal" i]',
    ].join(',');
    try {
      if (element?.matches?.(selector) || element?.querySelector?.(selector)) return true;

      // Tai888 sometimes draws its padlock from an icon-font pseudo element or
      // a shared CSS sprite.  Neither form contributes textContent, title or
      // an image URL, so inspect rendered styles without reading page secrets.
      const nodes = [element, ...element.querySelectorAll('*')].slice(0, 160);
      for (const node of nodes) {
        const styles = [getComputedStyle(node), getComputedStyle(node, '::before'), getComputedStyle(node, '::after')];
        for (const style of styles) {
          const content = String(style?.content || '').replace(/^['"]|['"]$/g, '');
          const image = `${style?.backgroundImage || ''} ${style?.maskImage || ''}`;
          if (/[🔒🔐]|\\f023|\\f3c1|\\e033/i.test(content)) return true;
          if (/(?:lock|padlock|closed|suspend|seal)[^)]*\.(?:png|gif|svg|webp)/i.test(image)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  function rowRecord(element, order, { preserveSoccerCells = false } = {}) {
    if (!visible(element)) return null;
    let cells = rowCellElements(element).map(cellRecord)
      .filter(cell => cell.text && cell.right > cell.left);
    let text = clean(cells.map(cell => cell.text).join(' '));
    if (!text) text = clean(element.innerText || element.textContent || '');
    if (!policy.shouldKeepRecord(cells.length, text) && !(preserveSoccerCells && cells.length && text)) return null;

    // League markers and some SPA headers are rendered as one colspan cell or a text-only div.
    // Preserve them because they delimit standard MLB markets from team-total/special sections.
    if (!cells.length) cells = [cellRecord(element)];
    const rectangle = element.getBoundingClientRect();
    return {
      order,
      text,
      cells,
      top: rectangle.top,
      bottom: rectangle.bottom,
      left: rectangle.left,
      right: rectangle.right,
      tag: element.tagName,
      marketLocked: hasExplicitMarketLock(element),
    };
  }

  function collectCandidateElements() {
    const roots = openRoots();
    const primary = queryAcrossRoots(roots, 'tr,[role="row"]').filter(visible);
    const candidates = new Set(primary);

    // Always inspect div/li grids. The Tai888 SPA can contain unrelated table rows while
    // the actual odds board itself is rendered as a div grid, so a primary-row count gate is unsafe.
    const fallback = queryAcrossRoots(roots, 'div,li').slice(0, 7000);
    for (const element of fallback) {
      if (!visible(element) || candidates.has(element)) continue;
      const hasRowDescendant = Boolean(element.querySelector?.('tr,[role="row"]'));
      const text = clean(element.innerText || element.textContent || '');
      if (!text || text.length > 3000) continue;
      const childCount = [...element.children].filter(child => visible(child) && clean(child.innerText || child.textContent || '')).length;
      if (!policy.shouldInspectFallback({ text, childCount, hasRowDescendant })) continue;
      candidates.add(element);
    }

    return [...candidates].sort((left, right) => {
      const leftBox = left.getBoundingClientRect();
      const rightBox = right.getBoundingClientRect();
      if (Math.abs(leftBox.top - rightBox.top) > 1) return leftBox.top - rightBox.top;
      if (Math.abs(leftBox.left - rightBox.left) > 1) return leftBox.left - rightBox.left;
      try {
        const position = left.compareDocumentPosition(right);
        if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      } catch {}
      return 0;
    });
  }

  function collectRecords() {
    const elements = collectCandidateElements();
    const records = [];
    const seen = new Set();
    for (const element of elements) {
      const record = rowRecord(element, records.length);
      if (!record) continue;
      const signature = `${Math.round(record.top)}|${Math.round(record.left)}|${record.text}`;
      if (seen.has(signature)) continue;
      seen.add(signature);
      records.push({ ...record, order: records.length });
    }

    return { elements, records };
  }

  function stableMarketFingerprint(normalized, { soccer = false } = {}) {
    return JSON.stringify((normalized?.tables || []).map(table => {
      const rows=(table.rows || []).map(row => (row.cells || []).map(cell => Array.isArray(cell?.pair) ? cell.pair : cell?.lines || []));
      return soccer?{sectionTitle:table.sectionTitle||null,headers:table.headers||[],periodEvidenceTruncated:table.periodEvidenceTruncated===true,rows}:rows;
    }));
  }

  function captureNhlCards() {
    const sections = []; const seen = new Set();
    const headings = queryAcrossRoots(openRoots(), 'div,span,h1,h2,h3,h4,p,strong,button').slice(0, 7000);
    for (const heading of headings) {
      if (!visible(heading)) continue;
      const label = clean(heading.innerText || heading.textContent || '');
      if (label.length > 140 || !globalThis.Tai888LeagueRegistry.standardMarker(label, 'NHL')) continue;
      let section = heading;
      for (let depth = 0; section && depth < 8; depth += 1, section = section.parentElement) {
        if (/^(BODY|HTML)$/i.test(section.tagName)) break;
        const text = clean(section.innerText || section.textContent || '');
        if (text.length > 14000) break;
        if (!/\d{1,2}[/-]\d{1,2}\s+\d{1,2}:[0-5]\d/.test(text) || !/(?:讓分|让分|讓球|让球)/.test(text) || !/大小/.test(text)) continue;
        if (!seen.has(section)) {
          seen.add(section);
          sections.push({ label, fragments: textRows(section, { fragmentsOnly: true, limit: 1201 }) });
        }
        break;
      }
    }
    return globalThis.Tai888NhlCardNormalizer?.normalize(sections) || { tables: [], diagnostics: {} };
  }

  function latestTai888NetworkRefreshAt() {
    const now = Date.now();
    const timeOrigin = Number(performance.timeOrigin || (now - performance.now()));
    let latest = 0;
    for (const entry of performance.getEntriesByType('resource')) {
      if (!['fetch', 'xmlhttprequest'].includes(String(entry.initiatorType || '').toLowerCase())) continue;
      try {
        const url = new URL(entry.name, location.origin);
        if (url.origin !== location.origin || (url.hostname !== 'tai888.in' && !url.hostname.endsWith('.tai888.in'))) continue;
        const completedAt = Math.round(timeOrigin + Number(entry.responseEnd || entry.startTime || 0));
        if (completedAt <= now + 5000 && now - completedAt <= 120000) latest = Math.max(latest, completedAt);
      } catch {}
    }
    return latest;
  }

  function captureSoccerCards(league) {
    const sections=[], seen=new Set();
    for (const heading of queryAcrossRoots(openRoots(), 'div,span,h1,h2,h3,h4,p,strong,button').slice(0,7000)) {
      if (!visible(heading)) continue;
      const label=clean(heading.innerText||heading.textContent||'');
      if(label.length>140||!globalThis.Tai888LeagueRegistry.standardMarker(label,league))continue;
      let section=heading;
      for(let depth=0;section&&depth<8;depth++,section=section.parentElement){
        if(/^(BODY|HTML)$/i.test(section.tagName))break;
        const value=clean(section.innerText||section.textContent||'');
        if(value.length>24000)break;
        if(!/\d{1,2}[/-]\d{1,2}\s+\d{1,2}:[0-5]\d/.test(value)||!/(?:讓分|让分|讓球|让球)/.test(value)||!/大小/.test(value))continue;
        if(!seen.has(section)){seen.add(section);sections.push({label,fragments:textRows(section,{fragmentsOnly:true,limit:2401})});}break;
      }
    }
    return globalThis.Tai888SoccerCardNormalizer?.normalize(sections,league)||{tables:[],diagnostics:{}};
  }

  function collectSoccerTableRecords(elements) {
    const groups = new Map();
    for (const element of elements) {
      if (element.tagName !== 'TR' && element.getAttribute?.('role') !== 'row') continue;
      const record = rowRecord(element, 0, { preserveSoccerCells: true });
      if (!record) continue;
      const table = element.closest?.('table') || element.closest?.('[role="table"]') || element.parentElement;
      if (!groups.has(table)) groups.set(table, []);
      groups.get(table).push(record);
    }
    return [...groups.values()];
  }

  function collectSoccerGeometryRecords(elements) {
    const adapter = globalThis.Tai888SoccerTableNormalizer;
    if (!adapter?.columns || !adapter?.geometryGroups) return [];
    const records = [], seen = new Set(), owners = new Map();
    function add(element) {
      const record = rowRecord(element, 0, { preserveSoccerCells: true });
      if (!record) return;
      const signature = `${record.top}|${record.left}|${record.right}|${JSON.stringify(record.cells.map(cell => [cell.left, cell.right, cell.lines]))}`;
      if (!seen.has(signature)) { seen.add(signature); records.push(record); owners.set(record, element); }
    }
    for (const element of elements) add(element);
    const headers = records.map(record => adapter.columns(record)).filter(Boolean);
    if (!headers.length) return records;
    // Collect continuation/draw rows only inside an observed sports header's
    // horizontal span. Generic baseball record policy is deliberately unchanged.
    for (const element of queryAcrossRoots(openRoots(), 'div,li').slice(0, 7000)) {
      if (!visible(element)) continue;
      const box = element.getBoundingClientRect();
      const cells = rowCellElements(element);
      const boxes = cells.map(cell => cell.getBoundingClientRect());
      const left = boxes.length ? Math.min(...boxes.map(box => box.left)) : box.left;
      const right = boxes.length ? Math.max(...boxes.map(box => box.right)) : box.right;
      const text = clean(element.innerText || element.textContent || '');
      if (!text || text.length > 1600 || element.children.length > 24) continue;
      const plainHeading = cells.length === 1 && text.length <= 240
        && !/[\[［【(（]\s*主\s*[\]］】)）]|\d{1,2}[/-]\d{1,2}|\d{1,2}:\d{2}|\d+\.\d/.test(text);
      if (!headers.some(header => left >= header[0].left - 2 && right <= header.at(-1).right + 2
        || plainHeading && Math.abs(left - header[0].left) <= 8 && right - left >= (header.at(-1).right - header[0].left) * 0.7)) continue;
      if (element.querySelector?.('tr,[role="row"]')) continue;
      add(element);
    }
    // A desktop event is itself one complete row of nested DIV columns. Its
    // date/time and price children contain the same rendered text. Keeping
    // those descendants as extra records would start false partial matches.
    const completeRows = records.filter(record => headers.some(header => {
      const inColumn = key => record.cells.filter(cell => header.some(column => column.key === key
        && cell.left >= column.left - 2 && cell.right <= column.right + 2));
      const times = inColumn('time').flatMap(cell => cell.lines || []);
      return times.some(text => /^\d{1,2}[/-]\d{1,2}$/.test(text))
        && times.some(text => /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(text))
        && inColumn('teams').some(cell => /[\[［【(（]\s*主\s*[\]］】)）]/u.test(cell.text))
        && inColumn('runline').length && inColumn('total').length;
    }));
    return records.filter(record => !completeRows.some(parent => parent !== record
      && owners.get(parent)?.contains(owners.get(record))))
      .sort((a, b) => a.top - b.top || a.left - b.left || b.right - a.right);
  }

  function captureAll({ updateActivity = true, verifiedBoardRefreshAt = 0 } = {}) {
    const { elements, records } = collectRecords();
    const nhlCards = captureNhlCards();
    const soccerTableRecords = collectSoccerTableRecords(elements);
    const soccerGeometryRecords = collectSoccerGeometryRecords(elements);
    const geometryGroups = globalThis.Tai888SoccerTableNormalizer?.geometryGroups(soccerGeometryRecords) || [];
    soccerLayouts = [];
    // Only bounded league-heading evidence, never document/body/account text.
    sectionDiagnostics = records.filter(record => {
      const text = clean(record.text);
      return text.length <= 100 && /^(?:聯盟|联盟)\s*[:：]?/.test(text)
        && !/\d{1,2}[/-]\d{1,2}|\d{1,2}:\d{2}|\d+\.\d/.test(text);
    })
      .map(record => {
        const label = clean(record.text).slice(0, 100);
        const league = globalThis.Tai888LeagueRegistry.identify(label);
        return { league, label, accepted: Boolean(league && globalThis.Tai888LeagueRegistry.standardMarker(label, league)) };
      }).filter(item => item.league).slice(0, 24);
    const verifiedNetworkRefreshAt = latestTai888NetworkRefreshAt();
    const verifiedRefreshAt = Math.max(Number(verifiedBoardRefreshAt) || 0, verifiedNetworkRefreshAt);
    const captures = [];
    for (const league of globalThis.Tai888LeagueRegistry.ids) {
      let normalized;
      if (['EPL', 'UCL'].includes(league)) {
        const desktop = globalThis.Tai888SoccerTableNormalizer?.normalize(soccerTableRecords, league) || { tables: [], diagnostics: {} };
        const geometry = globalThis.Tai888SoccerTableNormalizer?.normalize(geometryGroups, league) || { tables: [], diagnostics: {} };
        const cards = captureSoccerCards(league);
        normalized = geometry.tables.length || geometry.diagnostics.sawLeagueMarker && geometry.diagnostics.headerCount
          ? geometry : desktop.tables.length ? desktop : cards.tables.length ? cards : desktop.diagnostics.sawLeagueMarker ? desktop : cards;
        const marker = sectionDiagnostics.find(item => item.league === league && item.accepted);
        if (!normalized.diagnostics.sawLeagueMarker && marker) {
          normalized = { tables: [], diagnostics: { ...normalized.diagnostics, league, pageLeagueLabel: marker.label,
            sawLeagueMarker: true, tableIssues: ['SOCCER_HEADING_FOUND_NO_LAYOUT'] } };
        }
        if (marker || normalized.diagnostics.sawLeagueMarker) {
          const path = value => ({ tableCount: value.tables.length, sawLeagueMarker: value.diagnostics.sawLeagueMarker === true,
            issues: value.diagnostics.tableIssues || value.diagnostics.cardIssues || [] });
          soccerLayouts.push({ league, label: marker?.label || normalized.diagnostics.pageLeagueLabel || '',
            modules: { registry: Boolean(globalThis.Tai888LeagueRegistry), table: Boolean(globalThis.Tai888SoccerTableNormalizer), card: Boolean(globalThis.Tai888SoccerCardNormalizer) },
            counts: { records: soccerGeometryRecords.length, headers: geometry.diagnostics.headerCount || 0, markers: geometry.diagnostics.markerCount || 0,
              physicalGroups: soccerTableRecords.length, geometryGroups: geometryGroups.length },
            paths: { physical: path(desktop), geometry: path(geometry), cards: path(cards) }, samples: geometry.diagnostics.samples || [] });
        }
      } else normalized = league === 'NHL' && nhlCards.tables.length ? nhlCards
        : normalizer.normalizeRowRecords(records, { expectedLeague: league });
      if (!normalized.tables.length && !normalized.diagnostics?.sawLeagueMarker) continue;
      const fingerprint = stableMarketFingerprint(normalized, { soccer: ['EPL','UCL'].includes(league) });
      if (updateActivity && fingerprint && fingerprint !== fingerprintByLeague[league]) {
        fingerprintByLeague[league] = fingerprint;
        activityByLeague[league] = Date.now();
      }
      if (fingerprint && verifiedRefreshAt > 0) {
        activityByLeague[league] = Math.max(activityByLeague[league] || 0, verifiedRefreshAt);
      }
      const activityAt = activityByLeague[league] || Date.now();
      if (!activityByLeague[league]) activityByLeague[league] = activityAt;
      captures.push({
        version: 'TAI888-DOM-CAPTURE-v2.2.0',
        league,
        ...(['NHL','EPL','UCL'].includes(league) ? { pageLeagueLabel: normalized.diagnostics.pageLeagueLabel } : {}),
        sourceHost: tai888SourceHost(),
        pageUrl: currentTai888PageUrl(),
        observedAt: new Date().toISOString(),
        frameUrl: currentTai888PageUrl(),
        activityAt: new Date(activityAt).toISOString(),
        marketHash: fingerprint,
        tables: normalized.tables,
        diagnostics: {
          ...normalized.diagnostics,
          rootCount: openRoots().length,
          candidateElementCount: elements.length,
          acceptedRecordCount: records.length,
          league,
          frameHost: location.hostname,
          sourceHost: tai888SourceHost(),
          lastMutationAt: new Date(activityAt).toISOString(),
          activityAt: new Date(activityAt).toISOString(),
          mutationAgeSeconds: Math.max(0, Math.floor((Date.now() - activityAt) / 1000)),
        },
      });
    }
    return captures;
  }

  function capture() {
    const captures = captureAll();
    return {
      version: 'TAI888-MULTI-LEAGUE-CAPTURE-v2.2.0',
      readerVersion: READER_VERSION,
      captures,
      sectionDiagnostics,
      soccerLayouts,
    };
  }

  let observerRoot = null;
  let observer = null;

  function attachObserver() {
    const root = document.documentElement;
    if (!root || (observerRoot === root && observerRoot.isConnected)) return false;
    observer?.disconnect();
    observerRoot = root;
    observer = new MutationObserver(handleMutations);
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return true;
  }

  function announceFrameReady(reason) {
    attachObserver();
    notifyBackground({ type: 'TAI888_FRAME_READY', reason });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'TAI888_READER_PING') {
      sendResponse({ ok: true, readerVersion: READER_VERSION, readyState: document.readyState, visible: document.visibilityState === 'visible', frameUrl: currentTai888PageUrl() });
      return;
    }
    if (message?.type === 'TAI888_READER_RECOVER') {
      const reattached = attachObserver();
      try { sendResponse({ ok: true, reattached, capture: capture() }); }
      catch { sendResponse({ ok: false, error: 'recovery-capture-failed' }); }
      return;
    }
    if (!['TAI888_CAPTURE_BASEBALL_TABLE', 'TAI888_CAPTURE_MLB_TABLE'].includes(message?.type)) return;
    try { sendResponse({ ok: true, capture: capture() }); }
    catch {
      sendResponse({
        ok: false,
        error: 'capture-failed',
        frameUrl: currentTai888PageUrl(),
      });
    }
  });

  function mutationTouchesMarketBoard(mutation, marketElements) {
    const target = mutation?.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation?.target?.parentElement;
    if (!target) return false;
    return marketElements.some(element => element === target
      || element.contains?.(target)
      || target.contains?.(element));
  }

  function mutationTouchesRefreshIndicator(mutation) {
    const target = mutation?.target?.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation?.target?.parentElement;
    if (!target) return false;
    const text = String(target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return /(?:每\s*60\s*秒更新|60\s*秒更新|更新倒數|更新倒计时)/i.test(text);
  }

  function marketMutationElements() {
    const waterToken = /(?:^|\s)[0-3]\.\d{3}(?:\s|$)/;
    return collectCandidateElements().filter((element, index) => {
      const record = rowRecord(element, index);
      if (!record || record.cells.length < 4 || record.cells.length > 16) return false;
      return record.cells.filter(cell => waterToken.test(cell.text)).length >= 2;
    });
  }

  let mutationTimer = null;
  let pendingMutations = [];
  function handleMutations(mutations) {
    pendingMutations.push(...mutations);
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const mutationsToAssess = pendingMutations;
      pendingMutations = [];
      const marketElements = marketMutationElements();
      const verifiedBoardRefreshAt = mutationsToAssess.some(mutation => mutationTouchesMarketBoard(mutation, marketElements)
        || mutationTouchesRefreshIndicator(mutation))
        ? Date.now()
        : 0;
      const before = { ...fingerprintByLeague };
      const captures = captureAll({ verifiedBoardRefreshAt });
      const activeLeagues = captures
        .map(item => item.league)
        .filter(league => verifiedBoardRefreshAt > 0 || before[league] !== fingerprintByLeague[league]);
      if (activeLeagues.length) notifyBackground({ type: 'TAI888_BOARD_MUTATED', leagues: activeLeagues });
    }, 2500);
  }

  attachObserver();
  addEventListener('pageshow', () => announceFrameReady('pageshow'));
  addEventListener('focus', () => announceFrameReady('focus'));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') announceFrameReady('visible');
  });
  setInterval(() => {
    if (attachObserver()) announceFrameReady('root-replaced');
  }, 15000);
  announceFrameReady('content-ready');
})();
