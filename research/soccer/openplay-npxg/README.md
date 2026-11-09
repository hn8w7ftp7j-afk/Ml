# Historical EPL / UCL non-penalty xG research

Source: [openplay (Noah Bair)](https://github.com/nlbair/openplay),
[data-v0.1.0 release](https://github.com/nlbair/openplay/releases/tag/data-v0.1.0),
published 2026-11-03. Attribution: **openplay (Noah Bair)**. The provider licenses
this dataset under **CC-BY-4.0**. These normalized aggregates, exclusions,
coefficients and diagnostics are modifications of that dataset.

The provider identifies WhoScored as its underlying event source and supplies
its own `openplay_xg_v1` shot probabilities. These are not StatsBomb, Opta,
ESPN xG or verified current-season npxG. The source xG model's training data and
temporal isolation have not been independently verified.

| League | Source declared played | Supplied matches | Usable | Excluded | Source missing |
| --- | ---: | ---: | ---: | ---: | ---: |
| EPL | 4,560 | 4,556 | 4,424 | 132 | 4 |
| UCL | 1,622 | 1,622 | 1,573 | 49 | 0 |

The snapshot covers 2014/15 through 2025/26. It does **not** cover 2026/27.
The four absent EPL match IDs are retained in the report. Of supplied EPL
matches, 130 have unknown regulation shot xG and two have published provider
data issues. UCL has 49 matches with unknown regulation shot xG. Entire affected
matches are excluded; missing xG never becomes zero. Denominators include these
exclusions and source omissions.

## Regulation scope and source checks

The builder verifies SHA256 of all five original release files before Parquet
decoding. It checks source match/shot counts, declared coverage, completed status,
team identities, shot identities, model identifiers, explicit penalty/own-goal
flags, coordinates and known issues. This is source-declared event completeness,
not an independent reconstruction from every original match event.

FT includes `FirstHalf` and `SecondHalf`; HT includes `FirstHalf`, including added
time represented within that period. Extra time, shootouts and own goals are
excluded. Explicit penalties enter xG and penalty xG, but never npxG. A match
can have `max_period=4` while the separate shot table contains a shootout; its
explicit `penalty_shootout` flag controls that scope check. Provider-local dates
remain dates, not invented UTC kickoff timestamps. Provider team IDs remain
separate from ESPN identities.

## Research estimator and limits

For each league and period independently, fit home/away league means and team
attack/concession ratios using eight fixed prior matches. Training uses dates
before 2024-07-01; diagnostic calibration uses 2024/25; the retrospective test
uses 2025/26. No holdout tuning is performed. Unseen teams use a league-mean
ratio, with their counts explicitly reported. The target is **observed provider
npxG**, not future goals, a full score distribution, bet returns or S scores.

This release was acquired retrospectively. The xG generator itself may have
seen later data, and these partitions do not establish an untouched independent
test or historical prematch access. They cannot satisfy prospective collection
protocols, personnel/minutes validation, calibration acceptance or return-error
acceptance. All formal acceptance/effect flags remain false and W/R/S remain
null. No scoring bundle is registered by this change.

## Reproduce and verify

Download `matches.parquet`, `shots.parquet`, `coverage.csv`, `known_gaps.csv` and
`data_issues.csv` from the pinned release into a local directory. Install
`pyarrow==26.0.1` in an isolated Python environment for source rebuilding.

```sh
python3 scripts/soccer-openplay-npxg-build.py \
  --data-dir /absolute/path/to/release \
  --output research/soccer/openplay-npxg \
  --collected-at ACTUAL_SOURCE_ACQUISITION_TIMESTAMP_WITH_TIMEZONE
python3 scripts/soccer-openplay-npxg-test.py
```

The retained compressed ledger contains normalized real observations and every
excluded match/reason. `research-report.json` records source URLs/hashes,
acquisition and artifact creation times, normalizer hash, ledger hash, fitted
coefficients, temporal partitions and diagnostics. Tests use the standard
library, replay those actual rows offline, verify hashes/counts/coefficients and
check synthetic boundary cases separately. Synthetic fixtures never enter the
empirical sample counts.
