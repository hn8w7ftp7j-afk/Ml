import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve, relative } from 'node:path';
import { estimateConditionalReturnError } from './estimator.mjs';
import { conditionalReturnSyntheticFixture } from './synthetic-fixture.mjs';

const directory = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(directory, '../../..');
const prefix = 'research/soccer/conditional-return-error/';
const base = '11956a087eb733f88310a1d39457306602d842de';
const output = resolve(directory, 'verification-report.json');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const flags = process.argv.slice(2);
assert.ok(flags.length <= 1 && flags.every(value => ['--write', '--verify'].includes(value)), 'Only --write or --verify is supported');

function run(command, args, timeout = 120000) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    process.stderr.write(result.stderr || '');
    process.stderr.write(result.stdout || '');
    throw result.error || Error(`${command} ${args.join(' ')} exited ${result.status}`);
  }
  return result.stdout;
}

function verifyIsolation() {
  const changed = run('git', ['diff', '--name-only', base, '--']).trim().split('\n').filter(Boolean);
  const untracked = run('git', ['ls-files', '--others', '--exclude-standard']).trim().split('\n').filter(Boolean);
  assert.ok([...changed, ...untracked].every(path => path.startsWith(prefix)), 'Product or unrelated files differ from the pinned base');
}

verifyIsolation();
const commands = [
  ['node', ['research/soccer/conditional-return-error/test.mjs']],
  ['node', ['--experimental-loader=./scripts/soccer-synthetic-identity-loader.mjs', 'research/soccer/conditional-return-error/bridge-test.mjs']],
];
const checks = commands.map(([command, args]) => {
  run(command, args);
  return { command: `${command} ${args.join(' ')}`, exitCode: 0, status: 'PASS', evidence: 'ISOLATED_SYNTHETIC_ENGINEERING_TESTS_ONLY' };
});
verifyIsolation();
const files = readdirSync(directory).filter(name => name !== 'verification-report.json').sort();
const sourceHashes = Object.fromEntries(files.map(name => [prefix + name, digest(readFileSync(resolve(directory, name)))]));
const dependencies = [
  'package.json', 'package-lock.json', 'lib/soccer/return-error-model.js',
  'lib/soccer/market-return-validation.js', 'lib/soccer/forward-validation.js',
  'lib/soccer/soccer-scoring.js', 'lib/soccer/market-payoff.js', 'lib/soccer/settlement-contract.js',
  'lib/soccer/scoring-input-preparation.js', 'lib/soccer/scoring-bundle-registry.js',
  'scripts/helpers/soccer-forward-fixture.mjs', 'scripts/soccer-synthetic-identity-loader.mjs',
];
const dependencyHashes = Object.fromEntries(dependencies.map(path => [path, digest(readFileSync(resolve(root, path)))]));
const fixture = conditionalReturnSyntheticFixture();
const conditional = estimateConditionalReturnError(fixture);
const missing = estimateConditionalReturnError({ ...fixture, assumptions: { ...fixture.assumptions,
  contextOmissionBound: null, numericalTailBound: null, conditionalBlockIndependence: false } });
assert.equal(conditional.status, 'ASSUMPTION_CONDITIONAL_RESEARCH');
assert.equal(missing.status, 'COMPONENTS_ONLY_MISSING_ASSUMPTIONS');
for (const value of [conditional, missing]) {
  assert.equal(value.formalEligible, false); assert.equal(value.formalMargin, null);
  assert.equal(value.R, null); assert.equal(value.S, null);
}
const report = {
  version: 'CONDITIONAL-RETURN-ERROR-ENGINEERING-REPLAY-v1',
  status: 'ENGINEERING_TESTS_PASS_RESEARCH_NOT_ACCEPTED',
  baseCommit: base,
  baseTree: run('git', ['rev-parse', `${base}^{tree}`]).trim(),
  productFilesChanged: false,
  productionDeploymentMutationAttempted: false,
  productionDataLoadedByReplay: false,
  newUntouchedOosValidation: false,
  verifiedConditionalIndependence: false,
  verifiedTransferOrOmittedContextBounds: false,
  accepted: false, formalEligible: false, formalMargin: null, R: null, S: null,
  checks, sourceHashes, dependencyHashes,
  syntheticDemonstration: {
    provenance: 'DETERMINISTIC_INVENTED_CALCULATOR_INPUT_NOT_PRODUCTION_DATA_OR_OOS',
    declaredGames: fixture.observations.length,
    withAllUnverifiedAssumptions: { status: conditional.status,
      conditionalTotalBound: conditional.conditionalTotalBound, formalMargin: null, R: null, S: null },
    withUnknownContextNumericsAndIndependence: { status: missing.status,
      conditionalTotalBound: missing.conditionalTotalBound, reasons: missing.reasons,
      formalMargin: null, R: null, S: null },
  },
  interpretation: 'Test execution and content reproducibility only; no real-game precision, source completeness, OOS improvement or formal R/S acceptance is established.',
};
if (flags.includes('--write')) {
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
} else {
  assert.deepEqual(report, JSON.parse(readFileSync(output, 'utf8')), 'Research replay differs from the saved report');
}
console.log(JSON.stringify({ ok: true, report: relative(root, output), checks: checks.length,
  canonicalReportHash: digest(JSON.stringify(report)), accepted: false, formalEligible: false, R: null, S: null }));
