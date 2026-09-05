import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const layout = read('app/layout.js');
const manifest = read('app/manifest.js');
const register = read('app/pwa-register.js');
const serviceWorker = read('public/sw.js');
const nextConfig = read('next.config.mjs');
const middleware = read('middleware.js');
const ledgerCss = read('app/ledger.css');

assert.match(layout, /appleWebApp:\s*\{[^}]*capable:\s*true/s, 'iOS standalone metadata missing');
assert.match(layout, /viewportFit:\s*'cover'/, 'iOS safe-area viewport missing');
assert.match(layout, /manifest:\s*'\/manifest\.webmanifest'/, 'web app manifest metadata missing');
assert.match(manifest, /display:\s*'standalone'/, 'manifest must remove browser chrome');
assert.match(manifest, /app-icon-maskable-512\.png/, 'maskable install icon missing');
assert.match(register, /navigator\.serviceWorker\.register\('\/sw\.js'\)/, 'service worker registration missing');
assert.match(register, /加入主畫面/, 'iPhone install instructions missing');
assert.match(register, /Promise\.race\([\s\S]*registration\.update\(\)[\s\S]*SERVICE_WORKER_UPDATE_TIMEOUT_MS/, 'service worker update must have a finite timeout');
assert.match(register, /const capturePrompt = event => \{[\s\S]*window\.location\.pathname === '\/login'[\s\S]*event\.preventDefault\(\)[\s\S]*setVisible\(true\)/, 'install overlay must only be opened by beforeinstallprompt outside the login page');
assert.doesNotMatch(register, /if \(!standaloneMode\(\)[^\n]*setVisible\(true\)/, 'install overlay must not open automatically before an install prompt');
assert.match(register, /fetch\(`\/api\/health\?t=\$\{Date\.now\(\)\}`/, 'PWA must bypass cache when checking the deployed release version');
assert.match(register, /latest\.version === APP_VERSION/, 'PWA update check must compare against the shared app version');
assert.match(register, /function applyUpdate\(\)[\s\S]*operationStartedAt[\s\S]*Date\.now\(\) - operationStartedAt < 15 \* 60 \* 1000[\s\S]*window\.location\.reload\(\)/, 'explicit update must remain blocked while an analysis operation is saving its durable handle');
assert.doesNotMatch(read('app/globals.css'), /\.pwaInstall\{position:fixed/, 'the install prompt must stay in document flow instead of covering mobile action buttons');
assert.match(register, /visibilitychange/, 'PWA must check for updates when it returns to the foreground');
assert.match(register, /pageshow/, 'PWA must check for updates when iOS restores it from memory');
assert.match(register, /setUpdateAvailable\(latest\.version\)/, 'a newer release must show a non-destructive update prompt');
assert.match(register, /onClick=\{applyUpdate\}>現在更新/, 'a release may only be applied from an explicit user action');
assert.doesNotMatch(register, /window\.setTimeout\([\s\S]{0,500}window\.location\.reload\(\)/, 'a release must never force-reload an analysis screen');
assert.match(register, /pwa-update-attempt-version/, 'dismissed release prompts must remain quiet for the current session');
assert.match(serviceWorker, /fetch\(event\.request, \{ cache: 'no-store' \}\)/, 'private app navigation must remain network-only');
assert.doesNotMatch(serviceWorker, /caches\.(?:open|match)|cache\.put/, 'private analysis pages must not be cached offline');
assert.match(nextConfig, /Service-Worker-Allowed/, 'service worker scope header missing');
assert.match(middleware, /PUBLIC_PWA_PATHS[\s\S]*manifest\.webmanifest[\s\S]*sw\.js/, 'PWA bootstrap files must remain public before app authentication');
assert.match(middleware, /pathname\.startsWith\('\/icons\/'\)/, 'install icons must remain publicly readable');
assert.match(ledgerCss, /\.rankActionStack\s*\{\s*grid-column:\s*4;/, 'desktop ranking actions must occupy the fourth grid column');
assert.match(ledgerCss, /@media \(max-width: 720px\)[\s\S]*\.rankActionStack\s*\{\s*grid-column:\s*2 \/ -1;/, 'mobile ranking actions must keep spanning the content columns');

for (const path of [
  'public/icons/app-icon-192.png',
  'public/icons/app-icon-512.png',
  'public/icons/app-icon-maskable-512.png',
  'public/icons/apple-touch-icon.png',
]) {
  const data = fs.readFileSync(new URL(`../${path}`, import.meta.url));
  assert.deepEqual([...data.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], `${path}不是有效PNG`);
}

console.log('Installable standalone PWA metadata, user-controlled updates, icons, iOS instructions and private network-only service worker PASS');
