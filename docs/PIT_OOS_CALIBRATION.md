# PIT replay and OOS validation

This pipeline tests whether positive raw model EV is supported by long-run,
out-of-sample results. It never clips raw EV, feeds market prices back into the
score model, or replaces the public meaning of W.

## Fixed W and R definitions

`模型EV（W）` is always the direct expectation from one frozen joint score
distribution and the versioned Taiwan-credit leg payoff:

```text
W = Σ(score-state probability × score-state net payoff)
```

`穩健EV（R）` is produced from uncertainty scenarios and a conservative lower
bound derived from that same baseball distribution. A calibration artifact,
market consensus or realized-return model must not overwrite W or substitute
for R. Long-run validation estimates and formal-eligibility decisions are
stored and displayed as separate downstream evidence.

## Required observations

Every FULL analysis and price-only reprice preserves all eight direction slots,
not only selected bets. A calculated observation contains immutable Reader,
market, distribution, model, data, formula, rules and uncertainty versions;
analysis/data/line cutoffs; the game start; W and R; QA/ranking state; and the
eventual official settlement.

Rows are rejected from validation when a line or model feature comes from after
game start, the result predates the game, required hashes or versions are
missing, a duplicate identity conflicts, or the official result cannot settle
the stated period. Rejected rows remain auditable but never enter training or
performance claims.

## Walk-forward validation

Training and thresholds use only observations available before each validation
block. Reports must keep league, market, W band, R sign, QA status, line type and
lead-time cohorts separate, and publish sample count, wins/losses/pushes, ROI and
total profit. Synthetic fixtures prove code behavior only and are prohibited as
release evidence.

An artifact is eligible to influence formal recommendation status only when its
checksum, sample size, out-of-sample folds, time blocks and predefined error/
coverage thresholds pass. Until that happens, the website still displays W and
R as uncalibrated model diagnostics; it must not describe them as demonstrated
long-run profit or permit the validation layer to hide them.

## Run

```bash
node scripts/pit-oos-calibrate.mjs observations.ndjson artifact.json
node scripts/pit-oos-calibration-test.mjs
```
