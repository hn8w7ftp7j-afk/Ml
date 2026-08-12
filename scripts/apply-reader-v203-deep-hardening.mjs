import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const write = (file, value) => {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value, 'utf8');
};

function replaceRequired(file, from, to, label = from.slice(0, 80)) {
  const source = read(file);
  if (source.includes(to)) return;
  if (!source.includes(from)) throw new Error(`${file}: missing anchor ${label}`);
  write(file, source.replace(from, to));
}

function replaceRegexRequired(file, expression, replacement, label) {
  const source = read(file);
  if (!expression.test(source)) throw new Error(`${file}: missing regex anchor ${label}`);
  expression.lastIndex = 0;
  write(file, source.replace(expression, replacement));
}

function replaceAllInFile(file, from, to) {
  const source = read(file);
  const next = source.split(from).join(to);
  if (next !== source) write(file, next);
}

function walk(directory) {
  const output = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['.git', '.next', 'node_modules'].includes(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...walk(full));
    else output.push(full);
  }
  return output;
}

// Canonical Tai888 host everywhere, including the legacy server fallback and tests.
for (const full of walk(root)) {
  if (!/\.(?:js|mjs|json|md|txt|yml|yaml|example)$/.test(full) && !full.endsWith('.env.example')) continue;
  const source = fs.readFileSync(full, 'utf8');
  const next = source.split('xg1.tai888.in').join('www1.tai888.in');
  if (next !== source) fs.writeFileSync(full, next, 'utf8');
}

// Permanent regression registry.
{
  const file = 'package.json';
  const pkg = JSON.parse(read(file));
  const required = [
    'node scripts/tai888-reader-split-row-v2-test.mjs',
    'node scripts/tai888-reader-content-dom-v2-test.mjs',
    'node scripts/tai888-reader-pair-flow-v2-test.mjs',
    'node scripts/tai888-reader-real-board-e2e-v2-test.mjs',
    'node scripts/tai888-reader-deep-edge-v203-test.mjs',
    'node scripts/full-spec-audit-v9-4.mjs',
  ];
  const existing = String(pkg.scripts?.test || '').split(' && ').filter(Boolean);
  pkg.scripts = pkg.scripts || {};
  pkg.scripts.test = [...new Set([...existing, ...required])].join(' && ');
  write(file, `${JSON.stringify(pkg, null, 2)}\n`);
}

