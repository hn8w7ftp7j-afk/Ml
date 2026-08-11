import fs from 'node:fs';

function patch(path, edits) {
  let source = fs.readFileSync(path, 'utf8');
  for (const [label, before, after] of edits) {
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error(`${path} ${label}: expected once, found ${count}`);
    source = source.replace(before, after);
  }
  fs.writeFileSync(path, source);
}

patch('lib/tai888-source.js', [
  ['visible text privacy',
`export function extractVisibleTextForTest(html) {
  const $ = load(String(html || ''));
  $('script,style,noscript,svg,canvas').remove();
  const lines = [];`,
`export function extractVisibleTextForTest(html) {
  const $ = load(String(html || ''));
  $('script,style,noscript,svg,canvas,form,input,textarea,button').remove();
  $('[class*="account" i],[id*="account" i],[class*="balance" i],[id*="balance" i],[class*="member" i],[id*="member" i],[class*="wallet" i],[id*="wallet" i]').remove();
  const lines = [];`],
  ['GET login query support',
`  const body = new URLSearchParams(fields);
  const authenticated = await fetchDocument(form.action, {
    method: form.method === 'GET' ? 'GET' : 'POST',
    body: form.method === 'GET' ? undefined : body,
    headers: form.method === 'GET' ? {} : {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: baseUrl.origin,
      Referer: landing.url.toString(),
    },
  }, jar, baseUrl);`,
`  const body = new URLSearchParams(fields);
  const action = new URL(form.action);
  if (form.method === 'GET') {
    for (const [name, value] of body.entries()) action.searchParams.set(name, value);
  }
  const authenticated = await fetchDocument(action, {
    method: form.method === 'GET' ? 'GET' : 'POST',
    body: form.method === 'GET' ? undefined : body,
    headers: form.method === 'GET' ? { Referer: landing.url.toString() } : {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: baseUrl.origin,
      Referer: landing.url.toString(),
    },
  }, jar, baseUrl);`],
]);

patch('app/api/credit-lines/route.js', [
  ['remove provider-specific response format',
`          temperature: 0,
          max_tokens: 3200,
          response_format: { type: 'json_object' },`,
`          temperature: 0,
          max_tokens: 3200,`],
  ['redact account metadata before AI extraction',
`    const source = await loadTai888VisibleText();
    const extracted = await gatewayExtract(extractionPrompt(schedule, source.text));`,
`    const source = await loadTai888VisibleText();
    const safeText = String(source.text || '')
      .replace(/(?:帳號|账号|會員|会员|使用者|用户名|username)\s*[:：]?\s*[^|\\n]{1,80}/gi, '$1：[已遮蔽]')
      .replace(/(?:餘額|余额|信用額度|信用额度|可用額度|可用额度|balance|credit)\s*[:：]?\s*[-+]?[$NT\\s]*[0-9,.]+/gi, '$1：[已遮蔽]');
    const extracted = await gatewayExtract(extractionPrompt(schedule, safeText));`],
]);

console.log('v9.3 source hardening applied');
