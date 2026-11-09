# Minutes lookback development diagnostic

**BACKFILLED_DEVELOPMENT_DIAGNOSTIC — non-OOS.** `modelEffect=false`, `accepted=false`, `formalEligible=false`. The three candidates are 14, 28 and 42 days; **no winner is selected**. This evidence does not approve a new model, production lookback, total-return-error method or acceptance gate.

## Reproduce

From this research branch's repository root, run:

```bash
node research/soccer/minutes-lookback-development/replay.mjs --verify
```

The command reads retained files and verifies the committed aggregate report without writing any product file. Tested with Node v24.22.1; no npm install or network is needed. For an additional report outside the repository, use a new path:

```bash
node research/soccer/minutes-lookback-development/replay.mjs --verify --output /tmp/minutes-lookback-rerun.json
```

`--root /path/to/repository` is available for an external copy of this runner. Source hash mismatches stop execution. Inputs are pinned to base commit `9456b84a18ee850456dd5b3b83d7b73b887126d8`; the runner does not depend on a moving main. The files added by this branch contain no raw provider response or player identity list.

## Scope and method

- Sources are the four existing compressed history/personnel files referenced in `protocol.json`, plus six pinned implementation modules. They are retained ESPN extraction projections, not proof of historical pregame availability.
- Records starting on or after 2025-01-01 are excluded **before V2 normalization**. Compressed files and the existing frozen artifact are loaded, but 2025 labels and metrics do not enter fitting, evaluation or candidate selection.
- Training uses games with `startTime + 24h < 2024-01-01`; development uses 2024 starts with `startTime + 24h < 2025-01-01`. Each development feature may use chronologically earlier development observations, under the existing assumed 24-hour result lag. Actual historical publication times are unverified.
- The existing builder, normalization, feature cells, last-three-prior-match rule, model fitting, baseline and reconciliation are reused. Only the builder's lookback argument is changed in an in-memory module. The 14-day rows must exactly match the original builder. The production code and model remain unchanged.
- Each candidate temporarily refits the same model algorithm. Fixed shrinkage is EPL 20 / UCL 100, copied from the existing artifact's already selected 2024 development value. This repeats development research; it is neither prospective preregistration nor untouched OOS.
- Metrics first average candidate players within each real game, then weight games equally. RMSE is the square root of the equally weighted per-game mean squared error. Zero target probability yields `POSITIVE_INFINITY` with a null numeric log loss, never a clipped finite value. Own-cohort finite metrics are checked against the existing evaluator.
- `allOwnCohort` includes each candidate's own players and games, so denominators change. `commonPairedCohort` uses the intersection of player/game/team keys across all three candidates. Predictions and full-team reconciliation happen **before** that intersection is applied. Unseen appearing players remain coverage omissions, not fabricated candidate predictions.

## Aggregate development results

These are retained usable corpus counts, not claims of a complete official season. Full own-cohort, baseline and paired metrics are in `report.json`.

### UCL

2024 usable population: 130 games / 260 team targets. Common paired cohort: 39 games / 1,451 player targets.

| Lookback days | Evaluated games | Both sides available | Available team targets | Candidate player targets | Unseen appearing players |
|---:|---:|---:|---:|---:|---:|
| 14 | 39 | 28 | 67 | 1,451 | 3,010 |
| 28 | 101 | 100 | 201 | 4,383 | 1,112 |
| 42 | 104 | 102 | 206 | 4,821 | 950 |

| Lookback days | Paired model MAE | Paired model RMSE | Paired Log Loss | Paired Brier | Paired baseline MAE |
|---:|---:|---:|---:|---:|---:|
| 14 | 27.673484 | 33.127356 | 0.830967 | 0.475125 | 21.369257 |
| 28 | 27.589693 | 33.200589 | 0.831333 | 0.475364 | 21.406761 |
| 42 | 26.573432 | 32.476263 | 0.805257 | 0.458906 | 21.283012 |

Longer windows restore many previously missing UCL team targets. At 28 days, paired RMSE and probability metrics slightly worsen. At 42 days they improve relative to 14 days in this reused development cohort; model MAE still exceeds baseline MAE in every candidate. These observations do not establish an approved improvement.

### EPL isolation comparison

2024 usable population: 372 games / 744 team targets. Common paired cohort: 338 games / 13,954 player targets.

| Lookback days | Evaluated games | Both sides available | Available team targets | Candidate player targets | Unseen appearing players |
|---:|---:|---:|---:|---:|---:|
| 14 | 338 | 324 | 662 | 13,954 | 1,676 |
| 28 | 362 | 362 | 724 | 16,349 | 668 |
| 42 | 362 | 362 | 724 | 16,667 | 608 |

| Lookback days | Paired model MAE | Paired model RMSE | Paired Log Loss | Paired Brier | Paired baseline MAE |
|---:|---:|---:|---:|---:|---:|
| 14 | 23.764196 | 29.947808 | 0.736985 | 0.412846 | 18.033147 |
| 28 | 23.397847 | 29.618924 | 0.725141 | 0.405376 | 19.010941 |
| 42 | 23.379233 | 29.590800 | 0.724402 | 0.404884 | 19.229428 |

EPL and UCL observations, training fits, models and metrics stay separate. Shared infrastructure does not pool league targets.

## Limits and next decision

The 21-day UCL gap explains an important coverage failure of the fixed 14-day same-league lookback. This study measures that mechanism on retained 2024 data; it does not measure current Production coverage or certify a new window. Adding old squad players can mechanically change own-cohort error, and the paired cohort excludes newcomers absent from every candidate. A longer history can introduce stale participation after transfers, role changes, injury or competition breaks; wider coverage alone cannot settle accuracy.

A proposed production change still needs explicit approval, a prospectively frozen candidate/selection rule, an independent future evaluation period with complete omission counts, consistent baseline and paired/game weighting, calibration and drift checks, and league-specific review. No 2025 holdout score or winner selection is supplied here. Zero acceptable candidates remains a valid outcome.

`provenance.json` records source, implementation, protocol and report hashes. The portable runner exactly reproduced the original temporary diagnostic's results; packaging changed only metadata and the path-independent transformed-source hash.
