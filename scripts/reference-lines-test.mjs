import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  filterReferenceGamesToTargets,
  normalizeJbotReference,
  normalizeOddsApiReference,
  ODDS_API_EVENT_MARKETS,
  REFERENCE_LINES_VERSION,
  referenceProviderStatus,
} from '../lib/reference-lines.js';

const schedule = [{
  gamePk: 123,
  gameDate: '2026-08-11T23:07:00Z',
  away: '波士頓紅襪',
  home: '多倫多藍鳥',
  awayEnglish: 'Boston Red Sox',
  homeEnglish: 'Toronto Blue Jays',
}];

const jbot = normalizeJbotReference({
  status: 'OK',
  data: [{
    id: 'TW-1', time: '2026-08-12T07:07', away: '波士頓紅襪', home: '多倫多藍鳥',
    odds: [{
      update: '2026-08-12T04:55:00+08:00',
      handi: { '-1.5': { a: 1.82, h: 1.68, m: true } },
      total: { '8.5': { o: 1.72, u: 1.78, m: true } },
    }],
  }],
}, schedule);
assert.equal(jbot.games.length, 1);
assert.deepEqual(jbot.games[0].markets.map(row => row.pick), [
  '波士頓紅襪受讓1.5', '多倫多藍鳥讓1.5', '大8.5', '小8.5',
]);
assert.deepEqual(jbot.games[0].markets.map(row => row.water), [0.82, 0.68, 0.72, 0.78]);
assert.ok(jbot.games[0].markets.every(row => row.sourceType === 'REFERENCE' && row.executable === false));

const unsafeUnpairedJbot = normalizeJbotReference({
  status: 'OK',
  data: [{
    id: 'TW-UNSAFE', time: '2026-08-12T07:07', away: '波士頓紅襪', home: '多倫多藍鳥',
    odds: [{
      update: '2026-08-12T04:55:00+08:00',
      handi: { '-1.5': { a: 1.20, h: 6.00, m: true } },
      total: { '8.5': { o: 1.20, u: 6.00, m: true } },
    }],
  }],
}, schedule);
assert.equal(unsafeUnpairedJbot.games.length, 0, 'the wider alternate range must not leak into a provider without paired-price validation');

const bookmaker = (key, lastUpdate, spreadAway, spreadHome, totalOver, totalUnder) => ({
  key,
  last_update: lastUpdate,
  markets: [
    { key: 'spreads', outcomes: [{ name: 'Boston Red Sox', point: 1.5, price: spreadAway }, { name: 'Toronto Blue Jays', point: -1.5, price: spreadHome }] },
    { key: 'totals', outcomes: [{ name: 'Over', point: 8.5, price: totalOver }, { name: 'Under', point: 8.5, price: totalUnder }] },
  ],
});

