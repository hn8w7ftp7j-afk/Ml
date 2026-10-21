# NBA opening totals V5: current-season distribution location

V4 improved opening MAE but failed half-total probability calibration in the
already-viewed 2022 season. The failure was concentrated in mature games:
predicted over probability averaged 0.44598 against observed 0.55106, and the
model underestimated points by 2.6008. The closed-season residual shape did not
update its location as the current season changed. V5 addresses this distribution
calibration separately from the locked V4 point forecast.

## One fixed candidate per target

Full and half totals each retain the exact V4 point prediction, point error and
MAE. Their predictive distribution center is explicit and may differ from that
point forecast. Before a date begins, current-season V4 point errors from
strictly earlier dates are summed and divided by `120 + count`. This location
adjustment starts at zero each season and pools both early and mature prior
games. Full and half labels/state never mix.

The distribution shape uses matching target, V5 candidate/version, phase and
the previous three closed seasons. Its V4 point errors are centered at their
365-day weighted mean, then added to the V4 point plus current location. Every
arbitrary quote is evaluated using this same rounded-score distribution; there
is no independent fit or constant chosen for one market line. The baseline
remains the canonical prior-20, phase-independent comparator.

There is no parameter search and no gate change. Each target must pass whole
MAE, opening MAE, Brier and Log Loss in both viewed development seasons, with
the original minimums of 1000 games, 100 early games and 1000 probability
observations. Raw comparisons have zero tolerance. Cross-runtime diagnostic
replay allows only machine-scale numerical differences, never changed counts,
candidate identity, reasons or acceptance decisions.

Protocol SHA256:
`6ca134f6db97ade0d45a4029255307743eb7f094875baf053fb5e75112caeb50`.

Development-selection SHA256:
`00ce57501c9da5c2e4ced47571a7437c8a577c9074172139a3f85f27a5ba8269`.

## Recorded development outcome

Both targets pass all four comparisons in viewed 2021 and 2022. No alternate
candidate was evaluated. Point MAEs remain identical to V4.

| 2022 metric | Full model | Full baseline | Half model | Half baseline |
| --- | --- | --- | --- | --- |
| Whole MAE | 15.187586 | 15.352524 | 10.212487 | 10.276803 |
| Early MAE | 16.811279 | 17.466607 | 10.457627 | 10.594371 |
| Brier | 0.238499 | 0.249702 | 0.245343 | 0.249253 |
| Log Loss | 0.670005 | 0.692551 | 0.684024 | 0.691653 |

Development is not independent validation. The V3 consumed 2022 holdout remains
unchanged and cannot become unseen again.

## New external validation boundary

The proposed fresh validation is season 2017, with its own 2013–2016 strictly
earlier training archive. Its protocol, implementation and development selection
must be committed before any 2017 predictive metrics are calculated. Only the
two frozen candidates may be evaluated. A failure ends this experiment; no
selection or tuning from 2017 is permitted.

This is external backward-era retrospective validation, not prospective OOS or
proof of historical pregame capture. Complete raw-source and quarter-score audit
is required before evaluation. Reference thresholds are not recovered bookmaker
quotes or actual betting performance. Current 2023–2026 comparisons are viewed
regressions only. V5 cannot activate production W/R/S until all applicable
evidence, runtime parity and integration checks have been reviewed.

## Shared runtime contract and reproduction

`totalsV5AsOfRow` accepts a score-free V4 point row. `totalsV5Distribution` reads
only prior observations, returning separate `pointPrediction`, predictive
`center`, current location metadata and transformed residuals (with date/year).
The same residuals support arbitrary-threshold CDF and Taiwan-credit payoff
evaluation. The retrospective probability helper uses this exact CDF.

```sh
node scripts/nba-opening-v5-test.mjs
node scripts/nba-opening-v5.mjs
```

The runner never evaluates the 2017 holdout. `--write-development` can create
new development evidence once, but refuses to overwrite existing files.

## Recorded frozen external result

Protocol and development selection were pushed before the first 2017 predictive
evaluation in commit `9da9bd40f32be4705ad44e01cbac7f45d7fa97c7`.
Full totals improve whole MAE, Brier and Log Loss, but early MAE is
13.753046633 versus baseline 13.731360428 and fails the raw gate. Half totals
pass all four comparisons (early MAE 8.946273468 versus 9.170958895).
The full report is retained unchanged in `nba-opening-v5-independent.json`.
The 2017 holdout is consumed; this experiment cannot select or retune afterward.

Viewed 2023–2026 regressions also expose remaining early-point weaknesses:
full totals fail early MAE in 2023, 2025 and 2026; half totals fail in 2023 and
2025. These failures are recorded in `nba-opening-v5-regression.json`.
V5 remains unpromoted, with its production adapter's validation pin unset.
