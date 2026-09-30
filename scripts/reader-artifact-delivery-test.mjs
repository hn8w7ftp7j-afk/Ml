import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readerArtifactNames } from '../lib/reader-artifact-names.js';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'reader/manifest.json'), 'utf8'));
const names = readerArtifactNames(manifest);
assert.equal(names.archiveName, `Tai888-Reader-v${manifest.version_name.replace(/\s+/g, '-')}.zip`);
assert.throws(() => readerArtifactNames({ ...manifest, version_name: '2.0.0 wrong-version' }));
assert.throws(() => readerArtifactNames({ ...manifest, version_name: `${manifest.version} ../../unsafe` }));
const directory = fs.mkdtempSync(path.join(root, '.reader-artifact-test-'));
const args = ['--tests=passed', '--audit=passed', '--build=passed', '--e2e=passed', '--package=passed', `--output-dir=${directory}`];
const invoke = extra => spawnSync(process.execPath, ['scripts/write-release-report.mjs', ...args, ...extra], { cwd: root, encoding: 'utf8' });
try {
  const packaged = JSON.parse(execFileSync(process.execPath, ['scripts/package-reader.mjs', directory], { cwd: root, encoding: 'utf8' }).trim());
  assert.equal(packaged.archive, path.join(directory, names.archiveName));
  assert.equal(packaged.shaFile, path.join(directory, names.shaName));
  assert.equal(packaged.deterministic, true);
  assert.equal(fs.existsSync(path.join(directory, `Tai888-Reader-v${manifest.version}-VERIFIED-RESCAN.zip`)), false,
    '交付流程不得依賴舊版固定標籤');
  const archivedManifest = JSON.parse(execFileSync('unzip', ['-p', packaged.archive, 'Tai888-Reader/manifest.json'], { encoding: 'utf8' }));
  assert.equal(archivedManifest.version, manifest.version);
  assert.equal(archivedManifest.version_name, manifest.version_name);
  const delivery = invoke([]);
  assert.equal(delivery.status, 0, delivery.stderr);
  const receipt = JSON.parse(delivery.stdout.trim());
  assert.equal(receipt.report, path.join(directory, names.reportName));
  const report = fs.readFileSync(receipt.report, 'utf8');
  assert.match(report, /\| e2e \| REPORTED_PASS \|/);
  assert.match(report, /Production.*NOT_VERIFIED/);
  assert.doesNotMatch(report, /LEAGUE_NOT_READY|0 high\/critical|Production build \| PASS|Reader full-flow \| PASS/,
    '回報旗標不得自動生成正式站或過期狀態的 PASS 聲明');
  const sidecar = fs.readFileSync(packaged.shaFile, 'utf8');
  fs.writeFileSync(packaged.shaFile, sidecar.replace(names.archiveName, 'obsolete.zip'));
  assert.notEqual(invoke([]).status, 0, 'sidecar 指向其他檔名時必須拒絕報告');
  fs.writeFileSync(packaged.shaFile, sidecar);

  // A self-consistent hash is insufficient if the ZIP no longer matches source.
  const rewritten = path.join(directory, 'Tai888-Reader');
  fs.mkdirSync(rewritten);
  fs.writeFileSync(path.join(rewritten, 'popup.html'), 'tampered source');
  execFileSync('zip', ['-q', '-u', packaged.archive, 'Tai888-Reader/popup.html'], { cwd: directory });
  const digest = createHash('sha256').update(fs.readFileSync(packaged.archive)).digest('hex');
  fs.writeFileSync(packaged.shaFile, `${digest}  ${names.archiveName}\n`);
  const tampered = invoke([]);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /archive\/source mismatch/);

  const workflow = fs.readFileSync(path.join(root, '.github/workflows/reader-artifact.yml'), 'utf8');
  for (const name of Object.keys(names)) assert.ok(workflow.includes(`steps.reader-files.outputs.${name}`));
  assert.ok(workflow.includes('readerArtifactNames(manifest)'));
  assert.doesNotMatch(workflow, /Tai888-Reader-v2\.1\.19/);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
console.log('Reader delivery: current-manifest ZIP/report/upload names, archive/source integrity and reported-vs-live evidence PASS');
