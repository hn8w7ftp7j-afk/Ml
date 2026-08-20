(() => {
  if (globalThis.__TAI888_READER_CAPTURE_V209__) return;
  globalThis.__TAI888_READER_CAPTURE_V209__ = true;

  const policy = globalThis.Tai888CapturePolicy;
  const normalizer = globalThis.Tai888RowNormalizer;
  if (!policy?.shouldKeepRecord || !normalizer?.normalizeRowRecords) return;
  const clean = policy.clean;
  // This timestamp is deliberately independent from capture().observedAt.
  // A capture request must not make a frozen page look newly active.
  const activityByLeague = Object.fromEntries((globalThis.Tai888LeagueRegistry?.ids || []).map(league => [league, 0]));
  const fingerprintByLeague = {};

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

  function textRows(element) {
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
        .slice(0, 24)
        .map((text, index) => ({ text, top: rectangle.top + index * 18, left: rectangle.left }));
    }

    fragments.sort((left, right) => left.top - right.top || left.left - right.left);
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

  function rowRecord(element, order) {
    if (!visible(element)) return null;
    let cells = rowCellElements(element).map(cellRecord)
      .filter(cell => cell.text && cell.right > cell.left);
    let text = clean(cells.map(cell => cell.text).join(' '));
    if (!text) text = clean(element.innerText || element.textContent || '');
    if (!policy.shouldKeepRecord(cells.length, text)) return null;

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

  function stableMarketFingerprint(normalized) {
    return JSON.stringify((normalized?.tables || []).map(table => (table.rows || []).map(row =>
      (row.cells || []).map(cell => Array.isArray(cell?.pair) ? cell.pair : cell?.lines || []))));
  }

  function captureAll({ updateActivity = true } = {}) {
    const { elements, records } = collectRecords();
    const captures = [];
    for (const league of globalThis.Tai888LeagueRegistry.ids) {
      const normalized = normalizer.normalizeRowRecords(records, { expectedLeague: league });
      if (!normalized.tables.length && !normalized.diagnostics?.sawLeagueMarker) continue;
      const fingerprint = stableMarketFingerprint(normalized);
      if (updateActivity && fingerprint && fingerprint !== fingerprintByLeague[league]) {
        fingerprintByLeague[league] = fingerprint;
        activityByLeague[league] = Date.now();
      }
      const activityAt = activityByLeague[league] || Date.now();
      if (!activityByLeague[league]) activityByLeague[league] = activityAt;
      captures.push({
        version: 'TAI888-DOM-CAPTURE-v2.2.0',
        league,
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
      captures,
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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

  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      const before = { ...fingerprintByLeague };
      const captures = captureAll();
      const changedLeagues = captures
        .map(item => item.league)
        .filter(league => before[league] !== fingerprintByLeague[league]);
      if (changedLeagues.length) chrome.runtime.sendMessage({ type: 'TAI888_BOARD_MUTATED', leagues: changedLeagues }).catch(() => {});
    }, 2500);
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
})();
