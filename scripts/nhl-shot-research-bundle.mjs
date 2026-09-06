// Publish only locally generated, hash-linked research into the server bundle.
// This script performs no network requests and never promotes calibration.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { compactNhlShotResearchEvidence } from '../lib/nhl/shot-research.js';
const root = new URL('../', import.meta.url);
const report = JSON.parse(await fs.readFile(new URL('scripts/fixtures/nhl/xg-research/research-report.json', root), 'utf8'));
const artifact = JSON.parse(await fs.readFile(new URL('scripts/fixtures/nhl/xg-research/frozen-artifacts.json', root), 'utf8'));
assert.equal(report.leagueId, 'NHL'); assert.equal(artifact.leagueId, 'NHL');
assert.equal(report.generatedAt, artifact.generatedAt);
assert.equal(report.productionCalibrated, false); assert.equal(artifact.productionCalibrated, false);
const { contentHash, ...unsigned } = artifact;
assert.equal(contentHash, createHash('sha256').update(JSON.stringify(unsigned)).digest('hex'));
for (const [file, identifier, value, accessor] of [
  ['shot-research-evidence.js', 'evidence', compactNhlShotResearchEvidence(report), 'nhlShotResearchEvidence'],
  ['shot-research-frozen.js', 'artifacts', artifact, 'nhlFrozenShotResearchArtifacts'],
]) {
  const destination = new URL(`lib/nhl/${file}`, root);
  const temporary = new URL(`lib/nhl/${file}.tmp-${process.pid}`, root);
  await fs.writeFile(temporary, `// Generated from locally retained official evidence; not a complete-season or Production calibration certificate.\nconst ${identifier} = ${JSON.stringify(value)};\nexport function ${accessor}() { return structuredClone(${identifier}); }\n`);
  await fs.rename(temporary, destination);
}
console.log(JSON.stringify({ bundled: true, eligibleGames: report.acquiredGames, completeSeasonCoverage: report.completeSeasonCoverage, artifactHash: contentHash }));
