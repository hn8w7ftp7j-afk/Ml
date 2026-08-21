# PIT replay and OOS calibration

This pipeline estimates the long-run EV that historical out-of-sample evidence supports. It never clips raw EV to an arbitrary maximum.

## Required observation

Each row represents one settled Tai888 contract captured before game start. It must contain immutable payload and model hashes, `snapshotAsOf`, `modelAsOf`, every feature's observed timestamp, the game start and settlement time, raw model EV, water and realized unit return.

Rows are rejected when a line was captured after game start, a model or feature came from the future, the result predates the game, hashes are missing, or an observation is duplicated. Rejected rows never enter training.

## Walk-forward process

For each validation season, training uses only earlier seasons. A monotonic isotonic model maps raw model EV to historically realized net return. The final W shown by a released artifact is that OOS-calibrated long-run estimate, not the raw scenario EV.

R is W plus the 10th percentile of monthly OOS residual means. This measures adverse time regimes without treating individual win/loss noise as model uncertainty. Coverage is reported on held-out monthly blocks.

An artifact is usable only when its checksum, sample size, OOS folds and time blocks pass. Until a real historical Tai888 dataset passes, the website must retain raw W/R as uncalibrated shadow diagnostics and must not call them long-run calibrated EV.

## Run

```bash
node scripts/pit-oos-calibrate.mjs observations.ndjson artifact.json
node scripts/pit-oos-calibration-test.mjs
```

Synthetic fixtures are for code tests only and are prohibited from release artifacts.
