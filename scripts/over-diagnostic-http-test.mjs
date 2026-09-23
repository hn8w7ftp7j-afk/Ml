// Real built-server HTTP smoke test, using ephemeral LOCAL credentials only.
// No browser/session reuse, production endpoint, database or ledger mutation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
  assert.equal(page.status, 307);
  assert.equal(page.headers.get('location'), 'https://nba-mlb-research.kai-2199.chatgpt.site/mlb');
  const homepage = await request('/', { headers });
  assert.equal(homepage.status, 200);
  assert.doesNotMatch(await homepage.text(), /href="\/diagnostics\/over"/);
  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal((await health.json()).version, APP_VERSION);
  for(const pathname of ['/api/diagnostics/over','/api/diagnostics/over?gameId=824252','/api/diagnostics/over?download=1','/api/nba/corpus','/api/nba/research']){
    const response=await request(pathname,{headers});assert.equal(response.status,410);noStore(response);
    const body=await response.json();assert.equal(body.code,'RESEARCH_MOVED');assert.equal(new URL(body.url).origin,'https://nba-mlb-research.kai-2199.chatgpt.site');
  }
  const corpusWrite=await request('/api/nba/corpus',{method:'POST',headers:{...headers,origin,'content-type':'application/json'},body:'{}'});assert.equal(corpusWrite.status,410);noStore(corpusWrite);
  const nbaPage=await request('/nba',{headers});assert.equal(nbaPage.status,200);assert.doesNotMatch(await nbaPage.text(),/歷史研究|匯入歷史研究報告|全部歷史盤口/);
  console.log(JSON.stringify({status:'PASS',scope:'BUILT_LOCAL_HTTP',checks:['anonymous-auth','real-local-login','legacy-page-redirect','retired-research-apis','no-legacy-import','main-and-nba-without-backtest-entry']}));
} finally {
  server.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), delay(4000).then(() => false)]);
  if (!stopped) { server.kill('SIGKILL'); await exited; }
}

