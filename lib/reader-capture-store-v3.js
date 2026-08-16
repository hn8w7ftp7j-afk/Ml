const PREFIX = 'baseball-ev:tai888-reader:capture:v3';
const memory = globalThis.__BASEBALL_READER_CAPTURE_V3__ || new Map();
globalThis.__BASEBALL_READER_CAPTURE_V3__ = memory;

async function cache() {
  if (process.env.READER_STORE_MEMORY_ONLY === 'true') return null;
  try { return (await import('@vercel/functions')).getCache(); } catch { return null; }
}

function key(league, date = '') { return `${PREFIX}:${league}:${date ? `date:${date}` : 'latest'}`; }

export async function storeLeagueCapture(snapshot, options = {}) {
  const keys = [key(snapshot.league, snapshot.boardDate), key(snapshot.league)];
  const runtime = options.runtimeCache === undefined ? await cache() : options.runtimeCache;
  const required = options.requireRuntimeCache == null
    ? process.env.VERCEL === '1' && process.env.READER_STORE_MEMORY_ONLY !== 'true'
    : Boolean(options.requireRuntimeCache);
  let durable = !required;
  if (runtime) {
    try {
      await runtime.set(keys[0], snapshot, { ttl: 43_200, tags: ['tai888-reader-capture', `tai888-reader-${snapshot.league}`] });
      await runtime.set(keys[1], snapshot, { ttl: 43_200, tags: ['tai888-reader-capture', `tai888-reader-${snapshot.league}`] });
      durable = true;
    } catch { durable = false; }
  }
  if (!durable) return { ok: false, runtimeCache: false };
  memory.set(keys[0], snapshot); memory.set(keys[1], snapshot);
  return { ok: true, runtimeCache: Boolean(runtime) };
}

export async function loadLeagueCapture(league, date = '') {
  const storageKey = key(league, date);
  const runtime = await cache();
  if (runtime) { try { const value = await runtime.get(storageKey); if (value) return value; } catch {} }
  return memory.get(storageKey) || null;
}