const odds = normalizeOddsApiReference([{
  id: 'ODDS-1', commence_time: '2026-08-11T23:07:00Z', away_team: 'Boston Red Sox', home_team: 'Toronto Blue Jays',
  bookmakers: [
    bookmaker('book-a', '2026-08-11T20:00:00Z', 1.91, 1.87, 1.90, 1.88),
    bookmaker('book-b', '2026-08-11T20:01:00Z', 1.89, 1.89, 1.88, 1.90),
    bookmaker('book-c', '2026-08-11T20:02:00Z', 1.93, 1.85, 1.92, 1.86),
  ],
}], schedule, { fetchedAt: '2026-08-11T20:02:30.000Z' });
assert.match(REFERENCE_LINES_VERSION, /v1\.3\.0/);
assert.equal(odds.games.length, 1);
assert.deepEqual(odds.games[0].markets.map(row => row.pick), [
  '波士頓紅襪受讓1.5', '多倫多藍鳥讓1.5', '大8.5', '小8.5',
]);
assert.ok(odds.games[0].markets.every(row => row.sourceType === 'INTERNATIONAL'));
assert.ok(odds.games[0].markets.every(row => row.consensusBookCount === 3), 'three distinct books must be retained as consensus evidence');
assert.ok(odds.games[0].markets.every(row => row.referenceEvidenceEligible === true), 'fresh synchronized three-book evidence must be explicitly eligible');
assert.ok(odds.games[0].markets.every(row => Number.isFinite(row.referenceNoVigProbability)));
assert.ok(odds.games[0].markets.every(row => Number.isFinite(row.referenceRobustProbability)));
assert.ok(odds.games[0].markets.every(row => row.referenceRobustProbability <= row.referenceNoVigProbability));
assert.ok(odds.games[0].markets.every(row => row.referenceBookProbabilities.length === 3));
assert.ok(odds.games[0].markets.every(row => row.referenceBookProbabilities.every(book => (
  Object.keys(book).sort().join(',') === 'bookmakerKey,observedAt,probability'
    && book.bookmakerKey
    && Number.isFinite(Date.parse(book.observedAt))
    && Number.isFinite(book.probability)
))), 'every signed reference row must retain serializable per-book probability evidence');
assert.ok(Math.abs(
  odds.games[0].markets.find(row => row.pick === '大8.5').referenceNoVigProbability
    + odds.games[0].markets.find(row => row.pick === '小8.5').referenceNoVigProbability
    - 1
) < 1e-8, 'paired no-vig consensus probabilities must complement each other');

const eventBookmaker = (key, lastUpdate) => ({
  key,
  last_update: lastUpdate,
  markets: [
    {
      key: 'spreads',
      outcomes: [
        { name: 'Boston Red Sox', point: 1.5, price: 1.91 },
        { name: 'Toronto Blue Jays', point: -1.5, price: 1.87 },
      ],
    },
    {
      key: 'alternate_spreads',
      outcomes: [
        { name: 'Boston Red Sox', point: 2.5, price: 1.20 },
        { name: 'Toronto Blue Jays', point: -2.5, price: 6.00 },
        { name: 'Boston Red Sox', point: 0.5, price: 2.70 },
        { name: 'Toronto Blue Jays', point: -0.5, price: 1.60 },
      ],
    },
    {
      key: 'totals',
      outcomes: [
        { name: 'Over', point: 8.5, price: 1.90 },
        { name: 'Under', point: 8.5, price: 1.88 },
      ],
    },
    {
      key: 'alternate_totals',
      outcomes: [
        { name: 'Over', point: 8, price: 1.20 },
        { name: 'Under', point: 8, price: 6.00 },
        { name: 'Over', point: 9, price: 6.00 },
        { name: 'Under', point: 9, price: 1.20 },
        // Individually plausible decimals are still rejected when the paired
        // overround is unreasonable.
        { name: 'Over', point: 7.5, price: 1.20 },
        { name: 'Under', point: 7.5, price: 1.20 },
      ],
    },
    {
      key: 'spreads_1st_5_innings',
      outcomes: [
        { name: 'Boston Red Sox', point: 0.5, price: 1.90 },
        { name: 'Toronto Blue Jays', point: -0.5, price: 1.88 },
      ],
    },
    {
      key: 'alternate_spreads_1st_5_innings',
      outcomes: [
        { name: 'Boston Red Sox', point: 1.5, price: 1.20 },
        { name: 'Toronto Blue Jays', point: -1.5, price: 6.00 },
      ],
    },
    {
      key: 'totals_1st_5_innings',
      outcomes: [
        { name: 'Over', point: 4.5, price: 1.91 },
        { name: 'Under', point: 4.5, price: 1.87 },
      ],
    },
    {
      key: 'alternate_totals_1st_5_innings',
      outcomes: [
        { name: 'Over', point: 4, price: 1.20 },
        { name: 'Under', point: 4, price: 6.00 },
      ],
    },
  ],
});

