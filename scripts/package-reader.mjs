import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const OUTPUT_DIR = path.resolve(ROOT, process.argv[2] || 'release');
const ARCHIVE_NAME = 'Tai888-Reader-v2.1.18-SELF-HEAL.zip';
const SHA_NAME = `${ARCHIVE_NAME}.sha256`;
const FIXED_TIME = new Date('1980-01-01T00:00:00.000Z');
const FILES = [
  'README.md',
  'manifest.json',
  'background.js',
  'board-selector.js',
  'capture-policy.js',
  'league-registry.js',
  'parser.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'row-normalizer.js',
  'tai888-content.js',
];

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function assertInsideProject(target, label) {
  const relative = path.relative(fs.realpathSync(ROOT), fs.realpathSync(target));
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `${label} must stay inside the project`);
}

function assertSafeProjectPath(target, label) {
  const relative = path.relative(ROOT, target);
  assert.equal(relative.startsWith('..') || path.isAbsolute(relative), false, `${label} must stay inside the project`);
  let current = ROOT;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    assert.equal(stat.isSymbolicLink(), false, `${label} must not traverse a symbolic link`);
  }
}

function regularFileIfPresent(file, label) {
  try {
    const stat = fs.lstatSync(file);
    assert.equal(stat.isSymbolicLink(), false, `${label} must not be a symbolic link`);
    assert.equal(stat.isFile(), true, `${label} must be a regular file`);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function command(name, args, options = {}) {
  return execFileSync(name, args, {
    ...options,
    env: { ...process.env, TZ: 'UTC' },
    stdio: options.stdio || 'pipe',
    maxBuffer: 16 * 1024 * 1024,
  });
}

function quarantineArtifact(file) {
  regularFileIfPresent(file, 'quarantined artifact');
  const contents = fs.readFileSync(file);
  const quarantineDir = path.join(path.dirname(OUTPUT_DIR), `${path.basename(OUTPUT_DIR)}-obsolete`);
  assertSafeProjectPath(quarantineDir, 'quarantine directory');
  fs.mkdirSync(quarantineDir, { recursive: true });
  assertInsideProject(quarantineDir, 'quarantine directory');
  const destination = path.join(quarantineDir, `${path.basename(file)}.obsolete-${sha256(contents).slice(0, 12)}`);
  if (fs.existsSync(destination)) fs.unlinkSync(file);
  else fs.renameSync(file, destination);
}

function prepareDeliveryDirectory(expectedArchive, expectedSha) {
  assertSafeProjectPath(OUTPUT_DIR, 'output directory');
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  assertInsideProject(OUTPUT_DIR, 'output directory');
  const nestedReaderArtifacts = [];
  const pendingDirectories = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(OUTPUT_DIR, entry.name));
  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, 'delivery directory must not contain symbolic links');
      if (entry.isDirectory()) pendingDirectories.push(file);
      else if (entry.isFile() && /^Tai888-Reader.*\.zip(?:\.sha256)?$/i.test(entry.name)) nestedReaderArtifacts.push(file);
    }
  }
  assert.deepEqual(nestedReaderArtifacts, [], 'delivery directory contains nested Reader artifacts; move them outside before packaging');
  const expectedByName = new Map([
    [ARCHIVE_NAME, expectedArchive],
    [SHA_NAME, Buffer.from(expectedSha, 'utf8')],
  ]);
  for (const entry of fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })) {
    assert.equal(entry.isSymbolicLink(), false, 'delivery directory must not contain symbolic links');
    if (!entry.isFile() || !/^Tai888-Reader.*\.zip(?:\.sha256)?$/i.test(entry.name)) continue;
    const file = path.join(OUTPUT_DIR, entry.name);
    const expected = expectedByName.get(entry.name);
    if (expected && fs.readFileSync(file).equals(expected)) continue;
    quarantineArtifact(file);
  }
  for (const name of [ARCHIVE_NAME, SHA_NAME]) {
    regularFileIfPresent(path.join(OUTPUT_DIR, name), `delivery artifact ${name}`);
  }
}