// Split-row normalizer: wrapped team names cannot duplicate a team; record expected league count;
// split pairs must look like Tai888's date row followed by time/[主] row.
{
  const file = 'reader/row-normalizer.js';
  let source = read(file);
  if (!source.includes('const HOME_MARKER')) {
    source = source.replace(
      "  const SPECIAL_MARKET = /(?:總得分|总得分|主隊|主队|客隊|客队|單隊|单队|特殊|球隊得分|球队得分)/i;",
      "  const SPECIAL_MARKET = /(?:總得分|总得分|主隊|主队|客隊|客队|單隊|单队|特殊|球隊得分|球队得分)/i;\n  const HOME_MARKER = /[\\[［【(（]\\s*主\\s*[\\]］】)）]/;",
    );
  }
  source = source.replace(/homeMarked: \/\\\[主\\\]\/.test\(row\.text\)/g, 'homeMarked: HOME_MARKER.test(row.text)');
  source = source.replace(/homeMarked: \/\\\[主\\\]\/.test\(mappedRow\?\.rawText\)/g, 'homeMarked: HOME_MARKER.test(mappedRow?.rawText)');
  source = source.replace(/function teamRows\(mappedRow\) \{[\s\S]*?\n  \}\n\n  function valueNear/, `function teamRows(mappedRow) {
    const sourceRows = mappedRow?.mapped?.teams?.rows?.length
      ? mappedRow.mapped.teams.rows
      : (mappedRow?.mapped?.teams?.lines || []).map((text, index) => ({ text, top: index * 20 }));
    const byCode = new Map();
    for (const row of sourceRows) {
      for (const match of clean(row.text).matchAll(TEAM_CODE)) {
        const code = match[1].toUpperCase();
        const candidate = {
          code,
          text: clean(row.text),
          top: number(row.top),
          homeMarked: HOME_MARKER.test(row.text),
        };
        const current = byCode.get(code);
        if (!current || candidate.homeMarked || candidate.text.length > current.text.length) byCode.set(code, candidate);
      }
    }
    if (!byCode.size) {
      for (const match of clean(mappedRow?.rawText).matchAll(TEAM_CODE)) {
        const code = match[1].toUpperCase();
        if (!byCode.has(code)) {
          byCode.set(code, {
            code,
            text: clean(mappedRow?.rawText),
            top: number(mappedRow?.top),
            homeMarked: HOME_MARKER.test(mappedRow?.rawText),
          });
        }
      }
    }
    return [...byCode.values()].sort((left, right) => left.top - right.top).slice(0, 2);
  }

  function valueNear`);
  source = source.replace(/function buildFromSplit\(awayRow, homeRow\) \{[\s\S]*?\n  \}\n\n  function isStandardLeagueRow/, `function buildFromSplit(awayRow, homeRow) {
    const awayTeams = teamRows(awayRow);
    const homeTeams = teamRows(homeRow);
    if (awayTeams.length !== 1 || homeTeams.length !== 1) return null;
    const away = awayTeams[0];
    const home = homeTeams[0];
    if (away.code === home.code || away.homeMarked || !home.homeMarked) return null;
    const awayTime = clean(awayRow.mapped.time?.text);
    const homeTime = clean(homeRow.mapped.time?.text);
    if (!/\\b\\d{1,2}-\\d{1,2}\\b/.test(awayTime) || !/\\b\\d{1,2}:\\d{2}\\b/.test(homeTime)) return null;
    const cells = DEFINITIONS.map(definition => pairedCell(
      awayRow.mapped[definition.key]?.text,
      homeRow.mapped[definition.key]?.text,
    ));
    return {
      cells,
      text: clean(`${awayRow.rawText} | ${homeRow.rawText}`),
      awayCode: away.code,
      homeCode: home.code,
    };
  }

  function isStandardLeagueRow`);
  source = source.replace(
    "    let pendingAway = null;\n    const games = [];",
    "    let pendingAway = null;\n    let expectedGameCount = null;\n    const games = [];",
  );
  source = source.replace(
    "      if (isLeagueMarker(record.text)) {\n        sawLeagueMarker = true;\n        insideStandardMlb = isStandardLeagueRow(record.text);\n        pendingAway = null;\n        continue;\n      }",
    `      if (isLeagueMarker(record.text)) {
        sawLeagueMarker = true;
        insideStandardMlb = isStandardLeagueRow(record.text);
        if (insideStandardMlb) {
          const count = clean(record.text).match(/[（(](\\d{1,2})[）)]/);
          if (count) expectedGameCount = Math.max(Number(expectedGameCount || 0), Number(count[1]));
        }
        pendingAway = null;
        continue;
      }`,
  );
  source = source.replace(
    "        sawLeagueMarker,\n      },",
    "        sawLeagueMarker,\n        expectedGameCount,\n      },",
  );
  source = source.replace("version: 'TAI888-SPLIT-ROW-NORMALIZER-v2.0.1'", "version: 'TAI888-SPLIT-ROW-NORMALIZER-v2.0.3'");
  write(file, source);
}

