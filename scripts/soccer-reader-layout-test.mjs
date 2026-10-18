import assert from 'node:assert/strict';
import { manifest, now, captureDesktop } from './helpers/soccer-reader-dom-fixture.mjs';
import { parseTai888Capture } from '../reader/parser.js';
import { canonicalSoccerPayload } from '../reader/soccer-parser.js';
import { selectAuthoritativeSoccerBoards } from '../reader/board-selector.js';
import { validateSoccerCapture, matchSoccerReaderGames } from '../lib/soccer/reader.js';

// These are explicit rendered-layout hypotheses, not a recovered Tai888 DOM.
// Each previously reproduced the actual diagnostic shape: accepted DIV league
// headings, zero league captures, and therefore no emptyCapture explanation.
const layouts = ['split-tables', 'nested-tables', 'div-grid'];
const failures = [], summaries = [];
for (const league of ['EPL', 'UCL']) {
  const reference = parseTai888Capture(captureDesktop(league), new Date(now));
  for (const layout of layouts) {
    const envelope = captureDesktop(league, { layout, envelopeOnly: true });
    const sections = envelope.sectionDiagnostics.filter(section => section.league === league && section.accepted);
    const capture = envelope.captures.find(value => value.league === league);
    const summary = { league, layout, acceptedSectionCount: sections.length, captureCount: envelope.captures.filter(value => value.league === league).length };
    summaries.push(summary);
    try {
      assert.ok(sections.length, `${layout}: league headings must still be visible to the actual content handler`);
      assert.ok(capture, `${layout}: accepted ${league} DIV headings must produce a capture, not silently disappear; ${JSON.stringify(envelope)}`);
      const parsed = parseTai888Capture(capture, new Date(now));
      assert.deepEqual(parsed.parseIssues, []);
      assert.equal(parsed.games.length, 1, 'alternative quotes are one match and corner/card rows remain excluded');
      assert.equal(parsed.games[0].markets.length, 10);
      assert.equal(canonicalSoccerPayload(parsed), canonicalSoccerPayload(reference),
        `${layout}: table ownership and DIV/TR display structure cannot change teams, quotes, original headers or observed period evidence`);
      assert.equal(JSON.stringify(parsed.sourceCapture).includes('角球數'), false);
      assert.equal(JSON.stringify(parsed.sourceCapture).includes('罰牌數'), false);
      const wire = { ...parsed, readerVersion: manifest.version, pageActivityAt: new Date(now).toISOString() };
      const checked = validateSoccerCapture(wire, { now, headerVersion: manifest.version });
      assert.equal(checked.ok, true, JSON.stringify(checked));
      const official = { id: `soccer:${league.toLowerCase()}:layout`, league: league.toLowerCase(), date: '2026-10-20', startTime: '2026-10-19T19:00:00.000Z', status: 'scheduled',
        home: { name: league === 'EPL' ? 'Tottenham Hotspur' : 'Real Madrid' }, away: { name: league === 'EPL' ? 'Coventry City' : 'Barcelona' } };
      assert.equal(matchSoccerReaderGames(checked.payload, [official], now)[0].officialGameId, official.id);
      assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league }).ok, true);
      const foreignCapture = captureDesktop(league, { layout, foreignHeading: true });
      const foreign = parseTai888Capture(foreignCapture, new Date(now));
      assert.deepEqual(foreign.parseIssues, []);
      assert.equal(foreign.games.length, 1, `${layout}: a foreign heading in the rendered flow must terminate the preceding league across table boundaries`);
      assert.equal(foreign.games[0].markets.length, 4, `${layout}: foreign alternative rows must not inherit the previous league`);
      // The actual public football template places Material Icon literals in
      // a third team-column band: unconditional grade, optional lock beside it.
      // These are event decorations, not extra teams or quote-outcome locks.
      for (const iconText of ['grade', 'lock', 'grade lock', 'lock grade']) {
        const iconCapture = captureDesktop(league, { layout, iconText });
        const iconParsed = parseTai888Capture(iconCapture, new Date(now));
        assert.deepEqual(iconParsed.parseIssues, []);
        assert.equal(canonicalSoccerPayload(iconParsed), canonicalSoccerPayload(reference), `${layout}/${iconText}: exact icon labels cannot alter the retained prices or teams`);
        assert.equal(iconParsed.games[0].marketStatus, 'open');
        assert.ok(Object.values(iconParsed.games[0].periodStates).every(value => value === 'open'), 'a team-column lock icon must not synthesize a quote tombstone');
      }
      const nestedCapture = captureDesktop(league, { layout, iconText: 'lock grade', nestedFragments: true });
      const nestedParsed = parseTai888Capture(nestedCapture, new Date(now));
      assert.deepEqual(nestedCapture.diagnostics.tableIssues, [], `${layout}: nested date children cannot start duplicate partial event records`);
      assert.deepEqual(nestedParsed.parseIssues, []);
      assert.equal(canonicalSoccerPayload(nestedParsed), canonicalSoccerPayload(reference), `${layout}: DIV/SPAN ownership cannot alter original quotes or period evidence`);
      assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture: nestedCapture, parsed: nestedParsed }], { now, league }).ok, true,
        `${layout}: correctly parsed nested fragments must remain an uploadable authoritative board`);
      assert.equal(validateSoccerCapture({ ...nestedParsed, readerVersion: manifest.version, pageActivityAt: new Date(now).toISOString() }, { now, headerVersion: manifest.version }).ok, true);
      const unknownCapture = captureDesktop(league, { layout, iconText: 'UnexpectedThirdTeam' });
      assert.ok(unknownCapture.diagnostics.tableIssues.includes('SOCCER_TABLE_IDENTITY_INVALID'), `${layout}: arbitrary extra team text must remain an identity error`);
      const unknownParsed = parseTai888Capture(unknownCapture, new Date(now));
      assert.equal(unknownParsed.games.length, 0);
      assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture: unknownCapture, parsed: unknownParsed }], { now, league }).ok, false);
    } catch (error) {
      failures.push({ ...summary, error: error.message });
    }
  }
  for (const [name, options] of [
    ['missing table helper', { sourceOverrides: { 'soccer-table-normalizer.js': 'void 0; // test an incomplete extension installation' } }],
    ['missing column header', { omitColumnHeader: true }],
  ]) {
    const envelope = captureDesktop(league, { layout: 'div-grid', envelopeOnly: true, ...options });
    const capture = envelope.captures.find(value => value.league === league);
    assert.ok(envelope.sectionDiagnostics.some(section => section.league === league && section.accepted));
    assert.ok(capture, `${name}: a recognized heading must remain visible as an explicit unreadable capture`);
    assert.deepEqual(capture.tables, []);
    assert.ok(capture.diagnostics.tableIssues.includes('SOCCER_HEADING_FOUND_NO_LAYOUT'));
    const layout = envelope.soccerLayouts.find(value => value.league === league);
    assert.ok(layout, `${name}: layout diagnostics must explain why no board was emitted`);
    if (name === 'missing table helper') assert.equal(layout.modules.table, false);
    else assert.equal(layout.counts.headers, 0);
    const parsed = parseTai888Capture(capture, new Date(now));
    assert.equal(selectAuthoritativeSoccerBoards([{ tabId: 1, frameId: 0, active: true, capture, parsed }], { now, league }).ok, false);
  }
}
console.log(JSON.stringify({ fixtures: summaries, failures }, null, 2));
assert.equal(failures.length, 0, 'all independently reconstructed desktop layouts must survive actual content collection, parsing, authority and server reparse');
console.log('PASS soccer rendered-layout regressions: accepted DIV headings, separate/nested tables, DIV grids and nested DIV/SPAN labels preserve exact quotes/periods/identities and authoritative uploads; grade/lock decorations retain prices while unknown team bands block; foreign headings bound scope and missing helpers/headers remain visible diagnostics. Live Tai888 DOM remains separate.');
