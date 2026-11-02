# Match-level non-penalty xG research

This implementation extracts actual StatsBomb shot probabilities and fits a
separate research estimator. It does not reconstruct xG from goals or divide
current Opta team totals into invented match observations.

Provider: [StatsBomb Open Data](https://github.com/statsbomb/open-data), pinned to
commit `4b73468fc5b0f1950f9f66fada70ad3a4f9327cb`. The cohort is the complete
2015/16 Premier League match index, competition 2 / season 27. It is not current
2026/27 coverage, UCL coverage, or an ESPN/Opta identity mapping.

![StatsBomb](../../../public/sources/statsbomb-open-data.png)

The provider's [user agreement](https://github.com/statsbomb/open-data/blob/4b73468fc5b0f1950f9f66fada70ad3a4f9327cb/LICENSE.pdf)
restricts source-data redistribution and commercial exploitation, and requires
logo attribution on published analysis. This repository publishes implementation
code and aggregate research conclusions only. It does not redistribute source
events, match rows, shots, team statistics, or fitted coefficients. Those remain
in a local temporary research cache. No provider-account access is inferred.

## Extraction

- Both source documents must have matching pinned commits, original UTF-8 SHA256,
  valid retrieval times, exact competition/season and match identity.
- Only provider periods 1 and 2 enter regulation FT; period 1 enters HT, including
  added time. Extra time and shootouts never enter those observations.
- npxG excludes explicit provider penalty shots. Missing shot xG is never zero.
- Actual shot location, body part and play pattern are retained locally. Positions
  outside the nominal pitch remain flagged, not clipped or used to invent xG.
- Both regulation Half End events are required. Duplicate IDs, mismatched teams,
  conflicting penalty types and malformed values reject the source document.

## Model and diagnostics

The fixed model uses league home/away npxG means multiplied by team attacking and
opponent-concession ratios, each shrunk toward the league mean with eight prior
matches. It is a descriptive estimator, not a full score distribution, injury
model, penalty-frequency model or causal team-strength estimate.

Whole provider-local match dates define chronological partitions: training before
2016-01-01, calibration diagnostic from that date through 2016-02-29, test from
2016-03-01. The parameters use training rows only. No calibration/test tuning is
performed. MAE and MSE compare observed npxG against the estimator and the fixed
league-mean baseline. Empty partitions return null errors.

These sources were downloaded retrospectively. The partitions do not prove an
independent untouched test or historical prematch availability. `accepted`,
`formalEligible`, `modelEffectApplied` and `executable` remain false. The live
adapter reports UNKNOWN for absent current-season/provider-identity coverage and
refuses to expose an artifact before its creation cutoff.

## Reproduce

Run `node scripts/soccer-match-xg-build.mjs --cache /absolute/local/cache --fetch`
to retrieve the fixed provider snapshot and produce the aggregate reports. Review
and comply with the provider's agreement before accessing its data. Raw and
normalized files and fitted coefficients stay in that cache. `--replay` rebuilds
aggregate conclusions from its normalized observations without refetching or
altering their original source hashes and retrieval times.

Run `node scripts/soccer-match-xg-test.mjs` for clearly labelled synthetic
schema/math, chronology, no-holdout-leakage and cutoff regressions. Those fixtures
are not claimed as empirical validation.