// Client parser: reject ambiguous runline ownership and totals without a complementary 大/小 pair.
{
  const file = 'reader/parser.js';
  let source = read(file);
  if (!source.includes('const HOME_MARKER')) {
    source = source.replace(
      "const WATER_TOKEN = /^(?:0|1)\\.\\d{3}$/;",
      "const WATER_TOKEN = /^(?:0|1)\\.\\d{3}$/;\nconst HOME_MARKER = /[\\[［【(（]\\s*主\\s*[\\]］】)）]/;",
    );
  }
  source = source.replace(/homeMarked: \/\\\[主\\\]\/.test\(line\)/g, 'homeMarked: HOME_MARKER.test(line)');
  source = source.replace(/function parseRunline\(cell\) \{[\s\S]*?\n\}\n\nfunction parseTotal/, `function parseRunline(cell) {
  const [awayRow, homeRow] = pairLines(cell);
  const awayLine = lineTokenIn(awayRow);
  const homeLine = lineTokenIn(homeRow);
  if ((!awayLine && !homeLine) || (awayLine && homeLine)) return null;
  const line = awayLine || homeLine;
  return {
    lineSide: awayLine ? 'away' : 'home',
    line,
    awayWater: waterIn(awayRow),
    homeWater: waterIn(homeRow),
    confidence: 1,
    rawRows: [awayRow, homeRow],
  };
}

function parseTotal`);
  source = source.replace(/function parseTotal\(cell\) \{[\s\S]*?\n\}\n\nfunction headerIndex/, `function parseTotal(cell) {
  const [topRow, bottomRow] = pairLines(cell);
  const topLine = lineTokenIn(topRow);
  const bottomLine = lineTokenIn(bottomRow);
  if (topLine && bottomLine && topLine !== bottomLine) return null;
  const line = topLine || bottomLine;
  if (!line) return null;
  const topOver = /(?:^|\\s)大(?:\\s|$)/.test(topRow);
  const topUnder = /(?:^|\\s)小(?:\\s|$)/.test(topRow);
  const bottomOver = /(?:^|\\s)大(?:\\s|$)/.test(bottomRow);
  const bottomUnder = /(?:^|\\s)小(?:\\s|$)/.test(bottomRow);
  const normal = topOver && bottomUnder;
  const inverted = topUnder && bottomOver;
  if (!normal && !inverted) return null;
  const topWater = waterIn(topRow);
  const bottomWater = waterIn(bottomRow);
  return {
    line,
    overWater: normal ? topWater : bottomWater,
    underWater: normal ? bottomWater : topWater,
    confidence: 1,
    rawRows: [topRow, bottomRow],
  };
}

function headerIndex`);
  source = source.replace("version: 'TAI888-READER-DOM-v2.0.1'", "version: 'TAI888-READER-DOM-v2.0.3'");
  source = source.replace(
    "    games: (payload?.games || []).map(game => ({",
    "    games: [...(payload?.games || [])].sort((left, right) => `${left.boardDate}|${left.boardTime}|${left.awayCode}|${left.homeCode}`.localeCompare(`${right.boardDate}|${right.boardTime}|${right.awayCode}|${right.homeCode}`)).map(game => ({",
  );
  write(file, source);
}

// Content capture: track real page activity so a frozen Tai888 tab cannot keep stale odds fresh.
{
  const file = 'reader/tai888-content.js';
  let source = read(file);
  source = source.replace('__TAI888_READER_CAPTURE_V202__', '__TAI888_READER_CAPTURE_V203__');
  if (!source.includes('let lastMutationAt = Date.now();')) {
    source = source.replace(
      "  const LEAGUE_MARKER = /(?:聯盟|联盟)\\s*[:：]?/i;",
      "  const LEAGUE_MARKER = /(?:聯盟|联盟)\\s*[:：]?/i;\n  let lastMutationAt = Date.now();",
    );
  }
  source = source.replace("version: 'TAI888-DOM-CAPTURE-v2.0.2'", "version: 'TAI888-DOM-CAPTURE-v2.0.3'");
  source = source.replace(
    "        frameHost: location.hostname,\n      },",
    "        frameHost: location.hostname,\n        lastMutationAt: new Date(lastMutationAt).toISOString(),\n        mutationAgeSeconds: Math.max(0, Math.floor((Date.now() - lastMutationAt) / 1000)),\n      },",
  );
  source = source.replace(
    "  const observer = new MutationObserver(() => {\n    clearTimeout(mutationTimer);",
    "  const observer = new MutationObserver(() => {\n    lastMutationAt = Date.now();\n    clearTimeout(mutationTimer);",
  );
  write(file, source);
}

