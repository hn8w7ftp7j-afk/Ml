import assert from 'node:assert/strict';
import { captureDesktop, manifest, now } from './helpers/soccer-reader-dom-fixture.mjs';
import { parseTai888Capture } from '../reader/parser.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { selectAuthoritativeSoccerBoards } from '../reader/board-selector.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';

// Production retained UCL raw evidence while the live Reader reported missing.
// Its exact heading was accepted by the registry. This reconstructs a proven
// scan-limit failure compatible with that evidence; the archive has no DOM
// ordinal, so this fixture is not proof of the affected computer's layout.
for (const league of ['EPL', 'UCL']) for (const foreignHeading of [false, true]) {
  const options = { layout: 'div-grid', headingCount: 72, nestedFragments: true, foreignHeading };
  const reference = parseTai888Capture(captureDesktop(league, options), new Date(now));
  const messages = [];
  const envelope = captureDesktop(league, { ...options, precedingElements: 7100, messages, envelopeOnly: true });
  assert.ok(messages.some(message => message.type === 'TAI888_SEEN_CAPTURE' && message.evidence?.league === league),
    `${league}: the independent raw archive sees the competition after the unrelated page nodes`);
  assert.ok(envelope.sectionDiagnostics.some(section => section.league === league && section.accepted),
    `${league}: a visible standard heading cannot vanish because its document ordinal exceeds 7000`);
  const capture = envelope.captures.find(item => item.league === league);
  assert.ok(capture, `${league}: live capture must retain the same competition visible to raw capture`);
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.deepEqual(parsed.parseIssues, []);
  assert.equal(canonicalSoccerPayload(parsed), canonicalSoccerPayload(reference),
    'Unrelated page nodes must not change original teams, timestamps, periods, contracts, lines or prices');
  assert.equal(parsed.games.length, 1);
  assert.equal(parsed.games[0].markets.length, foreignHeading ? 4 : 10,
    'An explicit foreign competition boundary still excludes its subsequent alternative rows');
  assert.equal(JSON.stringify(parsed.sourceCapture).includes('角球數'), false);
  assert.equal(JSON.stringify(parsed.sourceCapture).includes('罰牌數'), false);
  assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league }).ok, true);
  const checked = validateSoccerCapture({ ...parsed, readerVersion: manifest.version, pageActivityAt: new Date(now).toISOString() },
    { now, headerVersion: manifest.version });
  assert.equal(checked.ok, true, JSON.stringify(checked));
}
for (const league of ['EPL', 'UCL']) for (const options of [
  { layout: 'div-grid', precedingRows: 1201 },
  { layout: 'table', precedingRows: 1201, precedingTables: 33 },
]) {
  const reference = parseTai888Capture(captureDesktop(league, { layout: options.layout, foreignHeading: true }), new Date(now));
  const envelope = captureDesktop(league, { ...options, foreignHeading: true, envelopeOnly: true });
  const capture = envelope.captures.find(item => item.league === league);
  assert.ok(capture?.tables.length,
    `${league}: preceding foreign rows/tables cannot hide the later league in the shared column span`);
  const parsed = parseTai888Capture(capture, new Date(now));
  assert.deepEqual(parsed.parseIssues, []);
  assert.equal(canonicalSoccerPayload(parsed), canonicalSoccerPayload(reference));
  assert.equal(parsed.games.length, 1);
  assert.equal(parsed.games[0].markets.length, 4, 'later foreign rows remain excluded too');
  const paths = envelope.soccerLayouts.find(item => item.league === league).paths;
  assert.ok(paths.geometry.tableCount > 0, 'geometry traversal reaches the league after more than 1200 preceding rows');
  if (options.precedingTables) assert.ok(paths.physical.tableCount > 0,
    'physical table traversal reaches the league after more than 32 preceding foreign tables');
  assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league }).ok, true);
  assert.equal(validateSoccerCapture({ ...parsed, readerVersion: manifest.version, pageActivityAt: new Date(now).toISOString() },
    { now, headerVersion: manifest.version }).ok, true);
}
console.log('PASS large football page: EPL/UCL after 7100 unrelated DOM nodes, 1201 foreign rows and 33 preceding tables retain exact contracts, periods, foreign exclusions, authority and server reparse. Live Reader verification remains separate.');
