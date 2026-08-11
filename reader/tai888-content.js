(() => {
  if (globalThis.__TAI888_READER_CAPTURE_V2__) return;
  globalThis.__TAI888_READER_CAPTURE_V2__ = true;

  const clean = value => String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  function visible(element) {
    if (!element) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rectangle = element.getBoundingClientRect();
    return rectangle.width > 0 && rectangle.height > 0;
  }

  function linesFor(cell) {
    const text = clean(cell?.innerText || cell?.textContent || '');
    if (!text) return [];
    const direct = text.split(/\r?\n/).map(clean).filter(Boolean);
    if (direct.length >= 2) return direct.slice(0, 20);

    const fragments = [];
    const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const value = clean(node.nodeValue || '');
      if (!value) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rectangles = [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0);
      for (const rectangle of rectangles) fragments.push({ text: value, x: rectangle.left, y: rectangle.top });
    }
    if (!fragments.length) return direct;
    fragments.sort((left, right) => left.y - right.y || left.x - right.x);
    const rows = [];
    for (const fragment of fragments) {
      let row = rows.find(item => Math.abs(item.y - fragment.y) <= 5);
      if (!row) {
        row = { y: fragment.y, parts: [] };
        rows.push(row);
      }
      if (!row.parts.some(part => part.text === fragment.text && Math.abs(part.x - fragment.x) < 2)) row.parts.push(fragment);
    }
    return rows
      .sort((left, right) => left.y - right.y)
      .map(row => clean(row.parts.sort((left, right) => left.x - right.x).map(part => part.text).join(' ')))
      .filter(Boolean)
      .slice(0, 20);
  }

  function rowCells(row) {
    return [...row.children]
      .filter(cell => /^(TD|TH)$/i.test(cell.tagName) && visible(cell))
      .map(cell => ({ lines: linesFor(cell) }));
  }

  function capture() {
    const groups = new Map();
    let headers = [];
    let insideMlb = false;
    const bodyText = clean(document.body?.innerText || '');
    const documentLooksMlb = /(?:聯盟|联盟)\s*[:：]?\s*MLB\s*(?:美國職棒|美国职棒)/i.test(bodyText);

    for (const row of [...document.querySelectorAll('tr')]) {
      if (!visible(row)) continue;
      const cells = rowCells(row);
      const rowText = clean(cells.flatMap(cell => cell.lines).join(' '));
      if (!rowText) continue;

      const looksHeader = /時間/.test(rowText)
        && /(?:主客隊伍|主客队伍|隊伍|队伍)/.test(rowText)
        && /(?:讓球|让球)/.test(rowText)
        && /(?:大小盤|大小盘)/.test(rowText);
      if (looksHeader) {
        headers = cells.map(cell => clean(cell.lines.join(' ')));
        continue;
      }

      if (/(?:聯盟|联盟)\s*[:：]?/i.test(rowText)) {
        insideMlb = /\bMLB\b/i.test(rowText) && /(?:美國職棒|美国职棒)/.test(rowText);
        continue;
      }

      if (!insideMlb && !documentLooksMlb) continue;
      if (!headers.length || cells.length < 6) continue;
      const teamCell = cells.find(cell => (cell.lines.join(' ').match(/(?:^|\s)[A-Z]{2,4}\s*-/g) || []).length >= 2);
      const timeCell = cells.find(cell => /\b\d{1,2}-\d{1,2}\b/.test(cell.lines.join(' ')) && /\b\d{1,2}:\d{2}\b/.test(cell.lines.join(' ')));
      if (!teamCell || !timeCell) continue;

      const signature = headers.join('|');
      if (!groups.has(signature)) groups.set(signature, { headers, rows: [] });
      groups.get(signature).rows.push({ cells, text: rowText });
    }

    return {
      version: 'TAI888-DOM-CAPTURE-v2.0.0',
      sourceHost: location.hostname,
      pageUrl: location.href,
      pageTitle: document.title,
      observedAt: new Date().toISOString(),
      frameUrl: location.href,
      tables: [...groups.values()].map(group => ({
        headers: group.headers.slice(0, 16),
        rows: group.rows.slice(0, 60).map(row => ({
          text: row.text.slice(0, 2500),
          cells: row.cells.slice(0, 16).map(cell => ({ lines: cell.lines.map(line => line.slice(0, 500)) })),
        })),
      })),
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'TAI888_CAPTURE_MLB_TABLE') return;
    try { sendResponse({ ok: true, capture: capture() }); }
    catch (error) { sendResponse({ ok: false, error: String(error?.message || error) }); }
  });

  let mutationTimer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'TAI888_BOARD_MUTATED', pageUrl: location.href }).catch(() => {});
    }, 2500);
  });
  if (document.documentElement) observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
})();
