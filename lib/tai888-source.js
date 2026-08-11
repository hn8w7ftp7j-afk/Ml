import { load } from 'cheerio';

export const TAI888_SOURCE_VERSION = 'TAI888-STANDARD-LOGIN-VISIBLE-PAGE-2026-08-v1.0.0';

const DEFAULT_BASE_URL = 'https://xg1.tai888.in';
const MAX_PAGE_BYTES = 2_000_000;
const MAX_REDIRECTS = 6;
const MAX_DISCOVERY_PAGES = 8;

const clean = (value, maximum = 500) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maximum);

function validBaseUrl(value) {
  try {
    const url = new URL(value || DEFAULT_BASE_URL);
    if (url.protocol !== 'https:') return null;
    if (!(url.hostname === 'tai888.in' || url.hostname.endsWith('.tai888.in'))) return null;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function sameAllowedSite(url, baseUrl) {
  try {
    const target = new URL(url, baseUrl);
    return target.protocol === 'https:'
      && (target.hostname === baseUrl.hostname || target.hostname.endsWith('.tai888.in'));
  } catch {
    return false;
  }
}

function splitSetCookie(headerValue) {
  const value = String(headerValue || '').trim();
  if (!value) return [];
  return value.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/g).map(item => item.trim()).filter(Boolean);
}

class CookieJar {
  constructor() { this.cookies = new Map(); }

  absorb(headers) {
    let rows = [];
    if (typeof headers?.getSetCookie === 'function') rows = headers.getSetCookie();
    if (!rows.length) rows = splitSetCookie(headers?.get?.('set-cookie'));
    for (const row of rows) {
      const first = String(row || '').split(';', 1)[0];
      const index = first.indexOf('=');
      if (index <= 0) continue;
      const name = first.slice(0, index).trim();
      const value = first.slice(index + 1).trim();
      if (!name) continue;
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
  }
}

async function readText(response) {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_PAGE_BYTES) throw new Error('Tai888頁面內容過大，已停止讀取');
  return buffer.toString('utf8');
}

async function fetchDocument(input, options, jar, baseUrl) {
  let url = new URL(input, baseUrl);
  let method = String(options?.method || 'GET').toUpperCase();
  let body = options?.body;
  let headers = { ...(options?.headers || {}) };

  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    if (!sameAllowedSite(url, baseUrl)) throw new Error('Tai888登入流程導向未允許的網域，已停止');
    const cookie = jar.header();
    const response = await fetch(url, {
      method,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.8,*/*;q=0.5',
        'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.7',
        'User-Agent': 'Mozilla/5.0 (compatible; MLB-EV-ReadOnly/1.0)',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(25_000),
    });
    jar.absorb(response.headers);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`Tai888重新導向缺少位置（${response.status}）`);
      url = new URL(location, url);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
        method = 'GET';
        body = undefined;
        headers = {};
      }
      continue;
    }

    const text = await readText(response);
    if (!response.ok) throw new Error(`Tai888頁面請求失敗（${response.status}）`);
    return { url, status: response.status, text, contentType: response.headers.get('content-type') || '' };
  }
  throw new Error('Tai888登入重新導向次數過多');
}

function inputValue($, node) {
  return clean($(node).attr('value') || '', 2000);
}

export function discoverLoginFormForTest(html, pageUrl, overrides = {}) {
  const $ = load(String(html || ''));
  const forms = $('form').toArray();
  const passwordOverride = clean(overrides.passwordField, 120);
  const usernameOverride = clean(overrides.usernameField, 120);
  let selected = null;

  for (const form of forms) {
    const password = passwordOverride
      ? $(form).find(`[name="${passwordOverride.replace(/"/g, '\\"')}"]`).first()
      : $(form).find('input[type="password"], input[name*="pass" i], input[id*="pass" i]').first();
    if (!password.length) continue;
    const username = usernameOverride
      ? $(form).find(`[name="${usernameOverride.replace(/"/g, '\\"')}"]`).first()
      : $(form).find('input[type="email"], input[name*="user" i], input[name*="account" i], input[name*="login" i], input[type="text"]').filter((_, node) => {
          const type = String($(node).attr('type') || 'text').toLowerCase();
          return type !== 'hidden' && type !== 'password';
        }).first();
    if (!username.length) continue;
    selected = { form, username, password };
    break;
  }
  if (!selected) return null;

  const fields = {};
  $(selected.form).find('input[name], button[name]').each((_, node) => {
    const name = clean($(node).attr('name'), 120);
    if (!name) return;
    const type = String($(node).attr('type') || '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') {
      if ($(node).attr('checked') == null) return;
    }
    if (type === 'submit' && Object.prototype.hasOwnProperty.call(fields, name)) return;
    fields[name] = inputValue($, node);
  });

  const usernameField = clean(selected.username.attr('name'), 120);
  const passwordField = clean(selected.password.attr('name'), 120);
  if (!usernameField || !passwordField) return null;
  return {
    action: new URL(clean($(selected.form).attr('action'), 1000) || pageUrl, pageUrl).toString(),
    method: String($(selected.form).attr('method') || 'POST').toUpperCase(),
    usernameField,
    passwordField,
    fields,
  };
}

function loginFailure(text) {
  const compact = clean(text, 10000).toLowerCase();
  return /帳號.{0,12}(錯誤|不存在|停用)|密碼.{0,12}(錯誤|不正確)|login failed|invalid (?:user|account|password)|登入失敗/.test(compact);
}

function hasPasswordForm(html) {
  const $ = load(String(html || ''));
  return $('form input[type="password"], form input[name*="pass" i]').length > 0;
}

function scoreCandidate(value) {
  const text = clean(value, 1000).toLowerCase();
  let score = 0;
  if (/mlb|美棒|美國職棒|美国职棒/.test(text)) score += 20;
  if (/棒球|baseball/.test(text)) score += 8;
  if (/今日|today|賽事|赛事|盤口|盘口|odds/.test(text)) score += 3;
  if (/logout|登出|退出/.test(text)) score -= 10;
  return score;
}

function discoverCandidateUrls(html, pageUrl, explicitPath = '') {
  if (explicitPath) return [new URL(explicitPath, pageUrl).toString()];
  const $ = load(String(html || ''));
  const candidates = [];
  $('a[href], iframe[src], frame[src], form[action]').each((_, node) => {
    const attribute = $(node).is('a') ? 'href' : $(node).is('form') ? 'action' : 'src';
    const raw = clean($(node).attr(attribute), 1200);
    if (!raw || /^javascript:|^mailto:|^tel:/i.test(raw)) return;
    let url;
    try { url = new URL(raw, pageUrl).toString(); } catch { return; }
    const label = `${$(node).text()} ${raw}`;
    const score = scoreCandidate(label);
    if (score > 0) candidates.push({ url, score });
  });
  return [...new Map(candidates.sort((a, b) => b.score - a.score).map(item => [item.url, item])).values()]
    .slice(0, MAX_DISCOVERY_PAGES)
    .map(item => item.url);
}

export function extractVisibleTextForTest(html) {
  const $ = load(String(html || ''));
  $('script,style,noscript,svg,canvas').remove();
  const lines = [];
  $('table tr').each((_, row) => {
    const cells = $(row).find('th,td').toArray().map(cell => clean($(cell).text(), 500)).filter(Boolean);
    if (cells.length) lines.push(cells.join(' | '));
  });
  $('option,li,h1,h2,h3,h4,[role="row"],.row,.match,.game,.event,.league').each((_, node) => {
    const value = clean($(node).text(), 1000);
    if (value) lines.push(value);
  });
  const body = clean($('body').text(), 80_000);
  if (body) lines.push(body);
  return [...new Set(lines)].join('\n').slice(0, 120_000);
}

export function tai888SourceStatus(env = process.env) {
  const baseUrl = validBaseUrl(env.TAI888_BASE_URL || DEFAULT_BASE_URL);
  const username = clean(env.TAI888_USERNAME, 300);
  const password = String(env.TAI888_PASSWORD || '');
  const disabled = String(env.TAI888_ENABLED || '').toLowerCase() === 'false';
  return {
    configured: Boolean(!disabled && baseUrl && username && password),
    baseUrl: baseUrl?.origin || DEFAULT_BASE_URL,
    provider: 'TAI888_READ_ONLY_CREDIT',
    label: 'Tai888唯讀信用盤',
    mode: 'STANDARD_HTML_LOGIN',
    disabled,
  };
}

export async function loadTai888VisibleText(env = process.env) {
  const status = tai888SourceStatus(env);
  if (!status.configured) return { ...status, text: '', observedAt: null, diagnostics: { pages: 0 } };

  const baseUrl = validBaseUrl(env.TAI888_BASE_URL || DEFAULT_BASE_URL);
  const loginUrl = new URL(clean(env.TAI888_LOGIN_PATH, 1000) || '/', baseUrl);
  const jar = new CookieJar();
  const landing = await fetchDocument(loginUrl, { method: 'GET' }, jar, baseUrl);
  const form = discoverLoginFormForTest(landing.text, landing.url.toString(), {
    usernameField: env.TAI888_USERNAME_FIELD,
    passwordField: env.TAI888_PASSWORD_FIELD,
  });
  if (!form) throw new Error('Tai888登入頁找不到一般帳號密碼表單；目前不會反向工程隱藏接口');

  const fields = {
    ...form.fields,
    [form.usernameField]: String(env.TAI888_USERNAME || ''),
    [form.passwordField]: String(env.TAI888_PASSWORD || ''),
  };
  const body = new URLSearchParams(fields);
  const authenticated = await fetchDocument(form.action, {
    method: form.method === 'GET' ? 'GET' : 'POST',
    body: form.method === 'GET' ? undefined : body,
    headers: form.method === 'GET' ? {} : {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: baseUrl.origin,
      Referer: landing.url.toString(),
    },
  }, jar, baseUrl);
  if (loginFailure(authenticated.text) || hasPasswordForm(authenticated.text)) {
    throw new Error('Tai888帳號或密碼未通過一般登入');
  }

  const pages = [{ url: authenticated.url.toString(), text: authenticated.text }];
  const candidates = discoverCandidateUrls(authenticated.text, authenticated.url.toString(), clean(env.TAI888_MLB_PATH, 1000));
  for (const candidate of candidates) {
    if (pages.length >= MAX_DISCOVERY_PAGES) break;
    if (!sameAllowedSite(candidate, baseUrl)) continue;
    try {
      const page = await fetchDocument(candidate, { method: 'GET', headers: { Referer: authenticated.url.toString() } }, jar, baseUrl);
      if (!pages.some(item => item.url === page.url.toString())) pages.push({ url: page.url.toString(), text: page.text });
    } catch {
      // A non-essential navigation candidate must not abort the whole source.
    }
  }

  const text = pages.map(page => `PAGE ${page.url}\n${extractVisibleTextForTest(page.text)}`).join('\n\n').slice(0, 180_000);
  if (!text.trim()) throw new Error('Tai888登入成功，但盤口頁沒有可讀文字');
  return {
    ...status,
    configured: true,
    text,
    observedAt: new Date().toISOString(),
    diagnostics: {
      pages: pages.length,
      loginHost: landing.url.hostname,
      finalHost: authenticated.url.hostname,
      candidatePages: candidates.length,
    },
  };
}
