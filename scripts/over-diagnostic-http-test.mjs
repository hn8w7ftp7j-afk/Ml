// Real built-server HTTP smoke test, using ephemeral LOCAL credentials only.
// No browser/session reuse, production endpoint, database or ledger mutation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_VERSION } from '../lib/app-version.js';

const reserve = net.createServer();
reserve.listen(0, '127.0.0.1');
await once(reserve, 'listening');
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
// NextURL normalizes loopback hosts to localhost. Use the same canonical
// host for requests and Origin so the real CSRF check is exercised unchanged.
const origin = `http://localhost:${port}`;
const password = randomBytes(24).toString('hex');
const server = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-H', '127.0.0.1', '-p', String(port)], {
  cwd: process.cwd(),
  env: { PATH: process.env.PATH, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', APP_PASSWORD: password, SESSION_SECRET: randomBytes(48).toString('hex') },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const exited = once(server, 'exit');
let startupLog = '';
server.stdout.on('data', chunk => { startupLog = (startupLog + chunk).slice(-6000); });
server.stderr.on('data', chunk => { startupLog = (startupLog + chunk).slice(-6000); });
const request = (pathname, options = {}) => fetch(origin + pathname, { redirect: 'manual', signal: AbortSignal.timeout(15000), ...options });
const noStore = response => assert.match(response.headers.get('cache-control') || '', /no-store/);
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  let ready = false;
  for (let attempt = 0; attempt < 150; attempt++) {
    if (server.exitCode != null) throw new Error(`Local server exited ${server.exitCode}: ${startupLog}`);
    try { const response = await request('/api/auth'); if (response.status === 200) { ready = true; break; } } catch { /* Await local startup only. */ }
    await delay(200);
  }
  assert.ok(ready, 'built local server must start');
  const anonymous = await request('/api/diagnostics/over');
  assert.equal(anonymous.status, 401); noStore(anonymous);
  const protectedPage = await request('/diagnostics/over');
  assert.equal(protectedPage.status, 307);
  assert.equal(new URL(protectedPage.headers.get('location')).pathname, '/login');
  const login = await request('/api/auth', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  assert.equal(login.status, 200); noStore(login);
  const cookieHeader = login.headers.get('set-cookie');
  assert.match(cookieHeader || '', /HttpOnly/i);
  assert.match(cookieHeader || '', /SameSite=strict/i);
  const headers = { cookie: cookieHeader.split(';')[0] };
  const page = await request('/diagnostics/over', { headers });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('<h1>研究回測｜全場大分</h1>'), 'built research page must render its current heading');
  const homepage = await request('/', { headers });
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /研究回測/);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, APP_VERSION);
  const summary = await request('/api/diagnostics/over', { headers });
  assert.equal(summary.status, 200); noStore(summary);
  const body = await summary.json();
  assert.equal(body.data.games.length, 539);
  const selected = body.data.funnel.stages.find(row => row.label === 'SIMULATED_SELECTED');
  assert.equal(selected.n, 210);
  assert.ok(Math.abs(selected.meanW - .14711820897217642) < 1e-12);
  assert.ok(Math.abs(selected.roi + .14416547619047618) < 1e-12);
  const gameId = body.data.games[0].gameId;
  const detail = await request(`/api/diagnostics/over?gameId=${gameId}`, { headers });
  assert.equal(detail.status, 200); noStore(detail);
  assert.equal((await detail.json()).data.game.gameId, gameId);
  const invalid = await request('/api/diagnostics/over?unknown=1', { headers });
  assert.equal(invalid.status, 400); noStore(invalid);
  const download = await request('/api/diagnostics/over?download=1', { headers });
  assert.equal(download.status, 200); noStore(download);
  assert.match(download.headers.get('content-type') || '', /application\/gzip/);
  const downloaded = Buffer.from(await download.arrayBuffer());
  const stored = await readFile('data/diagnostics/over-diagnostic-v1.json.gz');
  assert.equal(hash(downloaded), hash(stored));
  console.log(JSON.stringify({ status: 'PASS', scope: 'BUILT_LOCAL_HTTP_ONLY_NOT_BROWSER_OR_PRODUCTION_AUTHENTICATED_ACCEPTANCE', version: APP_VERSION, gameCount: 539, selectedCount: 210, gzipBytes: downloaded.length, checks: ['anonymous-401', 'protected-page-redirect', 'real-local-login', 'http-only-session', 'authenticated-page', 'research-navigation', 'health-version', 'frozen-summary', 'game-details', 'invalid-query', 'exact-gzip-download'] }));
} finally {
  server.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(4000).then(() => false)]);
  if (!stopped) { server.kill('SIGKILL'); await exited; }
}
