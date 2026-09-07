# NBA evidence checkpoint — 11.9.20

## Implemented

- Authenticated on-demand NBA official schedule/box-score crosswalk. Exact UTC start, season type, home/away IDs, final and period scores, unique same-game/same-team player name and (where available) points are checked. Provider IDs remain unchanged; official IDs are separate evidence. Conflicts fail closed and missing matches stay partial. Real 0022500003 fixture covers 26 players.
- Append-only pregame observation store, independent `sports_nba_pregame_v1` table using the existing durable database configuration. Only server-captured, source-hashed observations obtained before confirmed start are accepted. No historical backdating, no official-lineup inference, no automatic model promotion. Capture is manual, not a background scheduler. Read/write failures are not shown as saved.
- Recovered official injury PDF for WAS–CLE on 2026-04-12: 19 player/status facts, pages 6–7, exact game/team/time guard and source hash. Downloaded after the game; explicitly NOT a contemporaneous pregame snapshot. PDF header timezone remains unverified; normalized publishedAt is null.
- Actual CLE 2025–26 regular-season replay: 82 summaries fetched, 82 usable, zero failed. Frozen normalized input and output are in `nba-shadow-cle-2026-evidence.json`. 67 walk-forward validation cases; MAE 10.3351 vs same-fold baseline 9.5153. Model is NOT better than baseline and remains in research. Interval evaluation has 47 cases. This is one team/season, not league-wide, cross-season or probability calibration.
- Date input handles input/change with strict calendar validation; restored date is validated too. Existing mobile breakpoints and league isolation remain.

## Validation boundaries

Unit/API tests cover identity conflicts, unavailable official sources, pregame timestamps, missing evidence, postgame rejection, authentication, NBA-only IDs, and cross-origin POST rejection. Full regression and production deployment are separately checked in the release workflow.

Do not infer a live durable capture success from unit tests or an empty archive read. A future scheduled game with real pregame sources is required for that acceptance case. Physical iOS/Android calendar behavior is not established by a desktop/narrow CSS viewport check. Full calibration acceptance still requires additional point-in-time features, teams/seasons and independent validation; this release does not claim that acceptance.