const eventOdds = normalizeOddsApiReference([{
  id: 'ODDS-EVENT-1',
  commence_time: '2026-08-11T23:07:00Z',
  away_team: 'Boston Red Sox',
  home_team: 'Toronto Blue Jays',
  bookmakers: [
    eventBookmaker('event-book-a', '2026-08-11T20:00:00Z'),
    eventBookmaker('event-book-b', '2026-08-11T20:01:00Z'),
    eventBookmaker('event-book-c', '2026-08-11T20:02:00Z'),
  ],
}], schedule, { fetchedAt: '2026-08-11T20:02:30.000Z' });
const eventMarkets = eventOdds.games[0].markets;
assert.equal(eventMarkets.length, 20, 'all valid full-game/F5 main and alternate line groups must survive normalization');
assert.equal(new Set(eventMarkets.map(row => `${row.market}/${row.pick}`)).size, eventMarkets.length, 'main and alternate feeds must not duplicate an identical contract');
assert.deepEqual(new Set(eventMarkets.map(row => row.market)), new Set(['全場讓分', '全場大小', '上半讓分', '上半大小']));
for (const contract of [
  '全場讓分/波士頓紅襪受讓2.5',
  '全場讓分/多倫多藍鳥讓0.5',
  '全場大小/大8',
  '全場大小/小9',
  '上半讓分/波士頓紅襪受讓1.5',
  '上半大小/大4',
  '上半大小/小4.5',
]) {
  assert.ok(eventMarkets.some(row => `${row.market}/${row.pick}` === contract), `missing event line group ${contract}`);
}
assert.ok(!eventMarkets.some(row => row.pick === '大7.5' || row.pick === '小7.5'), 'unsafe paired overround must be rejected');
assert.ok(eventMarkets.some(row => row.rawDecimalOdds === 6 && row.water === 5), 'safe alternate prices outside the old 1.50-2.50 range must be retained');
assert.ok(eventMarkets.every(row => row.referenceEvidenceEligible === true && row.referenceBookProbabilities.length === 3));
const overEight = eventMarkets.find(row => row.market === '全場大小' && row.pick === '大8');
const underEight = eventMarkets.find(row => row.market === '全場大小' && row.pick === '小8');
for (let index = 0; index < overEight.referenceBookProbabilities.length; index += 1) {
  assert.equal(overEight.referenceBookProbabilities[index].bookmakerKey, underEight.referenceBookProbabilities[index].bookmakerKey);
  assert.ok(Math.abs(overEight.referenceBookProbabilities[index].probability
    + underEight.referenceBookProbabilities[index].probability - 1) < 1e-8,
  'each bookmaker probability pair must complement before cross-book aggregation');
}
assert.deepEqual(ODDS_API_EVENT_MARKETS, [
  'spreads',
  'alternate_spreads',
  'totals',
  'alternate_totals',
  'spreads_1st_5_innings',
  'alternate_spreads_1st_5_innings',
  'totals_1st_5_innings',
  'alternate_totals_1st_5_innings',
]);

const targetFiltered = filterReferenceGamesToTargets([
  ...eventOdds.games,
  { ...eventOdds.games[0], gamePk: 999, game: { ...eventOdds.games[0].game, gamePk: 999 } },
], [{
  gamePk: 123,
  markets: [
    { market: '全場大小', pick: '大8+80' },
    { market: '上半讓分', pick: '多倫多藍鳥讓0/0.5+20' },
  ],
}]);
assert.equal(targetFiltered.length, 1, 'target filtering must exclude non-Reader games');
assert.deepEqual(new Set(targetFiltered[0].markets.map(row => row.market)), new Set(['全場大小', '上半讓分']));
assert.deepEqual(
  new Set(targetFiltered[0].markets.map(row => row.pick)),
  new Set(['大8', '小8', '大8.5', '小8.5', '波士頓紅襪受讓0.5', '多倫多藍鳥讓0.5']),
  'target filtering must retain both directions at the direct/adjacent half-lines and discard distant alternates',
);

