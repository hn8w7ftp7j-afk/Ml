# NBA opening totals v3 — bounded model improvement

## Scope and prior evidence

Production 11.10.28 keeps failed full/half totals unscored. The earlier v2
development comparison improved whole-season errors and probability calibration
but failed early-season MAE. On development 2021, its early prediction bias was
larger than mature-game bias. This experiment changes the model, not its gate.
Existing spread predictions, Taiwan-credit settlement, rebate, S thresholds,
current quote authority and manual records are outside this change.

## Frozen development protocol

The protocol compares 9 candidates per target: prior weights 10/20/40 crossed
with league-centered regression, prior-only phase-bias correction, and separate
phase regressions. An early game requires both teams to have fewer than ten
earlier regular games. Every feature excludes the entire target date; model
coefficients and bias estimates use only closed earlier seasons.

Phase bias is estimated from the raw kernel's earlier prequential errors in the
same phase, time-weighted with a 365-day half-life and a zero-bias prior of 120
weighted observations. It is not an arbitrary constant chosen to pass a test.
The phase-aware predictive distribution uses candidate-matched, same-phase
innovations centered by their prior weighted error mean, avoiding double-counted
old bias after the point forecast has already been corrected.

All candidates use an identical canonical prior-weight-20 baseline and its
phase-independent earlier-season distribution. Development comparisons use the
same event and probability cohorts. Minimums remain 1,000 overall, 100 early and
1,000 probability observations. Whole MAE, early MAE, Brier and Log Loss must
each be no worse than the benchmark, without rounding or tolerance in the gate.

Protocol SHA256:
`241ae48469febe96b667b2175f745a8e6246ad90391a129953c70c0a05aee028`.

## Development-only selection and holdout lock

Development year 2021 has 1,080 common observations, including 144 early games.
Each target independently selects prior weight 10 / phase-bias-centered kernel
by passing all gates, then minimizing Brier, Log Loss and early MAE in that order.
The selected development metrics are retained in
`nba-opening-v3-development.json` and `nba-opening-v3-selection.json`.

Selection SHA256:
`9983c154d42c243aa7c247fb52ec3530e0ec169c86cfc5b4c27ef49eee2c27c0`.
Protocol, implementation and selection were committed before real 2022 holdout
evaluation in commit `a3afa83b1871cfbf5a358c2ceb5bdd61c96aae9e`.

Only those two frozen candidates can reach 2022 evaluation. The evaluator checks
the pinned source archive and exactly replays development selection first.
After a holdout failure, this experiment cannot select another candidate or
retune against that holdout. Development success alone does not activate scores.

## Evidence limits

The 5,829-game 2018–2022 archive is checked against the reviewed 941-source pin,
all 30 team schedules per season and actual quarter sums. Historical final
scores are retrospective source records, not proof of contemporaneous pregame
availability. Reference-threshold Brier/Log Loss are not recovered bookmaker
quotes, actual betting win rates or a guarantee of profitability. Personnel,
confirmed starters and projected minutes remain outside this model.

## Reproduction

```sh
node scripts/nba-opening-v3-test.mjs
node scripts/nba-opening-v3.mjs --development
node scripts/nba-opening-v3.mjs --lock-selection
node scripts/nba-opening-v3.mjs --holdout
```

The holdout result is recorded separately in `nba-opening-v3-holdout.json`.
Production integration requires a passing independent holdout, current-archive
regression review, exact runtime/replay consistency and full CI. Research code
does not import into or override production scoring automatically.

## Actual frozen holdout result — blocked

The independently retained 2022 season has 1,230 observations, including 143
early games. Both frozen candidates improve whole-season MAE, Brier and Log Loss,
but fail early MAE. These are different observations from the 2021 development
cohort; the numeric errors must not be interpreted as a same-cohort before/after.

| Target | Whole MAE model / baseline | Early MAE model / baseline | Brier model / baseline |
| --- | --- | --- | --- |
| Full total | 15.1467 / 15.3525 | 17.5507 / 17.4666 | 0.245886 / 0.249702 |
| Half total | 10.1650 / 10.2768 | 10.6965 / 10.5944 | 0.246766 / 0.249253 |

The holdout is now consumed. No alternative candidate was evaluated on 2022,
no threshold was relaxed, and no production total model was replaced or enabled.
The experiment stops with `BLOCKED_HOLDOUT_FAILED`; the 2023–2026 archive was not
used to search for a passing replacement. Existing spread scoring is untouched.
New research would require a declared new protocol and genuinely independent
validation evidence, not reusing 2022 as an unseen test after tuning against it.

## Cross-runtime replay, not a model-gate tolerance

The initial full CI run exposed a Node 22 / Node 24 floating-point serialization
difference in three development diagnostics (maximum absolute delta
`1.2094492074510299e-14`). Candidate identities, selected candidates, sample
counts and every acceptance decision were identical. The selected candidates'
development metrics were unchanged; a raw hash of all diagnostics was too strict
for portable numerical replay.

The original development, selection and consumed-holdout JSON remain byte-pinned
and are never overwritten by replay commands. The current calculation is checked
against that immutable evidence. Only floating metric fields can differ within
64 machine epsilons, scaled by magnitude. Counts, sources, candidate IDs, hashes,
selection, PASS/FAIL and reasons must still match exactly. A meaningful metric
change is rejected. This numerical check is **not** used by model acceptance:
all gates still evaluate raw values with no tolerance. Tests explicitly reject
changed sample counts, statuses, reasons, hashes or early-MAE changes.
