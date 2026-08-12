(() => {
  if (globalThis.__TAI888_READER_CAPTURE_V202__) return;
  globalThis.__TAI888_READER_CAPTURE_V202__ = true;

  const clean = value => String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const LEAGUE_MARKER = /(?:聯盟|联盟)\s*[:：]?/i;

  function visible(element) {
    if (!element || !(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 1 && rectangle.height > 1;
  }

  function textRows(element) {
    const fragments = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
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
      const range = document.createRange();
      range.selectNodeContents(node);
      const rectangles = typeof range.getClientRects === 'function'
        ? [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
        : [];
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
        .slice(0, 20)
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
      .slice(0, 20);
  }

  function rowCellElements(row) {
    let cells = [...row.children].filter(cell => /^(TD|TH)$/i.test(cell.tagName) && visible(cell));
    if (cells.length < 2 && /^(TR)$/i.test(row.tagName)) {
      cells = [...row.querySelectorAll('th,td')]
        .filter(cell => cell.closest('tr') === row && visible(cell));
    }
    if (cells.length < 2 && !/^(TR)$/i.test(row.tagName)) {
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

  function meaningfulRowText(text) {
    const value = clean(text);
    return /(?:時間|主客隊伍|主客队伍|讓球|让球|大小盤|大小盘)/.test(value)
      || LEAGUE_MARKER.test(value)
      || /(?:^|\s)[A-Z]{2,4}\s*-/.test(value)
      || (/\b\d{1,2}-\d{1,2}\b/.test(value) && /(?:0|1)\.\d{3}/.test(value));
  }

  function rowRecord(element, order) {
    if (!visible(element)) return null;
    const elementText = clean(element.innerText || element.textContent || '');
    const cells = rowCellElements(element).map(cellRecord)
      .filter(cell => cell.text && cell.right > cell.left);
    if (!cells.length) return null;
    if (cells.length < 2 && !LEAGUE_MARKER.test(elementText)) return null;
    const rectangle = element.getBoundingClientRect();
    const text = clean(cells.map(cell => cell.text).join(' ')) || elementText;
    if (!meaningfulRowText(text)) return null;
    return {
      order,
      text,
      cells,
      top: rectangle.top,
      bottom: rectangle.bottom,
      left: rectangle.left,
      right: rectangle.right,
      tag: element.tagName,
    };
  }

  function collectCandidateElements(includeFallback = false) {
    const primary = [...document.querySelectorAll('tr,[role="row"]')].filter(visible);
    const set = new Set(primary);

    if (includeFallback) {
      for (const element of [...document.querySelectorAll('div,li')].slice(0, 6000)) {
        if (!visible(element) || element.querySelector('tr,[role="row"]')) continue;
        const text = clean(element.innerText || element.textContent || '');
        if (!meaningfulRowText(text) || text.length > 2500) continue;
        const children = [...element.children]
          .filter(child => visible(child) && clean(child.innerText || child.textContent || ''));
        if (children.length < 2 || children.length > 24) continue;
        set.add(element);
      }
    }

    return [...set].sort((left, right) => {
      if (left === right) return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function normalizeElements(elements, documentLooksStandardMlb) {
    const records = elements.map((element, index) => rowRecord(element, index)).filter(Boolean);
    const normalizer = globalThis.Tai888RowNormalizer;
    if (!normalizer?.normalizeRowRecords) throw new Error('Tai888 split-row normalizer 未載入');
    return {
      records,
      normalized: normalizer.normalizeRowRecords(records, { documentLooksStandardMlb }),
    };
  }

  function capture() {
    const bodyText = clean(document.body?.innerText || document.body?.textContent || '');
    const documentLooksStandardMlb = /(?:聯盟|联盟)\s*[:：]?\s*MLB\s*(?:美國職棒|美国职棒)/i.test(bodyText)
      && /(?:時間|时间)/.test(bodyText)
      && /(?:主客隊伍|主客队伍)/.test(bodyText)
      && /(?:讓球|让球)/.test(bodyText)
      && /(?:大小盤|大小盘)/.test(bodyText);

    let fallbackUsed = false;
    let elements = collectCandidateElements(false);
    let result = normalizeElements(elements, documentLooksStandardMlb);
    if (!result.normalized.tables.length) {
      fallbackUsed = true;
      elements = collectCandidateElements(true);
      result = normalizeElements(elements, documentLooksStandardMlb);
    }

    return {
      version: 'TAI888-DOM-CAPTURE-v2.0.2',
      sourceHost: location.hostname,
      pageUrl: location.href,
      pageTitle: document.title,
      observedAt: new Date().toISOString(),
      frameUrl: location.href,
      tables: result.normalized.tables,
      diagnostics: {
        ...result.normalized.diagnostics,
        candidateElementCount: elements.length,
        acceptedRecordCount: result.records.length,
        documentLooksStandardMlb,
        fallbackUsed,
        frameHost: location.hostname,
      },
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'TAI888_CAPTURE_MLB_TABLE') return;
    try { sendResponse({ ok: true, capture: capture() }); }
    catch (error) {
      sendResponse({
        ok: false,
        error: String(error?.message || error),
        frameUrl: location.href,
      });
    }
  });

  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'TAI888_BOARD_MUTATED', pageUrl: location.href }).catch(() => {});
    }, 2500);
  });
  if (document.documentElement) {
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
})();
