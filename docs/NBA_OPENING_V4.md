# NBA opening totals v4: reset seasonal calibration

V3 passed development but failed independent 2022 early MAE. That result stays
unchanged. Its early signed errors showed that a calibration learned from closed
seasons did not transfer reliably into a new season. V4 changes the model rather
than the four acceptance thresholds.

## Fixed experiment

There is one candidate for each of full total and half total. Existing reviewed
prior-weight-10 team features and the previous-three-closed-season ridge slope
are reused. The old fitted intercept is discarded. The opening prediction is
the contemporaneous league estimate plus the fitted team deviation. A seasonal
correction starts at zero and learns the mean **raw** forecast error from earlier
dates of the current season, with 120 zero-error prior observations. Using raw
errors avoids feeding the same correction back into itself. All games on a date
are predicted before any results on that date update the state. Full and half
corrections have separate labels and state.

The existing league prior (120 games), ridge penalty (1000), prior weight (10),
calibration half-life (365 days) and phase cutoff (both teams under 10 games)
remain fixed. Probability innovations come from this version's own predictions
in the same phase of closed prior seasons and are centered on their prior mean.
The comparator retains its independent canonical prior-20 all-phase distribution.
There is no hyperparameter search, target-specific exception or gate tolerance.

Protocol hash: `0e95ea0df2b35bb02917e2e905e267418dd6a58ae40dc361e35cd38f455737fe`.

## Evidence boundary

2021 and 2022 are now **viewed development data**, including the previously
consumed V3 holdout. Their results can diagnose this new approach; even if every
historical gate passes, they cannot independently authorize production scores.
The reviewed 2018–2022 archive and source checks are unchanged. Retrospective
records do not establish historical pregame access. Reference thresholds are
not recovered bookmaker odds or evidence of betting profitability.

The model must be frozen and registered before a new independent pregame
collection starts. That collection must persist source snapshots and forecasts
before tipoff, record all eligible games (including failures), settle against
final scores, and preserve the original minimums (1000 games, 100 early games,
1000 probability observations) and all four error comparisons. A changed model
requires a new version and fresh evidence. This retrospective runner does not
collect those future forecasts, and must report zero independent samples.

No production import or W/R/S activation is introduced. There is no deployment.

## Recorded development result

2021 has 1080 games (144 early); 2022 has 1230 (143 early). Both targets pass
all four comparisons in 2021. In the already-viewed 2022 data, full totals pass
all four comparisons, while half totals improve MAE but fail probability losses.

| 2022 metric | Full V3 | Full V4 | Full baseline | Half V3 | Half V4 | Half baseline |
| --- | --- | --- | --- | --- | --- | --- |
| Whole MAE | 15.1467 | 15.1876 | 15.3525 | 10.1650 | 10.2125 | 10.2768 |
| Early MAE | 17.5507 | 16.8113 | 17.4666 | 10.6965 | 10.4576 | 10.5944 |
| Brier | 0.245886 | 0.244290 | 0.249702 | 0.246766 | 0.249653 | 0.249253 |
| Log Loss | 0.684930 | 0.681612 | 0.692551 | 0.686673 | 0.692550 | 0.691653 |

Season-reset adaptation improves early point errors on this development cohort
at the cost of slightly worse whole-season MAE than V3. Half probability errors
also worsen. This is a measured tradeoff, not a completed calibration repair.
No second candidate was tried after these results and no coefficients or
thresholds were changed to turn a failure into a pass. The status is
`BLOCKED_DEVELOPMENT_AND_INDEPENDENT_VALIDATION`. The next model change needs to
address half probability calibration and then obtain genuinely independent data.

## Reproduction

```sh
node scripts/nba-opening-v4-test.mjs
node scripts/nba-opening-v4.mjs
```

`--write` creates a development report only if it does not already exist. It
cannot overwrite an earlier result. The tests replay recorded metrics, verify
the gates without numerical tolerance and check that later or same-date labels
cannot influence an earlier forecast. Tiny cross-runtime numerical replay
differences do not modify acceptance decisions.
