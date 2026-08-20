import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalReaderPayload } from '../reader/parser.js';
import {
  normalizeTai888ReaderPayload,
  rawTai888ReaderPayloadHash,
  readerSnapshotIsComplete,
  validateTai888ReaderEnvelope,
} from '../lib/tai888-reader-parser-v2.js';

const boardDate = '2026-08-12';
const observedAt = '2026-08-12T01:30:00.000Z';
const pageActivityAt = '2026-08-12T01:29:45.000Z';
const receivedAt = '2026-08-12T01:30:10.000Z';
const gameDate = '2026-08-12T02:00:00.000Z';

const leagues = Object.freeze({
  MLB: { awayCode: 'PIT', homeCode: 'MIA', awayTeamId: 134, homeTeamId: 146, away: '匹茲堡海盜', home: '邁阿密馬林魚' },
  NPB: { awayCode: 'G', homeCode: 'T', awayTeamId: 501, homeTeamId: 502, away: '讀賣巨人', home: '阪神虎' },
  KBO: { awayCode: 'LG', homeCode: 'KT', awayTeamId: 603, homeTeamId: 605, away: 'LG雙子', home: 'KT巫師' },
  CPBL: { awayCode: 'ACN011', homeCode: 'ADD011', awayTeamId: 701, homeTeamId: 702, away: '中信兄弟', home: '統一7-ELEVEn獅' },
});

function rawGame(definition) {
  return {
    awayCode: definition.awayCode,
    homeCode: definition.homeCode,
    boardDate,
    boardTime: '10:00',
    marketStatus: 'open',
    fullRunline: { lineSide: 'away', line: '1平', awayWater: 0.95, homeWater: 0.95 },
    fullTotal: { line: '8平', overWater: 0.94, underWater: 0.94 },
    first5Runline: { lineSide: 'home', line: '0.5', awayWater: 0.93, homeWater: 0.93 },
    first5Total: { line: '4平', overWater: 0.92, underWater: 0.92 },
  };
}

function signedPayload(league, definition, overrides = {}) {
  const payload = {
    version: 'TAI888-READER-DOM-v2.1.0',
    readerVersion: '2.1.0 FOUR LEAGUE TABS',
    league,
    sourceHost: 'www1.tai888.in',
    pageUrl: 'https://www1.tai888.in/newapp/#/BS',
    boardDate,
    observedAt,
    pageActivityAt,
    expectedGameCount: 1,
    detectedGameCount: 1,
    games: [rawGame(definition)],
    ...overrides,
  };
  payload.payloadHash = createHash('sha256').update(canonicalReaderPayload(payload)).digest('hex');
  return payload;
}

const normalizedByLeague = new Map();
for (const [league, definition] of Object.entries(leagues)) {
  const payload = signedPayload(league, definition);
  const schedule = [{
    league,
    gamePk: definition.awayTeamId * 1000 + definition.homeTeamId,
    gameDate,
    gameNumber: 1,
    ...definition,
  }];
  const normalized = normalizeTai888ReaderPayload(payload, schedule, {
    league,
    deviceId: 'four-league-reader-test',
    receivedAt,
  });
  normalizedByLeague.set(league, normalized);
  assert.equal(normalized.league, league);
  assert.equal(normalized.games.length, 1);
  assert.equal(normalized.games[0].league, league);
  assert.equal(normalized.games[0].game.league, league);
  assert.equal(normalized.games[0].source.league, league);
  assert.equal(normalized.games[0].markets.length, 8);
  assert.deepEqual([...new Set(normalized.games[0].markets.map(row => row.market))].sort(), ['上半大小', '上半讓分', '全場大小', '全場讓分']);
  assert.equal(readerSnapshotIsComplete(normalized), true);
}

assert.equal(new Set([...normalizedByLeague.values()].map(row => row.payloadHash)).size, 4, 'normalized hash must bind league');
assert.equal(new Set(Object.entries(leagues).map(([league, definition]) => rawTai888ReaderPayloadHash(signedPayload(league, definition)))).size, 4, 'raw hash must bind league');

// Live Tai888 uses short/legacy MLB aliases such as ATH, WAS, SF, TB and KC.
// The Reader hashes those exact wire codes, while the server maps them to the
// official team ID only after the claimed payload hash has been authenticated.
const liveAliasDefinition = {
  awayCode: 'ATH', homeCode: 'KC', awayTeamId: 133, homeTeamId: 118,
  away: '運動家', home: '堪薩斯市皇家',
};
const liveAliasPayload = signedPayload('MLB', liveAliasDefinition);
const liveAliasResult = normalizeTai888ReaderPayload(liveAliasPayload, [{
  league: 'MLB', gamePk: 133118, gameDate, gameNumber: 1, ...liveAliasDefinition,
}], { league: 'MLB', deviceId: 'live-alias-reader-test', receivedAt });
assert.equal(liveAliasResult.games.length, 1, 'Tai888 ATH/KC wire aliases must pass the Reader payload hash gate');
assert.equal(liveAliasResult.games[0].gamePk, 133118);

const downgradedNpb = signedPayload('NPB', leagues.NPB, {
  version: 'TAI888-READER-DOM-v2.0.3',
  readerVersion: '2.0.3',
});
assert.throws(
  () => validateTai888ReaderEnvelope(downgradedNpb, { league: 'NPB', receivedAt }),
  error => error?.status === 426,
);

const legacyMlb = {
  ...signedPayload('MLB', leagues.MLB),
  version: 'TAI888-READER-DOM-v2.0.3',
  readerVersion: '2.0.3',
  payloadHash: '0'.repeat(64),
};
delete legacyMlb.league;
assert.equal(validateTai888ReaderEnvelope(legacyMlb, { league: 'MLB', receivedAt }).league, 'MLB');

const badHash = { ...signedPayload('KBO', leagues.KBO), payloadHash: 'f'.repeat(64) };
assert.throws(
  () => validateTai888ReaderEnvelope(badHash, { league: 'KBO', receivedAt }),
  error => error?.status === 409 && /payloadHash/.test(error.message),
);

const unknownAlias = signedPayload('CPBL', { ...leagues.CPBL, awayCode: 'ZZZ999' });
assert.throws(
  () => normalizeTai888ReaderPayload(unknownAlias, [{ league: 'CPBL', gamePk: 1, gameDate, ...leagues.CPBL }], { league: 'CPBL', receivedAt }),
  /球隊代碼不支援/,
);

const crossLeagueAlias = signedPayload('NPB', { ...leagues.NPB, awayCode: 'BOS', homeCode: 'TOR' });
assert.throws(
  () => normalizeTai888ReaderPayload(crossLeagueAlias, [{ league: 'NPB', gamePk: 2, gameDate, ...leagues.NPB }], { league: 'NPB', receivedAt }),
  /球隊代碼不支援/,
);

assert.throws(
  () => normalizeTai888ReaderPayload({ ...signedPayload('MLB', leagues.MLB), league: 'NFL' }, [], { league: 'NFL', receivedAt }),
  error => error?.status === 400 && /聯盟/.test(error.message),
);

console.log('Reader 2.1.0 multi-league parser: four aliases, 4 markets/8 directions, league-bound hashes and fail-closed gates ok');