const duplicateBookPayload = normalizeOddsApiReference([{
  id: 'ODDS-DUPLICATE', commence_time: '2026-08-11T23:07:00Z', away_team: 'Boston Red Sox', home_team: 'Toronto Blue Jays',
  bookmakers: [
    bookmaker('same-book', '2026-08-11T20:00:00Z', 1.91, 1.87, 1.90, 1.88),
    bookmaker('same-book', '2026-08-11T20:01:00Z', 1.89, 1.89, 1.88, 1.90),
    bookmaker('same-book', '2026-08-11T20:02:00Z', 1.93, 1.85, 1.92, 1.86),
  ],
}], schedule, { fetchedAt: '2026-08-11T20:02:30.000Z' });
assert.equal(duplicateBookPayload.games.length, 1);
assert.ok(
  duplicateBookPayload.games[0].markets.every(row => row.consensusBookCount === 1),
  'repeated rows from one bookmaker must count as one unique book, never as a three-book consensus',
);

const normalizeBooks = books => normalizeOddsApiReference([{
  id: 'ODDS-QUALITY', commence_time: '2026-08-11T23:07:00Z', away_team: 'Boston Red Sox', home_team: 'Toronto Blue Jays',
  bookmakers: books,
}], schedule, { fetchedAt: '2026-08-11T20:10:30.000Z' });
const marketsFor = payload => payload.games[0]?.markets || [];
const assertNoEligibleConsensus = (payload, label) => {
  const rows = marketsFor(payload);
  assert.ok(
    !rows.length || rows.every(row => row.referenceEvidenceEligible !== true),
    label,
  );
};

const staleBookPayload = normalizeBooks([
  bookmaker('fresh-a', '2026-08-11T20:10:00Z', 1.91, 1.87, 1.90, 1.88),
  bookmaker('fresh-b', '2026-08-11T20:09:00Z', 1.89, 1.89, 1.88, 1.90),
  bookmaker('stale-c', '2026-08-11T20:04:59Z', 1.93, 1.85, 1.92, 1.86),
]);
assertNoEligibleConsensus(staleBookPayload, 'a quote more than five minutes behind the freshest book must not complete a three-book prior');

const missingTimestampPayload = normalizeBooks([
  bookmaker('fresh-a', '2026-08-11T20:10:00Z', 1.91, 1.87, 1.90, 1.88),
  bookmaker('fresh-b', '2026-08-11T20:09:00Z', 1.89, 1.89, 1.88, 1.90),
  bookmaker('missing-time-c', '', 1.93, 1.85, 1.92, 1.86),
]);
assertNoEligibleConsensus(missingTimestampPayload, 'a bookmaker without its own timestamp must be excluded rather than inheriting fetchedAt');

const wideQuoteSpanPayload = normalizeBooks([
  bookmaker('span-a', '2026-08-11T20:10:00Z', 1.91, 1.87, 1.90, 1.88),
  bookmaker('span-b', '2026-08-11T20:08:00Z', 1.89, 1.89, 1.88, 1.90),
  bookmaker('span-c', '2026-08-11T20:06:59Z', 1.93, 1.85, 1.92, 1.86),
]);
assertNoEligibleConsensus(wideQuoteSpanPayload, 'book quotes spanning more than three minutes must fail closed');

const wideProbabilityRangePayload = normalizeBooks([
  bookmaker('range-a', '2026-08-11T20:10:00Z', 1.50, 2.50, 1.50, 2.50),
  bookmaker('range-b', '2026-08-11T20:09:30Z', 2.00, 2.00, 2.00, 2.00),
  bookmaker('range-c', '2026-08-11T20:09:00Z', 2.50, 1.50, 2.50, 1.50),
]);
assertNoEligibleConsensus(wideProbabilityRangePayload, 'a cross-book no-vig probability range above three percentage points must fail closed');

