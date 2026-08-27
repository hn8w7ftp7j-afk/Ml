import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const layout = read('app/layout.js');
const manifest = read('app/manifest.js');
const register = read('app/pwa-register.js');
const serviceWorker = read('public/sw.js');
const nextConfig = read('next.config.mjs');
const middleware = read('middleware.js');

assert.match(layout, /appleWebApp:\s*\{[^}]*capable:\s*true/s, 'iOS standalone metadata missing');
assert.match(layout, /viewportFit:\s*'cover'/, 'iOS safe-area viewport missing');
assert.match(layout, /manifest:\s*'\/manifest\.webmanifest'/, 'web app manifest metadata missing');
assert.match(manifest, /display:\s*'standalone'/, 'manifest must remove browser chrome');
assert.match(manifest, /app-icon-maskable-512\.png/, 'maskable install icon missing');
assert.match(register, /navigator\.serviceWorker\.register\('\/sw\.js'\)/, 'service worker registration missing');
assert.match(register, /加入主畫面/, 'iPhone install instructions missing');
assert.match(serviceWorker, /fetch\(event\.request, \{ cache: 'no-store' \}\)/, 'private app navigation must remain network-only');
assert.doesNotMatch(serviceWorker, /caches\.(?:open|match)|cache\.put/, 'private analysis pages must not be cached offline');
assert.match(nextConfig, /Service-Worker-Allowed/, 'service worker scope header missing');
assert.match(middleware, /PUBLIC_PWA_PATHS[\s\S]*manifest\.webmanifest[\s\S]*sw\.js/, 'PWA bootstrap files must remain public before app authentication');
assert.match(middleware, /pathname\.startsWith\('\/icons\/'\)/, 'install icons must remain publicly readable');

for (const path of [
  'public/icons/app-icon-192.png',
  'public/icons/app-icon-512.png',
  'public/icons/app-icon-maskable-512.png',
  'public/icons/apple-touch-icon.png',
]) {
  const data = fs.readFileSync(new URL(`../${path}`, import.meta.url));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path}不是有效PNG`);
}

console.log('Installable standalone PWA metadata, icons, iOS instructions and private network-only service worker PASS');
