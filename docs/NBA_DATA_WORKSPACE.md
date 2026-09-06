# NBA data workspace

This module adds `/nba` and authenticated `/api/nba` to the existing Next.js application and Vercel project. The home league bar opens the same workspace in a native dialog. The original home component stays mounted, including during NBA loading and errors. No second site, database or deployment target is created.

## Boundary

Only the framework, authentication, rate-limit utility and site navigation are shared. NBA identities, adapters, caches, QA, historical research and UI live in `lib/nba`, `app/api/nba` and `app/nba`. NBA is deliberately absent from the baseball `LEAGUE_IDS` registry, whose consumers assume baseball semantics. Existing wagering, Reader, ranking, EV/S, settlement and performance implementations are unchanged. NBA exposes no wagering endpoints or recommendation output.

Client storage uses `sports-data:nba:v1:*`. Cache keys include view, identifier, selected season, season type and Taiwan date. In-flight results are saved under their own key and cannot replace another visible tab. A failed, blocked or partially failed refresh preserves an existing successful screen. There is no interval-driven refresh. Entering an expired screen revalidates without clearing it. NBA error boundaries never clear baseball storage.

## Provider evidence and contracts

Ordinary HTTP probes on 2026-09-06 returned 403 from NBA CDN schedule, scoreboard and boxscore JSON URLs. That establishes a restriction on the tested access path; it does not establish its internal cause or universal NBA unavailability. No access-control circumvention is used. NBA's public schedule, statistics and official injury-report entry remain visible source links. NBA official IDs and 2026–27 official injury feeds are explicitly pending verification.

The current secondary provider is ESPN. Public accessibility is not a contractual SLA or a redistribution license. Adapters record exact request URL, retrieval time, source publication time when supplied, SHA-256 hash, cache age and provider role. Retrieval time is never presented as an injury report's publication time. Sources without publication timestamps remain unknown.

| Data | Endpoint pattern | Verification evidence |
| --- | --- | --- |
| Schedule/results | `site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=YYYYMMDD&limit=1000` | 15 games for Taiwan 2026-04-13; valid empty result for 2026-09-06 |
| Teams | Same NBA base, `/teams?limit=1000` | 30 teams |
| Game/boxscore/actual starters | Same NBA base, `/summary?event=401811042` | WAS at CLE; 22 players; two teams and five actual starters per team |
| Roster | Same NBA base, `/teams/5/roster?season=2026` | 18 players; labeled current roster, not historical membership |
| Team season statistics | Same NBA base, `/teams/5/statistics?season=2026` | 46 statistics; requested season checked independently of provider's current-season metadata |
| Injuries | Same NBA base, `/injuries?limit=1000` | 75 reports; record timestamps retained and older reports flagged |
| Team history | Same NBA base, `/teams/5/schedule?season=2026&seasontype=2` | 82 completed Cleveland regular-season games |
| Player profile | `site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/4066328` | Jarrett Allen; athlete ID and NBA league verified |
| Player season statistics | Player profile URL plus `/stats?season=2026` | 43 selected-season statistics; career rows filtered by requested season and type |

ESPN statistics responses sometimes omit an embedded athlete ID. The paired profile verifies identity, while the statistics are explicitly labeled as bound to the validated request URL, not independently identity-verified payloads. Multi-team totals remain separate from individual team rows.

## Identity, time and quality

- Namespaced keys: `nba:espn:game:*`, `nba:espn:team:*`, `nba:espn:player:*`. ESPN IDs are never substituted for NBA official IDs.
- The schedule reads neighboring source dates and filters by the exact `Asia/Taipei` calendar date. UTC/offset timestamps, original calendar validity, competition/league, team uniqueness and game identity are validated before caching.
- Injury identities include the verified player. Provider sentinel report IDs cannot collide across players. Missing/old report timestamps and unconfirmed official injury status are explicit.
- Historical summaries can contain today's injury feed. It is excluded from historical game context. Actual postgame starters are labeled postgame; they are not treated as pregame announcements. Missing expected starters remain missing.
- Every history event must match the requested season and season type. Preseason, regular season and postseason are independent queries and research populations.
- QA uses PASS/WARNING/BLOCK. Unknown official IDs, missing advanced features and absent historical snapshots are warnings. Identity/schema conflicts block affected data. Missing values remain null; they are not replaced by zero.
- Server requests use a fixed HTTPS NBA endpoint allowlist, timeouts, response size limits, bounded LRU storage and request coalescing. Stale fallback is age-bounded and allowed for transport failure only. Invalid schema/identity responses never become stale successes. Client calls use the existing authenticated same-origin API with separate NBA rate limits.

## Historical Shadow research

`analyzeNbaHistory` is a descriptive expanding-history team-score baseline, not a completed basketball prediction model. It reports aggregate MAE, RMSE and bias from completed historical games. Training uses strictly earlier Taiwan dates, never the validation day's other games. Seasons and season types cannot mix. Duplicate conflicts block the dataset; malformed scores cannot become training examples.

Residual interval coverage is an empirical historical diagnostic after sufficient prior errors, not proof of calibrated future probabilities. These public historical endpoints do not establish when each old record became available, so the report explicitly sets `pointInTimeReplay: false`. Injury/lineup/on-off historical snapshots and a validated full basketball feature model remain pending. No future game score, joint market distribution, EV/S, rank or betting action is emitted.

## Verification

`npm run test:nba` executes data/cache counterexamples, historical chronological validation and API/client integration tests. Existing behavioral assertions remain unchanged; release-identity assertions track the new site version and synchronized lockfile metadata. The existing `npm test` suite runs first; its posttest now also invokes NBA tests. Fixtures are synthetic unless a live-source probe is specifically described; synthetic fixtures are never presented as observed NBA games or market evidence.

Release gates: complete `npm test`, `npm audit --omit=dev --audit-level=high`, `npm run build`, main synchronization, existing Vercel project deployment and actual browser checks. Production testing must distinguish executed data/navigation actions from untouched wagering operations. A build pass alone does not establish provider availability, UI usability, or full historical calibration.
