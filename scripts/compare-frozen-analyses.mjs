import { readFile, writeFile } from 'node:fs/promises';
import { compareFrozenAnalyses } from '../lib/frozen-analysis-comparison-v1.js';

const [beforePath, afterPath, outputPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !outputPath) throw new Error('Usage: node scripts/compare-frozen-analyses.mjs original-before.json original-after.json new-report.json');
const load = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };
const [before, after] = await Promise.all([load(beforePath), load(afterPath)]);
const report = compareFrozenAnalyses(before, after);
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
console.log(JSON.stringify({ status: report.status, outputPath }));
