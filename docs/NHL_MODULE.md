# NHL data and historical Shadow module

This module is part of the existing Next.js app and Vercel Production project. `/nhl` and `/api/nhl` share the existing login, layout, navigation and infrastructure. NHL is intentionally not passed through the baseball `LEAGUE_IDS`, first-five-inning provider, eight-direction analysis or four-league ticket tables. Returning to an existing league uses `/?league=...` and its existing persisted workspace.

## Shipped data architecture

- `lib/nhl/data.js`: official Schedule, club season schedule, Gamecenter landing, Boxscore, play-by-play, Roster, Player and club player statistics. Every acquired response has a source URL, fetch time and SHA-256 fingerprint. Missing source publication time remains null. Bounded retries, timeout, request deduplication, 403/429 negative caching and allowlisted HTTPS endpoints are explicit.
- `identity.js`: independently validates NHL game/season/type, teams, players, timezone-bearing start time and goalie membership/confirmation evidence. Duplicate identity conflicts are quarantined.
- `context.js`: nullable scoped statistics, personnel timestamp QA, goalie revision/change/freshness logic, verified schedule coverage before formal rest/B2B/density output. Venue-to-venue travel requires coordinate evidence; it is not inferred from team names.
- `cache.js`: isolated NHL runtime/memory namespace, TTL, deduplication and defensive copies. Cross-league payloads are rejected. The browser separately stores NHL boards and details under `sports:nhl:workspace:v1`; loading flags are never persisted and refresh failures preserve prior results.
- `store.js` and migration `0009`: additive immutable `sports_nhl_snapshots_v1` source versions, with explicit write success/failure. Existing baseball tables are untouched. It uses the existing durable database configuration and has no in-memory substitute for permanent records.
- The UI has manual load controls, loading/error/empty states, Taipei/US Eastern/official dates, period/regulation/final results, official goalie roster and time on ice (including unused backups at 00:00), player statistics, available 5v5/PP/SH event counts and source versions. Injury, line combinations, defensive pairs and pregame goalies remain unknown without timestamped evidence; final Boxscore appearances never become pregame confirmation.

## Sources and factual gaps

### Personnel, expanded history and research UI (11.9.11 — pending release)

This section describes implemented working-tree code, **not an assertion that
11.9.11 has been merged, deployed or passed Production acceptance**. Final
coverage, test execution and deployment evidence are recorded separately in
`NHL_11_9_11_VALIDATION.md` after the release candidate is frozen.

`personnel-feed.js` reads the NHL editorial lineup article for the requested
season. Its NewsArticle publication/update timestamps, canonical URL and exact
dated away/home matchup are checked before any player rows are attached to a
game. The authenticated `action=personnel&gameId=...` uses the existing game
identity layer, official season rosters and same-team/season/phase club player
statistics. Exact normalized full-name joins retain numeric player IDs and all
identity-source URLs, acquisition times and content hashes. Club participation
can resolve a historical player missing from today's season roster; it is not
misrepresented as a roster archived before that historical game.

The personnel response separates projected forward lines, defensive pairs,
listed goalies, reported injuries and projected scratches. An unresolved injury
or scratch name remains in `unresolvedAvailability`, outside the verified player
catalog, with visible QA BLOCK. Valid independently checked rows stay visible.
An ambiguous projected-line/goalie identity quarantines the affected team.
No fuzzy ID guess, unreported diagnosis or inferred healthy status is inserted.
The dated 2026-06-14 CAR–VGK article is retained as a **factual extract**, not a
raw archived article or historical PIT snapshot. Its goalie evidence is
PROJECTED; synthetic confirmation tests do not prove a live CONFIRMED observation.

Only an explicit affirmative current-game start statement can promote a goalie
to CONFIRMED. Conditional, projected, negated, different-day or different-game
phrases cannot do so. Original publication, last article revision, article body
acquisition and roster identity acquisition remain separate. Freshness uses
the article's available revision time, not the most recent refresh click.
Semantic revisions ignore unrelated article markup and acquisition-only changes;
goalie-player changes and confirmation-status changes are reported separately.
Final Boxscores never provide pregame confirmation.

`personnel-observation.js` validates the complete nested catalog, exact team
ownership, source proofs and completion times before `store.js` writes immutable
PERSONNEL observations. `action=personnel-versions&gameId=...` reads those
versions. A successful HTTP read or browser cache is not permanent persistence:
each response exposes `observation.persisted`, and missing database configuration
makes the version endpoint fail explicitly. A rolling article for a different
date/game returns `NO_MATCHING_GAME`, no attached personnel and no fabricated
goalie version; it does not fetch unnecessary rosters. Source errors and 403/429
remain explicit, with bounded requests and negative caching rather than an
empty-success response or an authorization bypass.

`client-workspace.js` extends the existing NHL browser display snapshot with
personnel, rest/context, roster and team-summary records. Bounds and keys are
separate for each section and season phase; foreign league/identity records are
rejected. Late requests persist their validated result directly and notify a
remounted NHL view, so leaving the route during a request does not require an
unmounted React state update to save its result. Merging preserves newer source
revisions and live results over older archives. Loading flags are never saved;
storage errors remain visible. This is device-local display state, not the
immutable source archive, a shared ledger or a server background-job guarantee.

