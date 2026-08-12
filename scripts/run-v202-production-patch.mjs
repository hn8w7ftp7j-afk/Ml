import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const sourcePath = path.resolve('scripts/apply-v202-production-patch.mjs');
const temporaryPath = path.resolve('.v202-production-patch-runtime.mjs');
let source = fs.readFileSync(sourcePath, 'utf8');
const before = 'const key = \\`${date}:\\${hash}\\`;';
const after = 'const key = \\`\\${date}:\\${hash}\\`;';
if (!source.includes(before)) throw new Error('v202 patcher literal template anchor missing');
source = source.replace(before, after);
fs.writeFileSync(temporaryPath, source, 'utf8');
try {
  await import(`${pathToFileURL(temporaryPath).href}?t=${Date.now()}`);
} finally {
  fs.rmSync(temporaryPath, { force: true });
}