// Reader background: version gate, completeness guard and page-liveness guard.
{
  const file = 'reader/background.js';
  let source = read(file).replace("const READER_VERSION = '2.0.2';", "const READER_VERSION = '2.0.3';");
  const anchor = "  const combined = {\n    sourceHost: new URL(ordered[0].url).hostname,";
  const replacement = `  const expectedGameCount = Math.max(0, ...diagnostics.map(row => Number(row.capture?.expectedGameCount || 0)));
  const detectedGameCount = Math.max(0, ...diagnostics.map(row => Number(row.capture?.gameCount || 0)));
  if (expectedGameCount > 0 && detectedGameCount !== expectedGameCount) {
    throw await rememberError(
      \`Tai888 顯示 \${expectedGameCount} 場，但 Reader 只完整辨識 \${detectedGameCount} 場；已停止上傳，避免漏盤。請重新整理頁面後再同步。\`,
      { diagnostics },
    );
  }
  const activityTimes = diagnostics
    .map(row => Date.parse(row.capture?.lastMutationAt || ''))
    .filter(Number.isFinite);
  const pageActivityAt = activityTimes.length ? new Date(Math.max(...activityTimes)).toISOString() : '';
  if (!pageActivityAt || Date.now() - Date.parse(pageActivityAt) > 3 * 60 * 1000) {
    throw await rememberError('Tai888 頁面超過3分鐘沒有任何更新活動；已停止刷新舊盤，請確認頁面仍在更新或重新登入。', { diagnostics });
  }

  const combined = {
    sourceHost: new URL(ordered[0].url).hostname,`;
  if (!source.includes(anchor)) throw new Error('background combined anchor missing');
  source = source.replace(anchor, replacement);
  source = source.replace(
    "  parsed.readerVersion = READER_VERSION;\n  parsed.deviceId = stored.deviceId;",
    "  parsed.readerVersion = READER_VERSION;\n  parsed.deviceId = stored.deviceId;\n  parsed.pageActivityAt = pageActivityAt;\n  parsed.expectedGameCount = expectedGameCount || null;\n  parsed.detectedGameCount = detectedGameCount || parsed.games.length;",
  );
  source = source.replace(
    "    runtimeCache: data.runtimeCache,\n    diagnostics:",
    "    runtimeCache: data.runtimeCache,\n    expectedGameCount,\n    detectedGameCount,\n    pageActivityAt,\n    diagnostics:",
  );
  write(file, source);
}

// Shared store: exact date lookups never fall back to another day's board.
{
  const file = 'lib/reader-store-v2.js';
  let source = read(file);
  source = source.replace(
    "export async function refreshReaderSnapshot(previous, { observedAt, receivedAt, readerVersion } = {}) {",
    "export async function refreshReaderSnapshot(previous, { observedAt, receivedAt, readerVersion, pageActivityAt } = {}) {",
  );
  source = source.replace(
    "    readerVersion: readerVersion || previous.readerVersion,\n  };",
    "    readerVersion: readerVersion || previous.readerVersion,\n    pageActivityAt: pageActivityAt || previous.pageActivityAt,\n  };",
  );
  replaceRegexRequired(file, /export async function loadReaderSnapshot\(date = ''\) \{[\s\S]*?\n\}/, `export async function loadReaderSnapshot(date = '') {
  if (date) {
    const dateKey = keyFor(date);
    const remoteDate = await remoteGet(dateKey);
    if (remoteDate) return remoteDate;
    return memory.get(dateKey) || null;
  }
  const remoteLatest = await remoteGet(keyFor());
  if (remoteLatest) return remoteLatest;
  return memory.get(keyFor()) || null;
}`, 'exact date Reader store');
  source = read(file).replace("READER_STORE_VERSION = 'TAI888-RUNTIME-CACHE-v2.0.1'", "READER_STORE_VERSION = 'TAI888-RUNTIME-CACHE-v2.0.3'");
  write(file, source);
}

