// Synthetic delayed captures use only an isolated PostgreSQL fixture. They are
// not evidence that a live bookmaker board or a production device was read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { canonicalReaderPayload, parseTai888Capture } from '../reader/parser.js';
import { readerPayloadsByDate, selectAuthoritativeBoard } from '../reader/board-selector.js';
import { normalizeNbaReaderPayload } from '../lib/nba/reader.js';
import { validateTai888ReaderEnvelope } from '../lib/tai888-reader-parser-v2.js';
import { validateSoccerCapture } from '../lib/soccer/reader.js';
import { buildReaderCaptureArchive, saveReaderCaptureArchive, listReaderCaptureArchives } from '../lib/reader-capture-archive.js';

const schema = 'READER-CAPTURE-ARCHIVE-v1';
const table = 'sports_reader_capture_archive_v1';
const deviceId = 'archive-synthetic-device';
const version = '2.1.48';
const observedAt = '2026-10-24T22:00:01.000Z';
const pageActivityAt = '2026-10-24T22:00:00.000Z';
const clock = Date.parse('2026-10-30T00:00:00.000Z');
const poison = 'private-cookie-password-account-token-must-not-survive';
const options = { deviceId, headerVersion: version, now: clock };
const hash = value => createHash('sha256').update(value).digest('hex');
const sign = payload => ({ ...payload, payloadHash: hash(canonicalReaderPayload(payload)) });
const wrap = payload => ({ schema, payload: sign(payload) });
const build = body => buildReaderCaptureArchive(body, options);
const clone = value => structuredClone(value);
const teams = { MLB: ['ATH', 'KC'], NPB: ['G', 'T'], KBO: ['LG', 'KT'], CPBL: ['ACN011', 'ADD011'], NBA: ['GSW', 'LAL'] };
function standard(league) {
  const nba = league === 'NBA';
  return {
    version: nba ? 'TAI888-READER-DOM-v2.2.0' : 'TAI888-READER-DOM-v2.1.0',
    readerVersion: version, league, deviceId,
    sourceHost: 'www1.tai888.in', pageUrl: 'https://www1.tai888.in/newapp/#/BS',
    boardDate: '2026-10-25', observedAt, pageActivityAt,
    expectedGameCount: 1, detectedGameCount: 1, parseIssues: [],
    accountToken: poison, pageTitle: poison,
    games: [{ awayCode: teams[league][0], homeCode: teams[league][1],
      boardDate: '2026-10-25', boardTime: '08:00', marketStatus: 'open',
      fullRunline: { lineSide: 'away', line: '1平', awayWater: 0.95, homeWater: 0.94, privateData: poison },
      fullTotal: { line: nba ? '224+50' : '8+50', overWater: 0.93, underWater: 0.92 },
      [nba ? 'firstHalfRunline' : 'first5Runline']: null,
      [nba ? 'firstHalfTotal' : 'first5Total']: null,
      marketStates: nba
        ? { firstHalfTotal: 'UNAVAILABLE', firstHalfRunline: 'UNAVAILABLE', fullTotal: 'AVAILABLE', fullRunline: 'AVAILABLE' }
        : { FULL_HANDICAP: 'AVAILABLE', FULL_TOTAL: 'AVAILABLE', FIRST_HALF_HANDICAP: 'UNAVAILABLE', FIRST_HALF_TOTAL: 'UNAVAILABLE' },
      accountToken: poison, rawRowText: poison,
    }],
  };
}
function football(league, { combined = false } = {}) {
  const label = league === 'EPL' ? '英格蘭超級聯賽' : '歐洲冠軍聯賽';
  const cell = pair => ({ pair });
  const periodTable = prefix => ({ sectionTitle: `${label} ${prefix}`,
    headers: ['時間', '主客隊伍', `${prefix}讓球`, `${prefix}大小`, `${prefix}獨贏`],
    rows: [{ cells: [cell(['10-25', '22:00']), cell(['布倫特福德', '侯城[主]']),
      cell(['1平 0.95', '0.91']), cell(['大3+50 0.95', '小 0.89']), cell(['主勝 -', '和 -', '客勝 -'])] }],
  });
  const raw = { league, pageLeagueLabel: label, sourceHost: 'www1.tai888.in',
    pageUrl: 'https://www1.tai888.in/newapp/', observedAt,
    tables: [periodTable('全場'), ...(combined ? [periodTable('上半場')] : [])] };
  const parsed = parseTai888Capture(raw, new Date(observedAt));
  assert.deepEqual(parsed.parseIssues, []);
  return { ...parsed, readerVersion: version, deviceId, pageActivityAt,
    accountToken: poison, pageTitle: poison,
  };
}

