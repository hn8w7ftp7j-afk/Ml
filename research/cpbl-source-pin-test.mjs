import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { assertSourceBlob } from './cpbl-source-pin.mjs';
const text = 'const name = "中職";\n';
const bytes = Buffer.from(text);
const expected = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
assert.equal(assertSourceBlob(text, expected, 'test'), expected);
assert.equal(assertSourceBlob(bytes, expected, 'test'), expected);
for (const changed of [text.trim(), text + '\n', text.replace('中職', '日職'), text.replace('const', 'let')]) {
  assert.throws(() => assertSourceBlob(changed, expected, 'test'), /Source changed/);
}
console.log('PASS: UTF-8 byte length, buffers, formula/text/newline changes fail closed');