// Server parser: minimum v2.0.3, exact date/time matching, source liveness and a server-computed raw-board hash.
{
  const file = 'lib/tai888-reader-parser-v2.js';
  let source = read(file);
  source = source.replace("TAI888-READER-PARSER-v2.0.2", "TAI888-READER-PARSER-v2.0.3");
  source = source.replace("TAI888-DOM-TABLE-v2.0.2", "TAI888-DOM-TABLE-v2.0.3");
  source = source.replace('best.timeDistance > 240', 'best.timeDistance > 120');
  source = source.replace(
    "return major > 2 || (major === 2 && (minor > 0 || patch >= 1));",
    "return major > 2 || (major === 2 && (minor > 0 || patch >= 3));",
  );
  source = source.replace('Reader版本過舊，請更新至Tai888 Reader 2.0.2', 'Reader版本過舊，請更新至Tai888 Reader 2.0.3');
  if (!source.includes('export function rawTai888ReaderPayloadHash')) {
    source = source.replace(
      "function canonical(value) {",
      `export function rawTai888ReaderPayloadHash(payload) {
  const rawGames = Array.isArray(payload?.games) ? payload.games.slice(0, 40) : [];
  const raw = {
    version: clean(payload?.version, 80),
    readerVersion: clean(payload?.readerVersion, 80),
    sourceHost: normalizedHost(payload?.sourceHost),
    boardDate: clean(payload?.boardDate, 20),
    games: rawGames.map(game => ({
      awayCode: clean(game?.awayCode, 8).toUpperCase(),
      homeCode: clean(game?.homeCode, 8).toUpperCase(),
      boardDate: clean(game?.boardDate, 20),
      boardTime: clean(game?.boardTime, 10),
      fullRunline: game?.fullRunline || null,
      fullTotal: game?.fullTotal || null,
      first5Runline: game?.first5Runline || null,
      first5Total: game?.first5Total || null,
    })).sort((left, right) => \`${left.boardDate}|\${left.boardTime}|\${left.awayCode}|\${left.homeCode}\`.localeCompare(\`${right.boardDate}|\${right.boardTime}|\${right.awayCode}|\${right.homeCode}\`)),
  };
  return createHash('sha256').update(JSON.stringify(canonical(raw))).digest('hex');
}

function canonical(value) {`,
    );
  }
  const observedAnchor = "  const observedAt = clean(payload.observedAt, 60);\n  const observedTime = Date.parse(observedAt);";
  const observedReplacement = `  const observedAt = clean(payload.observedAt, 60);
  const observedTime = Date.parse(observedAt);`;
  if (!source.includes(observedAnchor)) throw new Error('server parser observed anchor missing');
  source = source.replace(observedAnchor, observedReplacement);
  source = source.replace(
    "  if (observedTime > receivedTime + 5 * 60 * 1000 || observedTime < receivedTime - 30 * 60 * 1000) {\n    throw new Error('Reader 盤口時間與伺服器差距過大');\n  }",
    `  if (observedTime > receivedTime + 5 * 60 * 1000 || observedTime < receivedTime - 30 * 60 * 1000) {
    throw new Error('Reader 盤口時間與伺服器差距過大');
  }
  const pageActivityAt = clean(payload.pageActivityAt, 60);
  const pageActivityTime = Date.parse(pageActivityAt);
  if (!Number.isFinite(pageActivityTime)
    || pageActivityTime > receivedTime + 5 * 60 * 1000
    || pageActivityTime < receivedTime - 5 * 60 * 1000) {
    throw new Error('Tai888頁面活動時間已過期，拒絕刷新舊盤');
  }
  const rawBoardHash = rawTai888ReaderPayloadHash(payload);`,
  );
  source = source.replace(
    "    observedAt,\n    receivedAt,\n    freshnessTtlSeconds:",
    "    observedAt,\n    receivedAt,\n    pageActivityAt,\n    rawBoardHash,\n    expectedGameCount: Number(payload.expectedGameCount) || null,\n    detectedGameCount: Number(payload.detectedGameCount) || rawGames.length,\n    freshnessTtlSeconds:",
  );
  write(file, source);
}

