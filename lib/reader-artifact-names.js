import assert from 'node:assert/strict';

export const READER_PACKAGE_FILES = Object.freeze([
  'README.md', 'manifest.json', 'background.js', 'board-selector.js',
  'capture-policy.js', 'league-registry.js', 'parser.js', 'popup.css',
  'popup.html', 'popup.js', 'row-normalizer.js', 'tai888-content.js',
]);

export function readerArtifactNames(manifest) {
  const version = String(manifest?.version || '');
  const versionName = String(manifest?.version_name || '').trim();
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Reader artifact version is invalid');
  assert.ok(versionName === version || versionName.startsWith(`${version} `), 'Reader artifact version_name must match version');
  const releaseName = versionName.replace(/\s+/g, '-');
  assert.match(releaseName, /^[A-Za-z0-9.-]+$/, 'Reader artifact name contains unsafe characters');
  const archiveName = `Tai888-Reader-v${releaseName}.zip`;
  return { archiveName, shaName: `${archiveName}.sha256`, reportName: `Tai888-Reader-v${version}-VERIFICATION.md` };
}