The expanded 2023–24 working-tree outcome corpus contains the official recorded
1,312 regular-season games across 32 teams, verified from the official standings
and individual club schedules rather than an assumed schedule size. **Outcome
coverage is separate from period, PBP, personnel and xG coverage.** Complete
regulation-period paths and the PBP research corpus are still being completed
and audited for this pending release; use the final coverage manifests, not this
paragraph, for their eventual counts. Regular season, playoffs and preseason
remain distinct. `history-validation.js` hashes and cross-checks the bundled
outcome/period corpora, coverage and benchmark/model reports; missing or changed
reports cannot fall back to a claim that the small engineering corpus is a
full-season validation.

`action=research` now exposes expanded-history evidence and independent
`shot-research.js` results beside the original small engineering corpus. The
score benchmark and existing NHL period-path model have separately identified
48-hour-embargo chronological walk-forward and frozen training/validation/test
partitions. Every fold retains training scope; a reliability table or completed
corpus does not certify predictive calibration. Historical personnel snapshots
remain absent where not captured at the time, and strict historical PIT and
Production model calibration flags remain false.

The independent shot model uses NHL's observed unblocked-shot coordinates,
distance/angle and shot type, separated into 5v5, PP, PK and other even-strength
contexts. The observed goal label is an outcome, never an input feature. Its
regularized binomial fit is explicit training regularization, not an EV or
probability cap. Frozen research artifacts retain training/source hashes and
temporal cutoffs. The reported `researchXGF`, `researchXGA` and share concern only
eligible observed shots: **they are neither NHL-published xG nor a pregame shot
volume/score forecast**. Missing 5v5 exposure or a documented high-danger
definition does not become invented per-60/high-danger data. The model's held-out
errors and exclusions remain visible, including results worse than a baseline.
No MoneyPuck scraping or wagering-core change is introduced by this work.

### Official team season statistics (11.9.10)

`team-summary.js` and authenticated `action=team-summary` acquire NHL's
`api.nhle.com/stats/rest/en/team/summary` with explicit team ID, consecutive
season ID, game type, non-aggregate season mode and a bounded row count.
Source query identity, exact row cardinality, team/season identity and numeric
integrity are checked before display. This endpoint omits gameTypeId in its
rows, so phase provenance is explicitly the exact official request scope.
Regular season, playoffs and preseason use separate cache and UI keys.

The team page exposes official wins/losses/OT losses/points, goals for/against,
per-game goal and shot rates, PP/PK and faceoff fractions. Empty official rows
are EMPTY, not a zero record; malformed or conflicting data return HTTP 422.
Missing metrics remain null with WARNING. Failed refreshes retain existing
results; concurrent phase requests and repeated clicks are tested against the
actual UI handlers. In 11.9.10 these team summaries were page-session data. The
pending 11.9.11 workspace change adds bounded device-local display persistence;
neither version describes these summaries as permanent source observations.

The retained NSH 2023–24 regular-season fixture was fetched from the official
URL on 2026-09-06T17:43:13.041Z (HTTP 200): 82 GP, 47 W, 30 L, 5 OTL, 99 points,
PP 0.215613 and PK 0.769231. It is a real season-total response, not a
contemporary pregame snapshot. Season summaries never enter strict historical
PIT training. No rounded shot rates are converted to exact shot totals; no
goalie save percentages, 5v5 rates, xG or high-danger data are fabricated from
all-situation season totals. Existing player totals remain separately labelled.

### Official game reports and situation statistics (11.9.7)

The same game-details request now additionally acquires NHL's official
`gamecenter/{id}/right-rail`. The requested game must appear exactly once in
`seasonSeries` with matching season, type, teams and start time. Other series
games and series wins are not imported, avoiding future-outcome leakage.
Validated game-specific PP goals/opportunities provide PP and opponent-derived
PK percentages. Zero opportunities yield null percentages. Official scratches
retain NHL player/team IDs, source and observation time, but no invented injury
reason, publication time or pregame confirmation. Duplicate players, an active
player listed as scratched, malformed ratios and conflicting game identities
block this optional report while preserving independently valid game results.

PBP situation statistics now pair PP against the opponent's PK and 5v5 against
5v5 for shots against, goals against, saves, shot share and descriptive shooting
and team save percentages. Unknown situations suppress ratios, not manufacture
zeros. These are observed-event ratios, not per-60 rates or verified pregame
features. Duplicate conflicting event IDs block the event statistics.

Actual official 2023020001 PBP revealed that a blocked-shot event belongs to
the shooting team and can be explicitly `teammate-blocked`. Both player IDs are
resolved against the game roster. Defensive blocks, blocked shooting attempts
and teammate blocks are distinct; unresolved actor identity leaves those totals
null. The retained 328-event official response and right-rail response are real
historical fixtures, acquired on 2026-09-06, not contemporary pregame snapshots.
The source responses are retained verbatim as JSON evidence, with SHA-256 in
`scripts/fixtures/nhl/observed-report-provenance.json`.