const inconsistentPairBooks = ['pair-a', 'pair-b', 'pair-c'].map((key, index) => ({
  key,
  last_update: `2026-08-11T20:0${9 - index}:00Z`,
  markets: [
    {
      key: 'spreads',
      outcomes: [
        { name: 'Boston Red Sox', point: 1.5, price: 1.91 },
        { name: 'Toronto Blue Jays', point: -2.5, price: 1.87 },
      ],
    },
    {
      key: 'totals',
      outcomes: [
        { name: 'Over', point: 8.5, price: 1.90 },
        { name: 'Under', point: 9.5, price: 1.88 },
      ],
    },
  ],
}));
const inconsistentPairPayload = normalizeBooks(inconsistentPairBooks);
assertNoEligibleConsensus(inconsistentPairPayload, 'spread opposites and total over/under must use the same paired line before consensus evidence is created');

const noProvider = referenceProviderStatus({});
const jbotOnly = referenceProviderStatus({ JBOT_API_TOKEN: 'x' });
const oddsOnly = referenceProviderStatus({ THE_ODDS_API_KEY: 'x' });
const bothProviders = referenceProviderStatus({ JBOT_API_TOKEN: 'x', THE_ODDS_API_KEY: 'x' });
assert.equal(noProvider.configured, false);
assert.equal(noProvider.consensusReady, false);
assert.equal(jbotOnly.configured, true, 'JBot is still a configured reference provider');
assert.equal(jbotOnly.primary, 'JBOT_TAIWAN_SPORTS_LOTTERY');
assert.equal(jbotOnly.consensusReady, false, 'JBot alone cannot satisfy the international three-book EV prior');
assert.equal(oddsOnly.primary, 'THE_ODDS_API_CONSENSUS');
assert.equal(oddsOnly.consensusReady, true);
assert.equal(bothProviders.configured, true);
assert.equal(bothProviders.consensusReady, true, 'The Odds API key makes consensus infrastructure ready even when JBot is also configured');

const healthRoute = fs.readFileSync(new URL('../app/api/health/route.js', import.meta.url), 'utf8');
assert.match(healthRoute, /referenceLinesEnabled:\s*referenceStatus\.consensusReady/, 'health readiness must mean V10.4 The Odds API consensus is actually available');
assert.match(healthRoute, /referenceConsensusReady:\s*referenceStatus\.consensusReady/, 'health must separately expose whether The Odds API consensus can be built');
assert.match(healthRoute, /anyReferenceProviderConfigured:\s*referenceStatus\.anyConfigured/, 'health must separately expose whether any non-qualifying reference provider is configured');

const referenceRoute = fs.readFileSync(new URL('../app/api/reference-lines/route.js', import.meta.url), 'utf8');
assert.match(referenceRoute, /events\/\$\{safeEventId\}\/odds/, 'targeted Reader contracts must use The Odds API per-event endpoint');
assert.match(referenceRoute, /targetByGamePk\.size\s*\?\s*oddsApiEventsUrl\(key, selectedWindow\)\s*:\s*oddsApiUrl\(key, selectedWindow\)/, 'targeted discovery must use the free event list and reserve bulk odds for the no-target fallback');
assert.match(referenceRoute, /targetByGamePk\.size\s*\?\s*targetedEvents/, 'a targeted event fetch must fail closed instead of falling back to featured main lines');
assert.match(referenceRoute, /filterReferenceGamesToTargets\(requestedGames, targets\)/, 'the route must bound alternate rows to Reader target contracts before signing');
assert.match(referenceRoute, /body\.targets\.length\s*&&\s*!targets\.length/, 'malformed or unverified targets must not silently downgrade to the no-target featured fallback');

console.log(JSON.stringify({
  ok: true,
  version: REFERENCE_LINES_VERSION,
  jbotMarkets: jbot.games[0].markets.length,
  oddsApiMarkets: odds.games[0].markets.length,
  consensusBooks: odds.games[0].markets[0].consensusBookCount,
  duplicateRowsUniqueBooks: duplicateBookPayload.games[0].markets[0].consensusBookCount,
}, null, 2));
