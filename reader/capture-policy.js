(() => {
  const clean = value => String(value || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  function isHeaderText(text) {
    const value = clean(text);
    return /(?:時間|时间)/.test(value)
      && /(?:主客隊伍|主客队伍|隊伍|队伍)/.test(value)
      && /(?:讓球|让球)/.test(value)
      && /(?:大小盤|大小盘)/.test(value);
  }

  function isLeagueMarkerText(text) {
    return /(?:聯盟|联盟)\s*[:：]?/i.test(clean(text));
  }

  function isDataRowText(text) {
    const value = clean(text);
    const teamCodes = value.match(/(?:^|\s)[A-Z]{2,4}\s*-/g) || [];
    return teamCodes.length >= 1
      || (/\b\d{1,2}-\d{1,2}\b/.test(value) && /(?:0|1)\.\d{3}/.test(value));
  }

  function shouldKeepRecord(cellCount, text) {
    const count = Number(cellCount) || 0;
    if (isHeaderText(text) || isLeagueMarkerText(text)) return count >= 1;
    // A locked split game can render its home row with only the team cell;
    // pairing still requires an adjacent away date row and a home clock row.
    return count >= 1 && isDataRowText(text);
  }

  function shouldInspectFallback({ text, childCount = 0, hasRowDescendant = false } = {}) {
    if (hasRowDescendant) return false;
    if (isHeaderText(text) || isLeagueMarkerText(text)) return true;
    const count = Number(childCount) || 0;
    return count >= 1 && count <= 40 && isDataRowText(text);
  }

  globalThis.Tai888CapturePolicy = Object.freeze({
    clean,
    isHeaderText,
    isLeagueMarkerText,
    isDataRowText,
    shouldKeepRecord,
    shouldInspectFallback,
    version: 'TAI888-DOM-CAPTURE-POLICY-v2.0.10',
  });
})();
