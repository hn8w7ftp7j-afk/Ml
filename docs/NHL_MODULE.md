# NHL data and historical Shadow module

This module is part of the existing Next.js app and Vercel Production project. `/nhl` and `/api/nhl` share the existing login, layout, navigation and infrastructure. NHL is intentionally not passed through the baseball `LEAGUE_IDS`, first-five-inning provider, eight-direction analysis or four-league ticket tables. Returning to an existing league uses `/?league=...` and its existing persisted workspace.

## Shipped data architecture

- `lib/nhl/data.js`: official Schedule, club season schedule, Gamecenter landing, Boxscore, play-by-play, Roster, Player and club player statistics. Every acquired response has a source URL, fetch time and SHA-256 fingerprint. Missing source publication time remains null. Bounded retries, timeout, request deduplication, 403/429 negative caching and allowlisted HTTPS endpoints are explicit.
- `identity.js`: independently validates NHL game/season/type, teams, players, timezone-bearing start time and goalie membership/confirmation evidence. Duplicate identity conflicts are quarantined.
- `context.js`: nullable scoped statistics, personnel timestamp QA, goalie revision/change/freshness logic, verified schedule coverage before formal rest/B2B/density output. Venue-to-venue travel requires coordinate evidence; it is not inferred from team names.
- `cache.js`: isolated NHL runtime/memory namespace, TTL, deduplication and defensive copies. Cross-league payloads are rejected. The browser separately stores NHL boards and details under `sports:nhl:workspace:v1`; loading flags are never persisted and refresh failures preserve prior results.
- `store.js` and migration `0009`: additive immutable `sports_nhl_snapshots_v1` source versions, with explicit write success/failure. Existing baseball tables are untouched. It uses the existing durable database configuration and has no in-memory substitute for permanent records.
- The UI has manual load controls, loading/error/empty states, Taipei/US Eastern/official dates, period/regulation/final results, actual goalie appearances, player statistics, available 5v5/PP/SH event counts and source versions. Injury, line combinations, defensive pairs and pregame goalies remain unknown without timestamped evidence; final Boxscore appearances never become pregame confirmation.

## Sources and factual gaps

Official live adapters use `https://api-web.nhle.com/v1/`: `schedule/{date}`, `club-schedule-season/{team}/{season}`, `gamecenter/{id}/landing`, `.../boxscore`, `.../play-by-play`, `roster/{team}/{season}`, `player/{id}/landing`, and `club-stats/{team}/{season}/{type}`. Upstream errors are displayed, not converted to successful empty boards. An unavailable historical game can use only the exact archived official sample and must display the original acquisition time and archive warning. Archived samples never replace a live schedule.

Club statistics are individual player totals, not team possession rates. Raw play-by-play can supply situation event counts, but does not itself supply xG, high-danger classification, 5v5 exposure minutes or PP opportunity counts. These metrics are null until an appropriate source is connected. MoneyPuck is not automatically scraped or enabled without a suitable permitted data arrangement. A new season alone does not resolve these source gaps.

## Historical research and mathematics

`historical-samples.js` contains 20 traceable official games across 2023–24 and 2024–25: 17 regulation decisions, 2 OT and 1 SO. This is an incomplete engineering corpus; two samples additionally contain official player/goalie Boxscores.

`model.js` fits a conditional empirical linked-path distribution from NHL historical games. Each path retains all three regulation periods and its OT/SO outcome; marginals share the same probability measure. Fitted feature scaling/bandwidth and chronological provenance are retained. There are no baseball model constants, artificial score caps, independent per-market probabilities or fabricated goalie adjustments. Synthetic fixtures are rejected by default and explicitly marked when enabled in unit tests.

`research.js` exposes reproducible 48-hour-embargo retrospective walk-forward evidence. On the initial corpus there are 14 folds, regulation Brier 1.096412786470624 and paired-score MSE 6.727176982008731. Strict historical point-in-time validation has zero folds because contemporary availability snapshots were not obtained. These results do **not** establish calibrated predictive performance. Injury/lineup/goalie, travel and xG features are not silently treated as verified pregame data.

`npm run nhl:download-history -- --help` describes the resumable official historical acquisition command. It validates checkpoints and reports partial coverage and upstream failures; an incomplete run does not pass as a full-season download.

## Reader and locked core

NHL Reader capture uses the existing paired-device authentication plus device-ID matching, separate NHL raw source snapshots and a strict market identity contract. The verified NHL market manifest is empty. The visible status is **等待真實 Tai888 NHL 盤驗證**. No Tai888 page route, selector, market type, OT/SO or void rule is guessed. There is no new NHL live bet-writing endpoint or recommendation control.

Pure contract/math modules test common-distribution payoff derivation, unknown-rule blocking and symbolic original/final contract comparison. They reuse existing Taiwan payoff semantics and fixed scoring; missing real contract-specific OOS payoff calibration leaves Robust EV/S unavailable. Existing 150-per-10,000 rebate, S system, Reader role and betting rules are unchanged.

The cross-review also fixed an existing settlement data bug: null/blank official scores must not become zero, and first-five completion needs explicit evidence. True official 0 scores remain valid. This does not revise historical ledger entries or change settlement rules.

## Verification commands

`npm run test:nhl` runs data, identity/timezone, goalie/context/cache, independent score distribution, contract mathematics, actual historical evidence and authenticated API integration tests. API fixtures are isolated tests; they are never represented as Production acquisition.

`npm test` includes all existing MLB/NPB/KBO/CPBL tests and the NHL suite. `npm run build` builds the same Production app. `npm audit --omit=dev --audit-level=high` is the existing dependency gate. Production verification must additionally exercise the actual deployed routes, league navigation, data loading, persistence, error handling and console/runtime state. A successful build alone is not an end-to-end PASS.

NBA was added concurrently in main cdc0d03 (PR #165), followed by hydration fix 341fa7f (PR #167) and safely merged into this release before deployment. Its complete data/research/API tests run alongside NHL in npm test. NHL also exposes the existing NBA dialog entry. This module does not create or deploy a second website, repository or Vercel project.
