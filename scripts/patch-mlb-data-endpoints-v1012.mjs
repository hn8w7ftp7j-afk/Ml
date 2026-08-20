import fs from 'node:fs';

function replaceExact(path, before, after) {
  let source = fs.readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`${path}: anchor not found`);
  source = source.replace(before, after);
  fs.writeFileSync(path, source);
}

replaceExact('lib/mlb-context-v11.js', `async function fetchStats(teamId, group, startDate, endDate, options) {
  const url = new URL(\`${MLB_API}/teams/${teamId}/stats\`);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('group', group);
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return requestJson(url, options);
}

async function fetchLeague(group, startDate, endDate, options) {
  const url = new URL(\`${MLB_API}/teams/stats\`);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('group', group);
  url.searchParams.set('sportIds', '1');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return requestJson(url, options);
}`, `async function fetchStats(teamId, group, startDate, endDate, options) {
  const season = String(endDate || '').slice(0, 4);
  const url = new URL(\`${MLB_API}/teams/${teamId}/stats\`);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('group', group);
  url.searchParams.set('season', season);
  url.searchParams.set('sportIds', '1');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return requestJson(url, options);
}

async function fetchLeague(group, startDate, endDate, options) {
  const season = String(endDate || '').slice(0, 4);
  const url = new URL(\`${MLB_API}/teams/stats\`);
  url.searchParams.set('stats', 'byDateRange');
  url.searchParams.set('group', group);
  url.searchParams.set('season', season);
  url.searchParams.set('sportIds', '1');
  url.searchParams.set('startDate', startDate);
  url.searchParams.set('endDate', endDate);
  return requestJson(url, options);
}`);

replaceExact('lib/mlb-context-v11.js', `async function fetchVenue(venueId, options) {
  if (!venueId) return { ok: false, data: null, error: '缺少venueId', fetchedAt: new Date().toISOString(), rawPayloadHash: null, sourceRecord: null };
  return requestJson(\`${MLB_API}/venues/${venueId}\`, { ...options, ttlMs: 24 * 60 * 60 * 1000 });
}`, `async function fetchVenue(venueId, options) {
  if (!venueId) return { ok: false, data: null, error: '缺少venueId', fetchedAt: new Date().toISOString(), rawPayloadHash: null, sourceRecord: null };
  const url = new URL(\`${MLB_API}/venues/${venueId}\`);
  url.searchParams.set('hydrate', 'location,fieldInfo,timezone');
  return requestJson(url, { ...options, ttlMs: 24 * 60 * 60 * 1000 });
}`);

replaceExact('app/api/analyze/route.js', `    if (!context?.coreModelable) {
      return NextResponse.json({ ok: false, error: '資料不足｜不評分', warnings: context?.warnings || [] }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
    }`, `    if (!context?.coreModelable) {
      const blocking = Array.isArray(context?.dataGateV10?.blocking) ? context.dataGateV10.blocking : [];
      const detail = blocking.length ? blocking.join('、') : '未知核心欄位';
      console.error('[ANALYZE_CORE_BLOCK]', { league, gamePk: game?.gamePk, blocking, warnings: context?.warnings || [] });
      return NextResponse.json({ ok: false, code: 'CORE_DATA_MISSING', error: \`資料不足｜不評分｜缺少：${detail}\`, blocking, warnings: context?.warnings || [] }, { status: 422, headers: { 'Cache-Control': 'no-store' } });
    }`);

console.log('MLB data endpoint patch v10.1.2 applied');