// Ingest: require device binding, use server-computed heartbeat hash, reject partial/older boards.
{
  const file = 'app/api/reader/ingest/route.js';
  let source = read(file);
  source = source.replace(
    "import { normalizeTai888ReaderPayload } from '../../../../lib/tai888-reader-parser-v2.js';",
    "import { normalizeTai888ReaderPayload, rawTai888ReaderPayloadHash } from '../../../../lib/tai888-reader-parser-v2.js';",
  );
  source = source.replace(
    "    if (deviceHeader && deviceHeader !== token.deviceId) {",
    "    if (!deviceHeader || deviceHeader !== token.deviceId) {",
  );
  source = source.replace(
    "    const payloadHash = cleanText(body.payloadHash, 80);\n    const sourceHost = cleanText(body.sourceHost, 200).toLowerCase();",
    "    const rawBoardHash = rawTai888ReaderPayloadHash(body);\n    const sourceHost = cleanText(body.sourceHost, 200).toLowerCase();",
  );
  source = source.replace(
    "    if (/^[a-f0-9]{64}$/i.test(payloadHash)\n      && previous?.payloadHash === payloadHash",
    "    if (/^[a-f0-9]{64}$/i.test(rawBoardHash)\n      && previous?.rawBoardHash === rawBoardHash",
  );
  source = source.replace(
    "        readerVersion: cleanText(body.readerVersion, 80),\n      });",
    "        readerVersion: cleanText(body.readerVersion, 80),\n        pageActivityAt: cleanText(body.pageActivityAt, 60),\n      });",
  );
  source = source.replace(
    "        payloadHash: refreshed.payloadHash,",
    "        payloadHash: refreshed.payloadHash,\n        rawBoardHash: refreshed.rawBoardHash,",
  );
  source = source.replace(
    "    if (!normalized.matchedGameCount) {",
    "    if (!normalized.matchedGameCount) {",
  );
  const noMatchBlock = `    if (!normalized.matchedGameCount) {
      return NextResponse.json({
        ok: false,
        error: 'Reader 已讀到 Tai888 表格，但沒有場次能配對 MLB 官方賽程',
        rawGameCount: normalized.rawGameCount,
        unmatched: normalized.unmatched,
      }, { status: 422, headers });
    }`;
  const noMatchReplacement = `${noMatchBlock}
    if (normalized.matchedGameCount !== normalized.rawGameCount || normalized.unmatched.length) {
      return NextResponse.json({
        ok: false,
        error: 'Reader 場次未完整配對 MLB 官方賽程，已拒絕寫入部分盤口',
        rawGameCount: normalized.rawGameCount,
        matchedGameCount: normalized.matchedGameCount,
        unmatched: normalized.unmatched,
      }, { status: 422, headers });
    }
    if (previous && Date.parse(normalized.observedAt) + 5000 < Date.parse(previous.observedAt || '')) {
      return NextResponse.json({ ok: false, error: '收到比目前快照更舊的盤口，已拒絕覆蓋' }, { status: 409, headers });
    }`;
  if (!source.includes(noMatchBlock)) throw new Error('ingest no-match block missing');
  source = source.replace(noMatchBlock, noMatchReplacement);
  source = source.replace(
    "      payloadHash: normalized.payloadHash,",
    "      payloadHash: normalized.payloadHash,\n      rawBoardHash: normalized.rawBoardHash,",
  );
  write(file, source);
}

