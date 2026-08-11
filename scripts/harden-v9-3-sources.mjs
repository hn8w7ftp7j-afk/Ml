import fs from 'node:fs';

const path = 'app/api/credit-lines/route.js';
let source = fs.readFileSync(path, 'utf8');
const before = String.raw`    const safeText = String(source.text || '')
      .replace(/((?:帳號|账号|會員|会员|使用者|用户名|username))s*[:：]?s*[^|\n]{1,80}/gi, '$1：[已遮蔽]')
      .replace(/((?:餘額|余额|信用額度|信用额度|可用額度|可用额度|balance|credit))s*[:：]?s*[-+]?[$NT\s]*[0-9,.]+/gi, '$1：[已遮蔽]');`;
const after = String.raw`    const safeText = String(source.text || '')
      .replace(/((?:帳號|账号|會員|会员|使用者|用户名|username))\s*[:：]?\s*[^|\n]{1,80}/gi, '$1：[已遮蔽]')
      .replace(/((?:餘額|余额|信用額度|信用额度|可用額度|可用额度|balance|credit))\s*[:：]?\s*[-+]?[$NT\s]*[0-9,.]+/gi, '$1：[已遮蔽]');`;
const count = source.split(before).length - 1;
if (count !== 1) throw new Error(`credit redaction regex expected once, found ${count}`);
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('v9.3 redaction regex corrected');
