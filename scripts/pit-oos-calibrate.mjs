import fs from 'node:fs';
import { buildOosCalibration } from '../lib/pit-oos-calibration-v106.js';

const [inputPath, outputPath] = process.argv.slice(2);
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/pit-oos-calibrate.mjs <observations.ndjson|json> <artifact.json>');
  process.exit(2);
}
const source = fs.readFileSync(inputPath, 'utf8');
const observations = inputPath.endsWith('.ndjson')
  ? source.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  : JSON.parse(source);
const result = buildOosCalibration(observations);
if (!result.ok) {
  console.error(JSON.stringify(result, null, 2));
  process.exit(1);
}
fs.writeFileSync(outputPath, `${JSON.stringify(result.artifact, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: result.status, artifactHash: result.artifact.artifactHash, diagnostics: result.artifact.diagnostics }, null, 2));