// Reader documentation and release version.
write('reader/README.md', `# Tai888 Reader v2.0.3

## 功能

- 只讀取 Chrome 已正常登入、目前頁面已顯示的 Tai888 MLB 盤口表格。
- 支援一場拆成客隊／主隊兩列、單列聯盟標記、Tai888 子框架與必要的 div/list 備援版型。
- 逐場解析全場讓分、全場大小、上半讓分、上半大小與雙方實際水位。
- 排除主隊總得分、客隊總得分及其他特殊盤。
- 比對聯盟顯示場數；漏讀任何一場時不寫入部分盤口。
- 監控頁面更新活動；頁面停住超過三分鐘時不再把舊盤標成最新。
- Tai888 頁面內容變動時自動同步，並每 60 秒送一次心跳。
- 不讀取密碼、Cookie、Session、帳戶額度，不操作下注，不繞過 Cloudflare。

## 安裝後必要設定

1. Chrome 開啟 \`chrome://extensions\`，移除舊版並載入解壓後的 \`Tai888-Reader\` 資料夾。
2. 確認版本 2.0.3。
3. 回到 \`https://www1.tai888.in/newapp/#/BS\` 後按一次 F5。
4. 保持 MLB「讓分＆大小」頁、Chrome 與電腦持續開啟。
5. Chrome「效能」設定中，將 \`www1.tai888.in\` 加入永遠保持啟用的網站，避免記憶體節省模式丟棄分頁。
`);
write('reader/CHANGELOG-v2.0.3.txt', `Tai888 Reader 2.0.3

- Deep-audit release replacing 2.0.0–2.0.2.
- Rejects incomplete league capture instead of uploading a partial board.
- Rejects frozen Tai888 pages after three minutes without DOM activity.
- Rejects ambiguous runline ownership and non-complementary total rows.
- Deduplicates wrapped team-code text and validates away-date/home-time split pairs.
- Uses exact-date Reader snapshot lookup and exact-date/time MLB schedule matching.
- Uses a server-computed raw-board hash for efficient unchanged-board heartbeats.
- Rejects partial schedule matches, older snapshot overwrite and obsolete Reader clients.
- Keeps successful pairing even when first synchronization needs attention.
`);

// Version strings in UI, fixtures and workflows.
for (const file of [
  'reader/manifest.json', 'reader/popup.html',
  'scripts/tai888-reader-content-dom-v2-test.mjs',
  'scripts/tai888-reader-pair-flow-v2-test.mjs',
  'scripts/tai888-reader-real-board-e2e-v2-test.mjs',
  'scripts/tai888-reader-parser-v2-test.mjs',
  'scripts/full-spec-audit-v9-4.mjs',
  '.github/workflows/package-reader-v2.yml',
  '.github/workflows/reader-v202-final-audit.yml',
]) replaceAllInFile(file, '2.0.2', '2.0.3');

// Ensure known-old client assertions stay old after the version sweep.
replaceAllInFile('scripts/tai888-reader-parser-v2-test.mjs', "readerVersion: '2.0.3' }, schedule", "readerVersion: '2.0.0' }, schedule");

// Add the deep edge test to both permanent workflows.
for (const file of ['.github/workflows/package-reader-v2.yml', '.github/workflows/reader-v202-final-audit.yml']) {
  let source = read(file);
  if (!source.includes('node scripts/tai888-reader-deep-edge-v203-test.mjs')) {
    source = source.replace(
      '          node scripts/tai888-reader-real-board-e2e-v2-test.mjs\n',
      '          node scripts/tai888-reader-real-board-e2e-v2-test.mjs\n          node scripts/tai888-reader-deep-edge-v203-test.mjs\n',
    );
  }
  write(file, source);
}

console.log('Tai888 Reader 2.0.3 deep hardening patch applied.');
