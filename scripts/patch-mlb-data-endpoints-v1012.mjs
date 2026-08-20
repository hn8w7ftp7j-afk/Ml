import fs from 'node:fs';

function edit(path, transform) {
  const before = fs.readFileSync(path, 'utf8');
  const after = transform(before);
  if (after === before) throw new Error(`${path}: no change applied`);
  fs.writeFileSync(path, after);
}

edit('lib/mlb-context-v11.js', source => {
  let next = source;
  next = next.replace(
    "async function fetchStats(teamId, group, startDate, endDate, options) {\n  const url = new URL(`${MLB_API}/teams/${teamId}/stats`);",
    "async function fetchStats(teamId, group, startDate, endDate, options) {\n  const season = String(endDate || '').slice(0, 4);\n  const url = new URL(`${MLB_API}/teams/${teamId}/stats`);"
  );
  next = next.replace(
    "url.searchParams.set('group', group);\n  url.searchParams.set('startDate', startDate);",
    "url.searchParams.set('group', group);\n  url.searchParams.set('season', season);\n  url.searchParams.set('sportIds', '1');\n  url.searchParams.set('startDate', startDate);"
  );
  next = next.replace(
    "async function fetchLeague(group, startDate, endDate, options) {\n  const url = new URL(`${MLB_API}/teams/stats`);",
    "async function fetchLeague(group, startDate, endDate, options) {\n  const season = String(endDate || '').slice(0, 4);\n  const url = new URL(`${MLB_API}/teams/stats`);"
  );
  next = next.replace(
    "url.searchParams.set('group', group);\n  url.searchParams.set('sportIds', '1');",
    "url.searchParams.set('group', group);\n  url.searchParams.set('season', season);\n  url.searchParams.set('sportIds', '1');"
  );
  next = next.replace(
    "return requestJson(`${MLB_API}/venues/${venueId}`, { ...options, ttlMs: 24 * 60 * 60 * 1000 });",
    "const url = new URL(`${MLB_API}/venues/${venueId}`);\n  url.searchParams.set('hydrate', 'location,fieldInfo,timezone');\n  return requestJson(url, { ...options, ttlMs: 24 * 60 * 60 * 1000 });"
  );
  return next;
});

edit('app/api/analyze/route.js', source => source.replace(
  "    if (!context?.coreModelable) {\n      return NextResponse.json({ ok: false, error: '資料不足｜不評分', warnings: context?.warnings || [] }, { status: 422, headers: { 'Cache-Control': 'no-store' } });\n    }",
  "    if (!context?.coreModelable) {\n      const blocking = Array.isArray(context?.dataGateV10?.blocking) ? context.dataGateV10.blocking : [];\n      const detail = blocking.length ? blocking.join('、') : '未知核心欄位';\n      console.error('[ANALYZE_CORE_BLOCK]', { league, gamePk: game?.gamePk, blocking, warnings: context?.warnings || [] });\n      return NextResponse.json({ ok: false, code: 'CORE_DATA_MISSING', error: `資料不足｜不評分｜缺少：${detail}`, blocking, warnings: context?.warnings || [] }, { status: 422, headers: { 'Cache-Control': 'no-store' } });\n    }"
));

console.log('MLB endpoint patch v10.1.2 applied');