The 11.9.7 release did not enable injury, projected/confirmed-goalie,
line-combination, xG or 5v5 exposure-time feeds. Its wagering, scoring,
settlement, calibration and model formulas were unchanged. The pending 11.9.11
personnel and independent research additions are described separately above.

Official live adapters use `https://api-web.nhle.com/v1/`: `schedule/{date}`, `club-schedule-season/{team}/{season}`, `gamecenter/{id}/landing`, `.../boxscore`, `.../play-by-play`, `roster/{team}/{season}`, `player/{id}/landing`, and `club-stats/{team}/{season}/{type}`. Upstream errors are displayed, not converted to successful empty boards. An unavailable historical game can use only the exact archived official sample and must display the original acquisition time and archive warning. Archived samples never replace a live schedule.

Club statistics are individual player totals, not team possession rates. Raw play-by-play can supply situation event counts, but does not itself supply official xG, high-danger classification, 5v5 exposure minutes or PP opportunity counts. Missing official metric fields remain null. The pending independent observed-shot research outputs are separately labelled and do not fill those fields as if supplied by NHL. MoneyPuck is not automatically scraped or enabled without a suitable permitted data arrangement. A new season alone does not resolve these source gaps.

## Historical research and mathematics

`historical-samples.js` contains 20 traceable official games across 2023–24 and 2024–25: 17 regulation decisions, 2 OT and 1 SO. This remains a separate incomplete engineering regression corpus; two samples additionally contain official player/goalie Boxscores. It is not used as the count or coverage certificate for the pending expanded full-season outcome corpus.

`model.js` fits a conditional empirical linked-path distribution from NHL historical games. Each path retains all three regulation periods and its OT/SO outcome; marginals share the same probability measure. Fitted feature scaling/bandwidth and chronological provenance are retained. There are no baseball model constants, artificial score caps, independent per-market probabilities or fabricated goalie adjustments. Synthetic fixtures are rejected by default and explicitly marked when enabled in unit tests.

`research.js` exposes reproducible 48-hour-embargo retrospective walk-forward evidence. On the initial corpus there are 14 folds, regulation Brier 1.096412786470624 and paired-score MSE 6.727176982008731. Strict historical point-in-time validation has zero folds because contemporary availability snapshots were not obtained. These results do **not** establish calibrated predictive performance. Injury/lineup/goalie, travel and xG features are not silently treated as verified pregame data.

`npm run nhl:download-history -- --help` describes the resumable official historical acquisition command. It validates checkpoints and reports partial coverage and upstream failures; an incomplete run does not pass as a full-season download.

## Reader and locked core

NHL Reader capture uses the existing paired-device authentication plus device-ID matching, separate NHL raw source snapshots and a strict market identity contract. The verified NHL market manifest is empty. The visible status is **等待真實 Tai888 NHL 盤驗證**. No Tai888 page route, selector, market type, OT/SO or void rule is guessed. There is no new NHL live bet-writing endpoint or recommendation control.

Pure contract/math modules test common-distribution payoff derivation, unknown-rule blocking and symbolic original/final contract comparison. They reuse existing Taiwan payoff semantics and fixed scoring; missing real contract-specific OOS payoff calibration leaves Robust EV/S unavailable. Existing 150-per-10,000 rebate, S system, Reader role and betting rules are unchanged.

The cross-review also fixed an existing settlement data bug: null/blank official scores must not become zero, and first-five completion needs explicit evidence. True official 0 scores remain valid. This does not revise historical ledger entries or change settlement rules.

## Verification commands

### Source integrity repair (11.9.2)

Source-cache hits, misses and coalesced reads return independent deep copies so
consumer mutations cannot alter another request or the retained source hash.
Rosters containing a missing ID, duplicate player ID across position groups,
or contradictory `id`/`playerId` now return `NHL_ROSTER_IDENTITY_INVALID` with
BLOCK/HTTP 422; invalid players are not silently omitted from a successful
roster. Normalized runtime cache uses namespace v2 to avoid reusing pre-fix
rosters. No wagering, settlement, scoring, model or database schema changes.
The data and API tests include pre-fix failing counterexamples for these cases.

`npm run test:nhl` runs data, identity/timezone, goalie/context/cache, independent score distribution, contract mathematics, actual historical evidence and authenticated API integration tests. API fixtures are isolated tests; they are never represented as Production acquisition.

`npm test` includes all existing MLB/NPB/KBO/CPBL tests and the NHL suite. `npm run build` builds the same Production app. `npm audit --omit=dev --audit-level=high` is the existing dependency gate. Production verification must additionally exercise the actual deployed routes, league navigation, data loading, persistence, error handling and console/runtime state. A successful build alone is not an end-to-end PASS.

NBA was added concurrently in main cdc0d03 (PR #165), followed by hydration fix 341fa7f (PR #167) and safely merged into this release before deployment. Its complete data/research/API tests run alongside NHL in npm test. NHL also exposes the existing NBA dialog entry. This module does not create or deploy a second website, repository or Vercel project.
