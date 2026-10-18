# Soccer score research v1

This directory is research evidence, not an approval to trade or a calibrated W/R/S model.

- Source: ESPN public soccer year scoreboards, EPL `eng.1`, UCL `uefa.champions`, UTC years 2021–2026. Source URLs, acquisition times, source hashes and per-year received/accepted counts are retained.
- `*-history.json.gz` losslessly retain the normalized accepted observations and the excluded-event denominator. They are **not** archives of every original ESPN response. Original provider responses can change.
- Accepted outcomes require an explicit full-time status, two regulation periods, internally consistent supplied statuses, valid league/event/team identities and nonnegative scores. Extra time, shootout and ambiguous regulation scores are excluded, never substituted.
- The API's annual completeness has not been independently established. Counts describe acquired data only. All observations were backfilled at collection, not saved before their historical matches.

## Frozen experiment

`protocol.json` fixes 2021–2023 training, 2024 validation and 2025 testing. Six half-life/regularization combinations are selected by validation 1X2 log loss only. An assumed 24-hour result lag separates starts from training cutoffs; this does not prove source publication times. No test-year label selects hyperparameters.

The baseline estimates log-linear team attack/defence, intercept and home effect with penalized Poisson likelihood. Neutral sites omit the home term during both fitting and prediction. A conditional low-score dependence grid is fitted on training outcomes, explicitly **not** joint Dixon–Coles maximum likelihood. Independent Poisson is reported on the same test cohort. New/untrained clubs fail closed; excluded games remain in coverage denominators.

`baseline.json` contains trial records, test cohorts, calibration bins, excluded fixtures and frozen coefficients. `lib/soccer/research-frozen.js` is generated from it for server-side use. Retained probability mass is never renormalized to hide a truncated tail. The output reports the omitted bound.

The separate live research fit uses only acquired results at least 24 hours before the fixed 2026-10-18 UTC cutoff. Requests only apply frozen coefficients; they never fit on the current game's result. Post-start requests produce an audit, not a reconstructed prematch prediction.

## Reproduce

Run `node scripts/soccer-research-build.mjs` to acquire/checkpoint source years and refit under the locked protocol. `node scripts/soccer-model-test.mjs` independently refits the frozen model from the retained compressed observations and reproduces test metrics. `node scripts/soccer-analysis-live.mjs` checks real source summaries without database writes.

## Still unverified

xG/state adjustments, personnel/minutes, injuries/eligibility, travel/weather/referee effects, UCL domestic-league mappings and stage adjustments, half-time model, rolling walk-forward, parameter uncertainty, independent reference prices, actual soccer credit-contract periods/settlement/rebate basis, calibration promotion and betting returns are not complete. No ranking, bet eligibility or W/R/S is produced. A complete XI is provider-reported; the provider's source publication time is not inferred from collection time.

Immutable evidence revisions preserve each request's sources, model version, quote snapshot and missing inputs. Database failure is shown as unsaved. Saved post-start information cannot overwrite an earlier prematch version.

## v11.10.2 diagnostics and personnel audit

`validation-protocol.json` and `validation.json` add nested chronological diagnostics for 2023, 2024 and 2025. Each fold selects parameters using only the immediately preceding validation year, then refits on earlier acquired results. These are retrospective development diagnostics, not newly untouched datasets. Paired model-loss differences use deterministic UTC-week block resampling; the interval assumes exchangeable week blocks and does not address acquisition or model-selection bias. Results are mixed across years and do not promote the model. Rebuild with `node scripts/soccer-validation-build.mjs`.

Observed substitution events and roster flags now reconstruct regulation-clock participation. The output explicitly excludes added time and is not a physical elapsed-minutes measure or a prematch minutes forecast. Stoppage-only substitutes remain marked as having appeared even when normalized clock minutes are zero. Missing event coverage, conflicting identities, unfinished games and unverified extra-time scope do not receive invented minutes.

`source-coverage.json` records the inspected ESPN summaries and StatsBomb Open Data competition catalog. It does not establish current-season xG coverage or claim that no other provider has it.

Per-score credit settlement review tables reuse the existing site's arithmetic only. They require GOALS units, preserve the original line and water, reject unsupported inputs rather than capping them, and keep the soccer period/rebate/provider-rule approval unset. They are not executable W/R/S evaluations.
