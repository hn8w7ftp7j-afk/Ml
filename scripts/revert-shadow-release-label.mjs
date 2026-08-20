import fs from 'node:fs';
for (const path of ['lib/deterministic-finalizer-v10.js', 'scripts/analysis-v10-test.mjs']) {
  let source = fs.readFileSync(path, 'utf8');
  source = source.replaceAll('SHADOW_EXACT_MODEL_NOT_FORMAL', 'SHADOW_VALIDATED_NOT_FORMAL');
  fs.writeFileSync(path, source);
}
console.log('shadow release label compatibility restored');