function buildArchive(workRoot, outputFile) {
  const packageRoot = path.join(workRoot, 'Tai888-Reader');
  fs.mkdirSync(packageRoot, { recursive: true });
  for (const file of FILES) {
    const source = path.join(ROOT, 'reader', file);
    assert.equal(regularFileIfPresent(source, `Reader source ${file}`), true, `missing Reader source: ${file}`);
    const target = path.join(packageRoot, file);
    fs.copyFileSync(source, target);
    fs.chmodSync(target, 0o644);
    fs.utimesSync(target, FIXED_TIME, FIXED_TIME);
    if (file.endsWith('.js')) command(process.execPath, ['--check', target]);
  }
  fs.chmodSync(packageRoot, 0o755);
  fs.utimesSync(packageRoot, FIXED_TIME, FIXED_TIME);
  const entries = FILES.map(file => `Tai888-Reader/${file}`);
  command('zip', ['-X', '-q', '-9', outputFile, ...entries], { cwd: workRoot });
  command('unzip', ['-tq', outputFile]);

  for (const file of FILES) {
    const source = fs.readFileSync(path.join(ROOT, 'reader', file));
    const archived = command('unzip', ['-p', outputFile, `Tai888-Reader/${file}`]);
    assert.deepEqual(archived, source, `archive/source mismatch: ${file}`);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'reader/manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.name, 'Tai888 Reader');
assert.equal(manifest.version, '2.1.18');
assert.equal(manifest.version_name, '2.1.18 SELF-HEAL');
assert.deepEqual([...manifest.permissions].sort(), ['alarms', 'storage', 'webNavigation'].sort());
assert.deepEqual([...manifest.host_permissions].sort(), [
  'https://*.tai888.in/*',
  'https://tai888.in/*',
  'https://mlb-positive-ev.vercel.app/*',
].sort());
assert.equal(manifest.content_scripts.length, 1);
assert.deepEqual([...manifest.content_scripts[0].matches].sort(), [
  'https://*.tai888.in/*',
  'https://tai888.in/*',
].sort());
assert.deepEqual(manifest.content_scripts[0].js, ['capture-policy.js', 'league-registry.js', 'row-normalizer.js', 'tai888-content.js']);
assert.equal(manifest.content_scripts[0].run_at, 'document_idle');
assert.equal(manifest.content_scripts[0].all_frames, true);
assert.equal(manifest.content_scripts[0].match_about_blank, true);
assert.equal(manifest.content_scripts[0].match_origin_as_fallback, true);
assert.deepEqual(manifest.background, { service_worker: 'background.js', type: 'module' });

command(process.execPath, ['scripts/reader-static-security-v202-test.mjs'], { cwd: ROOT });

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tai888-reader-package-'));
try {
  const firstRoot = path.join(temporaryRoot, 'first');
  const secondRoot = path.join(temporaryRoot, 'second');
  fs.mkdirSync(firstRoot);
  fs.mkdirSync(secondRoot);
  const firstArchive = path.join(temporaryRoot, 'first.zip');
  const secondArchive = path.join(temporaryRoot, 'second.zip');
  buildArchive(firstRoot, firstArchive);
  buildArchive(secondRoot, secondArchive);
  const first = fs.readFileSync(firstArchive);
  const second = fs.readFileSync(secondArchive);
  assert.deepEqual(second, first, 'two independent Reader packages are not byte-identical');

  const outputFile = path.join(OUTPUT_DIR, ARCHIVE_NAME);
  const shaFile = path.join(OUTPUT_DIR, SHA_NAME);
  const digest = sha256(first);
  const shaContents = `${digest}  ${ARCHIVE_NAME}\n`;
  prepareDeliveryDirectory(first, shaContents);
  const outputTemp = path.join(OUTPUT_DIR, `.${ARCHIVE_NAME}.${process.pid}.tmp`);
  const shaTemp = path.join(OUTPUT_DIR, `.${SHA_NAME}.${process.pid}.tmp`);
  try {
    fs.copyFileSync(firstArchive, outputTemp, fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(shaTemp, shaContents, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(outputTemp, outputFile);
    fs.renameSync(shaTemp, shaFile);
  } finally {
    for (const temporaryFile of [outputTemp, shaTemp]) {
      try { fs.unlinkSync(temporaryFile); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    }
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    archive: outputFile,
    shaFile,
    bytes: first.length,
    sha256: digest,
    fileCount: FILES.length,
    deterministic: true,
  })}\n`);
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
