import fs from 'node:fs';

const path = 'app/page.js';
let source = fs.readFileSync(path, 'utf8');
const before = "const VERSION = '10.0.0';";
const after = "const VERSION = '10.1.1';";
if (!source.includes(before) && !source.includes(after)) {
  throw new Error('UI VERSION anchor not found');
}
source = source.replace(before, after);
fs.writeFileSync(path, source);
console.log('UI version updated to 10.1.1 without changing localStorage keys');
