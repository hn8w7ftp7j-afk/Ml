# Observed On/Off reconstruction

## v2 correction — 2026-09-07 UTC

The v1 investigation below is historical and its unresolved-attribution conclusion is superseded for the three archived samples. The root cause was our attribution logic, not proven bad source data: free-throw plus-minus belongs to the lineup at the originating foul, while actual playing time continues to follow substitution events. See the primary implementation documentation for [pbpstats FreeThrow.event_for_efficiency_stats](https://pbpstats.readthedocs.io/en/latest/_modules/pbpstats/resources/enhanced_pbp/free_throw.html). Defensive three-seconds is also a technical-foul origin ([NBA Rule 10](https://official.nba.com/rule-no-10-violations-and-penalties/)).

`nba-observed-on-off-v2` snapshots those lineups and links each free throw to the preceding matching foul class, same period/clock, opposing team, identified shooter and consecutive complete attempt sequence. It does not move events, change minutes, replace box-score numbers or relax the exact plus-minus comparison. Unknown/repeated/incomplete attempts, unmatched origins and identity conflicts remain BLOCK. Exceptional source corrections or replacement attempts require explicit support and are not guessed. This remains descriptive research, not an official NBA possession-normalized statistic or a Shadow-model input.

All three previously acquired real samples now pass every available player plus-minus comparison with no tolerance. The v1 engine stopped at the first discrepancy; the defects were not limited to one player or one point. Full normalized event/box-score subsets (excluding wagering fields) are retained in `scripts/fixtures/nba-onoff-*.json`, with the original response hashes and observed date, not fabricated publication timestamps. Tests include these three real regressions as well as separate synthetic missing-foul, wrong-clock/team/shooter, missing/duplicate/incomplete-trip, substitution-between-shots and technical-foul cases. UI exposes the event-to-foul attribution IDs for inspection.

Acceptance is now **THREE_ARCHIVED_SAMPLES_RECONCILED**; it is not broad league/season certification, official On/Off integration, prospective injury/lineup verification or physical-device/Production UI certification. No new sample download was needed for this correction.

## Historical v1 investigation (superseded where noted above)

`nba-observed-on-off-v1` is independent, descriptive, completed-game research. It consumes the already fetched ESPN summary; no additional Production source request, database, wagering operation or model coefficient is introduced. It is not NBA's official possession-normalized On/Off and is not used by the current Shadow model.

The engine verifies NBA/game/player/team identity, five known starters per side, duplicate/revised event identities, each period's actual clock length, every period-end and final score, substitution membership and entering/leaving names, DNP contradictions, five-player time totals, score-attribution totals, and each supplied player plus-minus. Overtime uses five extra minutes per verified period. Missing denominators remain null. No probability, score, rate or QA discrepancy is capped or patched to fit.

Successful output includes observed on/off seconds, team points for/against during those intervals, plus-minus and explicitly labeled net points per 48 minutes. Those rates are not per 100 possessions and do not identify a causal player effect. Missing box-score plus-minus is a warning and never marked independently verified. Contradictions BLOCK the entire optional reconstruction and return no player metrics. The independently validated game and box score remain visible; `data.onOff.qa` is explicitly rendered and `availability.playerOnOff` is blocked. The data/QA view also warns that this feature was not passed to the model.

## Actual source investigation (2026-09-06 UTC)

Three ordinary ESPN summary downloads succeeded. These are actual source counterexamples, not synthetic test successes:

| ESPN game | Original response SHA-256 | Result |
| --- | --- | --- |
| 401811042 | 51d90ebcbabbb4d5830cf28acb543d5ba64832076b81eb320cdc513e3f328535 | BLOCK: Jamir Watkins reconstructed -11 versus box-score -10 |
| 401809234 | a07091627e1be5050a04373c09d5f4d7063d7368f29f60ed2f88b7bc04fc36f4 | BLOCK: Jarrett Allen reconstructed -5 versus box-score -4 |
| 401809944 | aea4357d9f9cf8a30f7cded09f7b607e77baab5869aa6f59d037abbaebe96f2b | BLOCK: Jarrett Allen reconstructed 23 versus box-score +24 |

URLs use `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=<game>`. The first game contains 459 events and 45 substitutions; membership continuity alone passes but does not establish scoring attribution. A concrete adapter error was found and fixed: event sequence 167 is an editorially inserted first-quarter event at 1:17, placed before sequence 148 at 1:13 in the actual response. Sorting IDs moves it after the quarter-end. The engine now preserves the provider array and verifies chronological clock and score transitions instead of assuming identifier order.

The remaining one-point differences are not resolved. Free-throw/substitution ordering is a hypothesis, not a proven repair. In the first sample, the third-quarter 3:33 first free throw, two substitutions and second free throw also have distinct wall-clock timestamps; moving them solely to match plus-minus would be unjustified. The source's total player plus-minus does reconcile with five times the team margin in all three samples, so the issue is individual attribution rather than merely the overall score. This release retains BLOCK rather than moving events, replacing numbers, ignoring a player or loosening tolerances.

An attempted fourth sample was cancelled by the platform's network authorization flow. It was not retried or treated as acquired. No claim of full real-data On/Off validation is made.

The NBA CDN schedule JSON returned HTTP 403 with an Access Denied / edgesuite response. Its undisclosed access rule is not a JSON parser error, and no bypass was attempted. The official 2025–26 injury-report page and one archived PDF were accessible, but official report-row/identity/time ingestion remains pending.

## Reproduction and tests

`node scripts/nba-on-off-probe.mjs <previously-acquired-summary.json>` performs read-only reconstruction and prints the original file hash, returning nonzero for unavailable/BLOCK. It does not fabricate source publication/retrieval timestamps or fetch another URL.

`node scripts/nba-on-off-test.mjs` uses explicitly synthetic fixtures for mathematical and adversarial tests: five-player time conservation, substitution attribution, late event IDs, duplicates/conflicts, missing input, foreign identities, malformed/reversed clocks, truncation, one-point discrepancies, missing independent plus-minus, DNP and overtime. These tests validate software behavior, not real-source accuracy. The NBA API suite also verifies optional On/Off BLOCK cannot erase independently verified scores.

## Release boundary

The implemented parser, QA, API data contract and UI are usable for inspection, but actual On/Off metric acceptance is **WAITING_VERIFIED_EVENT_ATTRIBUTION**. No reconstructed values are shown for the three conflicting samples. Full official On/Off, causal player impact, historical pregame injury/lineup snapshots, broad calibration and physical-device testing are not certified by this release.
