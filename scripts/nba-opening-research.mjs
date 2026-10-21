import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateOpeningResearch } from '../lib/nba/opening-research.js';

// Research-only verified archive, never the production training artifact.
// An optional JSON input permits a diagnostic BLOCKED result for incomplete or
// unaudited history. Only an explicitly requested research report is written.
const args = process.argv.slice(2), outputIndex = args.indexOf('--output');
const outputPath = outputIndex < 0 ? null : args.splice(outputIndex, 2)[1];
if (outputIndex >= 0 && !outputPath) throw Error('NBA_OPENING_RESEARCH_OUTPUT_REQUIRED');
if (args.length > 1) throw Error('Usage: node scripts/nba-opening-research.mjs [history.json] [--output docs/nba-opening-totals-research.json]');
if (outputPath && path.resolve(outputPath) !== path.resolve('docs/nba-opening-totals-research.json')) {
  throw Error('NBA_OPENING_RESEARCH_OUTPUT_MUST_BE_RESEARCH_REPORT');
}
const source = args[0] ? JSON.parse(await fs.readFile(args[0], 'utf8'))
  : (await import('../lib/nba/opening-research-history.js')).openingResearchHistory;
if (!Array.isArray(source.history)) throw Error('NBA_OPENING_RESEARCH_HISTORY_REQUIRED');
const serialized = JSON.stringify(evaluateOpeningResearch(source.history, { archiveEvidence: source }), null, 2) + '\n';
if (outputPath) {
  await fs.writeFile(outputPath, serialized);
  console.log(`Saved research-only report: ${outputPath}`);
} else console.log(serialized.trimEnd());
