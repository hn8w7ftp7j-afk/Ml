# Explicit future return-error research calendars

Chosen on 2026-11-08 before these training windows close. This is research
configuration for the existing game-block realized-return-error method, not a
model change, uncertainty acceptance, or permission to publish formal W/R/S.

All boundaries are UTC and assign whole real games by kickoff:

| League | From | Training before | Calibration before | Test before |
| --- | --- | --- | --- | --- |
| EPL | 2026-11-09 | 2026-11-25 00:00Z | 2026-12-08 00:00Z | 2026-12-23 00:00Z |
| UCL | 2026-11-09 | 2026-11-30 00:00Z | 2027-01-23 00:00Z | 2027-01-30 00:00Z |

The EPL calendar uses the officially scheduled 21–23 November round for
training (10 scheduled games), the following three rounds through 6 December
for calibration (30), and the 12–21 December rounds for testing (20). Closing
calibration on 8 December leaves approximately 87 hours before the first test
game's ordinary 24-hour collection window starts. The last scheduled training
and test matches have more than one day for result checks before their window
closes. These are population counts, not eligible observed samples.

The UCL calendar uses matchday 5 on 24/25 November for training (18 scheduled
games), matchdays 6 and 7 on 8/9 December and 19/20 January for calibration
(36), and matchday 8 on 27 January for testing (18). The January 23 boundary
leaves about 92 hours before January 26 at 20:00Z, the final round's normal
24-hour pregame collection window. Training/calibration have multiple days
for their final source-result crosschecks. The calendars were chosen from
published future fixtures, not tuned to subsequent outcomes.

Official sources checked on 2026-11-08:

- Premier League, [All 380 fixtures for 2026/27](https://www.premierleague.com/en/news/4675097/all-380-fixtures-for-season-2026-27).
- UEFA, [2026/27 Champions League dates and format](https://www.uefa.com/uefachampionsleague/news/02a6-20d57cfcd03e-407c22a7f465-1000--2026-27-champions-league-teams-draws-format-final/).
- UEFA, [League-phase fixtures and kick-off times](https://www.uefa.com/uefachampionsleague/news/02a8-2174c9e9019d-f909a77bd77a-1000--champions-league-league-phase-fixtures-by-team/).

The existing method, grouping, economic-price selection and miscoverage 0.1
are unchanged. Its exact candidate-template hash is pinned in the server plan.
Each league/period/variant/exact-model/rule-family/market/side group needs at
least one training game and nine exact-return calibration games for a finite
order statistic. That is the existing mathematical support condition, not an
acceptance sample threshold. Multiple prices or directions cannot multiply
independent game counts. Missing or bounded-only observations remain separate.

Registration uses the existing immutable store and actual database clock.
Neither a declaration here nor a JSON timestamp is a registration receipt.
Cron and the existing authenticated collect action can register only this fixed
server-owned plan. They read back the complete per-league protocol inventory
and exact original receipt. A conflicting existing plan fails closed. An
already registered exact plan keeps its ID and timestamp after training closes;
an unregistered late plan is refused. No automatic date change or backdating
is allowed. A timeout is NOT_VERIFIED, and retry reads any actual durable row.

The normal 24-hour collector is separated from freeze time by the stated gaps.
An earlier manual Reader forecast or a changed fixture can still violate
pretest chronology. Existing first-valid-price selection and pretest receipt
checks must then report the incompatibility; never drop the early observation,
move a cutoff after seeing results, or manufacture an untouched test. Future
schedule changes require renewed diagnostics and, if necessary, a distinct
prospectively registered experiment rather than editing these immutable plans.

The first complete research windows can close on December 23 (EPL) and January
30 (UCL). Missing eligible samples, delayed/corrected results or absent pretest
freezes can still prevent a complete test. Neither date promises formal model
acceptance: realized single-game return error includes outcome noise and does
not estimate conditional EV model misspecification. All acceptance/execution
flags remain false and formal W/R/S remain null.

The v1 point fitter can use analytically resolved TOTAL returns. HANDICAP returns
with a nonzero certified tail interval remain bounded observations and never
enter that point fitter, however many are collected. A closed calendar does
not promise a fitted error radius for every market or direction.
