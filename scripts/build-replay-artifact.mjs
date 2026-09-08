import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const files = {};
function collect(relative) {
  if (files[relative] != null) return;
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  files[relative] = source;
  for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*['"](\.[^'"]+)['"]/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(relative), match[1]));
    if (target.startsWith('../')) throw new Error('Replay source escaped project');
    collect(target);
  }
}
for (const entry of ['lib/analysis-v11.js', 'lib/deterministic-finalizer-v10.js']) collect(entry);
files['package.json'] = fs.readFileSync('package.json', 'utf8');
files['package-lock.json'] = fs.readFileSync('package-lock.json', 'utf8');
let commit = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || null;
if (!commit) { try { commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch {} }
const raw = JSON.stringify({ files, entries: ['lib/analysis-v11.js', 'lib/deterministic-finalizer-v10.js'] });
const artifact = { version: 'REPLAY-SOURCE-ARTIFACT-v1', commit, sourceSha256: createHash('sha256').update(raw).digest('hex'),
  encoding: 'GZIP_BASE64', content: gzipSync(raw).toString('base64'), fileCount: Object.keys(files).length,
  lockSha256: createHash('sha256').update(files['package-lock.json']).digest('hex'),
  scope: 'TRANSITIVE_REPLAY_SOURCE_AND_DEPENDENCY_LOCK_NOT_INSTALLED_BINARY_ARCHIVE' };
fs.mkdirSync('.generated', { recursive: true });
fs.writeFileSync('.generated/replay-artifact.json', JSON.stringify(artifact));
console.log(`Replay source artifact: ${artifact.fileCount} files, ${artifact.sourceSha256}, ${artifact.content.length} encoded bytes`);