const db = new PGlite();
const statements = [];
const sql = (strings, ...values) => {
  const query = strings.reduce((text, part, index) => text + (index ? `$${index}` : '') + part, '');
  statements.push(query);
  return { query, values, then: (resolve, reject) => db.query(query, values).then(result => result.rows).then(resolve, reject) };
};
sql.transaction = queries => db.transaction(async transaction => {
  const rows = [];
  for (const query of queries) rows.push((await transaction.query(query.query, query.values)).rows);
  return rows;
});
const save = (body, extra = {}) => saveReaderCaptureArchive(body, { ...options, sql, ...extra });
const count = async () => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
const bodies = Object.fromEntries(['MLB', 'NPB', 'KBO', 'CPBL', 'NBA', 'EPL', 'UCL'].map(league => [league, wrap(teams[league] ? standard(league) : football(league))]));

try {
  for (const [league, body] of Object.entries(bodies)) {
    const archive = build(body);
    assert.equal(archive.league, league);
    assert.equal(archive.boardDate, body.payload.boardDate);
    assert.equal(archive.payloadHash, body.payload.payloadHash);
    assert.equal(archive.observedAt, observedAt);
    assert.equal(archive.pageActivityAt, pageActivityAt);
    assert.equal(archive.captureId, hash(JSON.stringify([schema, league, body.payload.boardDate, observedAt, pageActivityAt, body.payload.payloadHash])));
    assert.equal(JSON.stringify(archive.payload).includes(poison), false, `${league}: bounded sports allowlist excludes account, title and unrelated row text`);
    const receipt = await save(body);
    assert.equal(receipt.ok, true); assert.equal(receipt.durable, true);
    assert.equal(receipt.archiveOnly, true); assert.equal(receipt.currentBoardUpdated, false);
    assert.equal(receipt.historicalAvailabilityVerified, false); assert.equal(receipt.executable, false);
    assert.equal(receipt.captureId, archive.captureId); assert.equal(receipt.payloadHash, archive.payloadHash);
    assert.equal(receipt.observedAt, observedAt); assert.equal(receipt.pageActivityAt, pageActivityAt);
    assert.equal(receipt.receivedAt, new Date(clock).toISOString(), 'server receipt time remains actual arrival, not original capture time');
    assert.ok(Number.isFinite(Date.parse(receipt.persistedAt)));
    const retry = await save(body, { now: clock + 3_600_000 });
    assert.equal(retry.captureId, receipt.captureId); assert.equal(retry.receivedAt, receipt.receivedAt);
    assert.equal(retry.persistedAt, receipt.persistedAt, 'transport retries retain the first durable receipt');
  }
  assert.equal(await count(), 7, 'seven delayed sources persist independently and retries are idempotent');
  const stored = (await db.query(`SELECT * FROM ${table} WHERE league='NBA'`)).rows[0];
  assert.equal(typeof stored.payload_json, 'string', 'exact canonical content is text, avoiding JSONB marketStates key-order drift');
  assert.equal(JSON.stringify(stored).includes(poison), false);

  // The archive cannot make expired source activity eligible for the live path.
  assert.throws(() => validateTai888ReaderEnvelope(bodies.MLB.payload, { receivedAt: new Date(clock).toISOString(), league: 'MLB' }));
  assert.throws(() => normalizeNbaReaderPayload(bodies.NBA.payload, options));
  assert.equal(validateSoccerCapture(bodies.EPL.payload, { now: clock, headerVersion: version }).ok, false);

  const nbaCanonical = hash(canonicalReaderPayload(bodies.NBA.payload));
  const nbaReordered = clone(bodies.NBA.payload);
  nbaReordered.games[0].marketStates = Object.fromEntries(Object.entries(nbaReordered.games[0].marketStates).reverse());
  assert.notEqual(hash(canonicalReaderPayload(nbaReordered)), nbaCanonical, 'fixture covers the real key-order hazard rather than assuming it cannot occur');
  assert.equal((await save(bodies.NBA)).captureId, build(bodies.NBA).captureId);

  const locked = standard('MLB');
  for (const key of ['fullRunline', 'fullTotal', 'first5Runline', 'first5Total']) locked.games[0][key] = null;
  for (const key of Object.keys(locked.games[0].marketStates)) locked.games[0].marketStates[key] = 'UNAVAILABLE';
  locked.games[0].marketStatus = 'locked';
  assert.equal(build(wrap(locked)).payload.games[0].marketStatus, 'locked', 'explicitly locked sources preserve absent markets');
  const newer = clone(bodies.MLB); newer.payload.observedAt = '2026-10-24T22:01:01.000Z';
  newer.payload.pageActivityAt = '2026-10-24T22:01:00.000Z';
  assert.notEqual(build(newer).captureId, build(bodies.MLB).captureId, 'same price with a distinct original observation has its own capture identity');
  await save(newer); assert.equal(await count(), 8);
  const otherDeviceBody = clone(bodies.MLB); otherDeviceBody.payload.deviceId = 'archive-other-device';
  assert.equal((await save(otherDeviceBody, { deviceId: 'archive-other-device' })).captureId, build(bodies.MLB).captureId, 'identical canonical capture does not acquire a new ID per paired device');

  const combined = football('EPL', { combined: true });
  const ftPayload = readerPayloadsByDate(combined, { soccerScopes: [{ boardDate: combined.boardDate, periodsCovered: ['FT'] }] })[0];
  assert.deepEqual(ftPayload.periodsCovered, ['FT']);
  const ftBody = wrap(ftPayload), ftArchive = build(ftBody);
  assert.deepEqual(ftArchive.payload.periodsCovered, ['FT']);
  assert.ok(ftArchive.payload.games.every(game => game.markets.every(market => market.period === 'FT')));
  assert.equal(ftArchive.payload.sourceCapture.tables.length, 2, 'scope validation retains the complete original raw source');
  for (const mutate of [
    value => { value.payload.sourceScope.periodsCovered = ['FT', 'HT']; },
    value => { delete value.payload.sourceScope; },
    value => { value.payload.sourceScope.boardDate = '2026-10-26'; },
    value => { value.payload.sourceCapture.tables[1].rows[0].cells[1].pair = ['侯城', '侯城[主]']; },
  ]) {
    const bad = clone(ftBody); mutate(bad); bad.payload = sign(bad.payload);
    assert.throws(() => build(bad), 'raw soccer reparse rejects widened/missing source scope and invalid unselected rows');
  }

  for (const league of Object.keys(bodies)) {
    const bad = clone(bodies[league]); bad.payload.payloadHash = '0'.repeat(64);
    assert.throws(() => build(bad), `${league}: a claimed digest cannot control archival content identity`);
  }
  const changed = clone(bodies.MLB); changed.payload.games[0].fullTotal.overWater = 0.99;
  assert.throws(() => build(changed), 'price tampering without a new canonical digest is rejected');
  for (const mutate of [
    body => { body.schema = 'unrecognized'; },
    body => { body.payload.league = 'NHL'; },
    body => { body.payload.sourceHost = 'tai888.in.evil.invalid'; },
    body => { body.payload.pageUrl = 'https://tai888.in.evil.invalid/newapp/'; },
    body => { body.payload.pageUrl = 'https://name:password@www1.tai888.in/newapp/'; },
    body => { body.payload.deviceId = 'another-device'; },
    body => { body.payload.readerVersion = '1.0.0'; },
    body => { body.payload.observedAt = '2026-02-30T22:00:01.000Z'; },
    body => { body.payload.observedAt = '2026-10-30T00:05:00.000Z'; body.payload.pageActivityAt = body.payload.observedAt; },
    body => { body.payload.pageActivityAt = '2026-10-24T21:55:00.000Z'; },
    body => { body.payload.detectedGameCount = 2; },
    body => { body.payload.games[0].homeCode = 'OAK'; },
    body => { body.payload.games[0].homeCode = 'G'; },
    body => { body.payload.games[0].boardDate = '2026-10-26'; },
    body => { body.payload.games[0].boardTime = '25:00'; },
    body => { body.payload.games[0].fullRunline.line = 'DROP'; },
    body => { body.payload.games[0].fullTotal.overWater = 0; },
    body => { body.payload.games[0].marketStatus = 'locked'; },
    body => { body.payload.games.push(clone(body.payload.games[0])); body.payload.detectedGameCount = 2; body.payload.expectedGameCount = 2; },
    body => { body.payload.parseIssues = ['conflicting-duplicate']; },
    body => { body.payload.games[0].fullRunline.rawRows = ['2平 0.950', '0.940']; },
  ]) {
    const bad = clone(bodies.MLB); mutate(bad); bad.payload = sign(bad.payload);
    assert.throws(() => build(bad), 'archive rejects malformed original sources even when their client digest is internally consistent');
  }
  assert.throws(() => buildReaderCaptureArchive(bodies.MLB, { ...options, headerVersion: '2.1.47' }));

  // A real partial source may preserve one price while the other cell cannot
  // be parsed. BLOCKED is evidence of that missing cell, not a fabricated quote.
  const partialSource = { league: 'MLB', sourceHost: 'tai888.in', pageUrl: 'https://tai888.in/newapp/', observedAt,
    tables: [{ headers: ['時間', '主客隊伍', '全場讓分', '全場大小'], rows: [{ cells: [
      { pair: ['10-25', '20:00'] }, { pair: ['NYY-洋基', 'BOS-紅襪[主]'] },
      { pair: ['2平 0.950', '0.950'] }, { pair: ['大 無法辨識', '小 0.940'] },
    ] }] }], diagnostics: { gameCount: 1, expectedGameCount: 1, lastMutationAt: observedAt } };
  const parsedPartial = parseTai888Capture(partialSource, new Date(observedAt));
  const authority = selectAuthoritativeBoard([{ capture: partialSource, parsed: parsedPartial, tabId: 1, frameId: 0 }],
    { league: 'MLB', now: Date.parse(observedAt), dateScoped: true });
  assert.equal(authority.ok, true, JSON.stringify(authority.assessed));
  assert.equal(parsedPartial.games[0].fullTotal, null);
  assert.equal(parsedPartial.games[0].marketStates.FULL_TOTAL, 'BLOCKED');
  const partialBody = wrap({ ...parsedPartial, deviceId, readerVersion: version,
    pageActivityAt: observedAt, expectedGameCount: 1, detectedGameCount: 1 });
  const partialSaved = await save(partialBody);
  assert.equal(partialSaved.durable, true, 'actual accepted partial parser source survives historical-only persistence');
  const partialArchived = build(partialBody).payload.games[0];
  assert.equal(partialArchived.fullRunline.line, '2平'); assert.equal(partialArchived.fullTotal, null);
  assert.equal(partialArchived.marketStates.FULL_TOTAL, 'BLOCKED');

  const rowText = standard('MLB');
  const prefix = 'sensitiveaccountpassword';
  rowText.games[0].fullRunline.rawRows = [`${prefix} 1平 0.950`, '0.940'];
  assert.equal(JSON.stringify(build(wrap(rowText))).includes(prefix), false,
    'validated numerical raw-row evidence cannot retain unrelated sensitive prefixes');

  const inventory = await listReaderCaptureArchives({ sql });
  assert.equal(inventory.currentBoardUpdated, false); assert.equal(inventory.historicalAvailabilityVerified, false);
  const inventoryText = JSON.stringify(inventory);
  assert.equal(inventoryText.includes(deviceId), false); assert.equal(inventoryText.includes(poison), false);
  assert.ok(inventory.leagues?.every(row => Object.keys(row).every(key => !/payload|device/i.test(key))), 'inventory exposes only safe aggregate fields');
  for (const league of Object.keys(bodies)) assert.ok(inventory.leagues.some(row => row.league === league));

  await assert.rejects(() => db.query(`UPDATE ${table} SET payload_json='{}' WHERE league='MLB'`), 'immutable archive refuses later payload changes');
  await assert.rejects(() => db.query(`DELETE FROM ${table} WHERE league='MLB'`), 'immutable archive refuses deletion');
  assert.equal(await count(), 9);
  const corruptSql = (strings, ...values) => {
    const query = strings.join('');
    const original = sql(strings, ...values);
    if (!/SELECT/i.test(query) || !/capture_id/.test(query) || /CREATE|INSERT/i.test(query)) return original;
    return Promise.resolve(original).then(rows => rows.map(row => ({ ...row, payload_json: '{}' })));
  };
  corruptSql.transaction = sql.transaction;
  await assert.rejects(() => save(bodies.NBA, { sql: corruptSql }), 'a write acknowledgement without matching full-content readback is rejected');
  for (const query of statements) assert.doesNotMatch(query, /\b(?:tai888_market_line_history_v1|tai888_market_capture_receipts_v1|sports_soccer_reader_observations_v2|sports_soccer_source_heads_v2|sports_soccer_analysis_heads_v2|sports_soccer_reader_period_heads_v2)\b/i,
    'historical-only persistence never reads or advances current analysis/source state');
  console.log('PASS seven-league delayed Reader archive: original source identity/time/hash, sports allowlists, soccer period scope/reparse, partial/locked markets, real PostgreSQL idempotence/immutable/readback, safe inventory and unchanged live freshness guards; Production NOT VERIFIED');
} finally {
  await db.close();
}
