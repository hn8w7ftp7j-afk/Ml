# NBA opening totals diagnostics and research — 11.10.28

## Root cause

The production archive has enough 2026 validation games (1,230 overall, 145
early, 1,230 probability checks). Both total models nevertheless fail three
existing release checks: early-season MAE, Brier and Log Loss. Full-season MAE
passes. This is a model-quality rejection, not a missing total line, an unfinished
analysis, or simply too few same-season games.

The old job badge described process completion and did not describe per-market
validation. A second defect discarded the opening result when only failed totals
were quoted, leaving the same-season warmup explanation visible instead.

## Production changes

- Return scoped per-market validation checks with values, baselines, samples,
  status and reason codes from the existing gate.
- Preserve diagnostics and quoted markets when no quoted opening market passes.
  Such results stay insufficient, nonexecutable and unpersisted to the forward
  capture ledger.
- Show partial market readiness on both the NBA league badge and game card, with
  expandable validation evidence. Bind coverage to the recovered date/run and
  preserve that binding across Reader quote reloads. Keep missing
  quotes, invalid contracts, source failures and validation failures distinct.
- Preserve accepted spread estimates, W/R/S, rebate, settlement, candidate
  thresholds, source identity guards and all existing validation thresholds.

No production total model is promoted by these changes. A visible score is not
manufactured to conceal a failed validation.

## Bounded totals research

`lib/nba/opening-research.js` defines separate full- and half-total selection,
three fixed candidate kernels, prior-date league-environment features and
candidate-matched prequential residual calibration. It is not imported by the
production model. Development selects on common event/probability cohorts;
missing probability evidence cannot select a candidate.

The protocol was frozen before evaluating the newly acquired 2022 retrospective
holdout: development 2021, holdout 2022, previously viewed 2023–2026 regression
only. The source archive must independently satisfy complete season, 30-team
schedule and quarter-score cross-checks. The runner remains nonexecutable and
nonpromoting even after a passing comparison; promotion requires separate source,
model, integration and no-regression review. Retrospective score archives do not
establish contemporaneous pregame capture or historical bookmaker win rates.

The research archive now contains 5,829 complete 2018–2022 regular games,
cross-checked against 150 team schedules and 791 daily scoreboards (941 source
hashes). Season counts are 1,230 / 1,230 / 1,059 / 1,080 / 1,230. Every actual
quarter sequence sums to the final score; no missing halves are synthesized.
`prepare-nba-opening-research-history.mjs` revalidates the raw checkpoints before
packaging the research-only module. Archive SHA256:
`0885775b75c4901a65a2261330918bbef387e3e623a7d1d3c45e9d4e7f4a1b49`.

The v2 protocol corrects a development comparator defect found before real
holdout evaluation: all candidates now share the same phase-independent,
prior-weight-20 reference residual pool. Candidate kernels did not change.
Its frozen protocol hash is
`e05fedb0d480e057d89df085918ba9894c8f2d579c74c52e238a9fabed7a57a4`.

## Actual research result

`docs/nba-opening-totals-research.json` records the reproducible comparison.
Source verification passes for all five years. Development 2021 has 1,080 common
point/probability observations and 144 early games per target. The centered
candidate improves full-season MAE, Brier and Log Loss for both targets, but still
fails early MAE:

| Target | Full MAE model / baseline | Early MAE model / baseline | Brier model / baseline |
| --- | --- | --- | --- |
| Full total | 14.9211 / 15.0340 | 15.6055 / 15.5341 | 0.246688 / 0.251013 |
| Half total | 9.7115 / 9.7576 | 9.6944 / 9.6725 | 0.248055 / 0.252357 |

No candidate satisfies all predeclared development checks. Selection remains
null and the 2022 predictive holdout is **not evaluated**. This is not a passing
new model, and the production total acceptance flags remain false. The smaller
early-MAE difference is not a reason to relax or round away the locked gate.

## Reproduction

```sh
npm run test:nba-opening-diagnostics
npm run nba:opening-research -- /absolute/path/to/verified/archive.json
npm run test:nba
npm test
npm run build
```

Release/Production verification is recorded only after the exact deployed commit
has completed CI and interactive checks. Local test success alone is not a claim
that totals are restored or Production has passed.
