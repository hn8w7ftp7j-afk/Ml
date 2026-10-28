# Football return-error research, version 1

This is a candidate research protocol, not a registered acceptance protocol.
The calendar boundaries are deliberately unset. The application can report
missing observations and missing splits without manufacturing an error margin.
An engineer must choose and durably freeze the protocol and fitted parameters
before any claim that a later test was untouched. A JSON `registeredAt` value
alone is not proof of registration.

The target is realized net profit per one unit staked minus the original saved
forecast's predicted net return. That error includes the noise of an individual
match outcome. It is not uncertainty of conditional expected profit and cannot
be substituted into formal football R or S. Every artifact remains NOT_ACCEPTED,
with formal eligibility, promotion and execution disabled.

## Source admission

The dataset reuses the first valid database prediction per economic original
price, model and period. It verifies the immutable snapshot, original Reader
adapter/hash and sealed return observation, then recomputes predicted and actual
net returns using the archived two-endpoint result evidence and a trusted
server contract resolver. Source terms must have been verified by the original
prediction cutoff. Later terms can support separate retrospective arithmetic,
but do not create a pre-bet return forecast in this dataset. Current empty
contract registries produce no fitted observations.

Complete result histories are required. Changed results or contract/return
conflicts quarantine the whole real game, including correlated directions.
An incomplete requested date range blocks fitting. Declared source hashes and
the normalized result evidence remain auditable; the fitter does not claim to
retrieve or independently recompute the original raw provider documents.

## Fixed research method

Fit separate groups for league, period, variant, original model hash, exact
contract hash, market kind and side. There is no pooling with NBA or across
leagues, periods, contracts or models. Assign an entire real game by kickoff to
one chronological training, calibration or test window; no random row split.
Training and calibration also require the result check to be available before
their respective window closes, so later scores cannot be borrowed backward.

Training estimates signed bias as the mean across games of each game's mean
return error. This gives every game one weight even if it has many prices.
Calibration uses each game's maximum absolute residual after that fixed bias
correction. The radius is sorted score number
`ceil((number_of_calibration_games + 1) * (1 - miscoverage))`, using one-based
indexing. If that rank exceeds the available games, the radius is null. There
is no zero fallback and no arbitrary acceptance sample threshold.

Test outcomes do not affect fitted parameters, quantiles or tuning. Without a
trusted durable receipt for the exact parameter/protocol hashes predating the
test, metrics are explicitly descriptive held-out diagnostics, not a verified
untouched test. Within-game dependence is retained in blocks; dependence and
distribution shift across games remain unverified, so the numerical order
statistic does not assert nominal coverage or a confidence guarantee. The
method choice is informed by the distinction between time dependence and
exchangeability discussed in [Barber and Pananjady, ALT 2026](https://proceedings.mlr.press/v313/barber26a.html).

## Interfaces

- `buildSoccerReturnErrorDataset(evidence, { now, resolveContract })` handles a
  complete existing evidence object with full original snapshots.
- `buildSoccerReturnErrorDatasetHydrated(evidence, { now, hydrateCapture,
  resolveContract })` lets a complete-game scanner hydrate at most one original
  capture at a time. Result evidence must be present on `checks`.
- `fitSoccerReturnErrorResearch({ datasets, protocol, now })` consumes the compact
  validated datasets and produces a deterministic, inspectable research artifact.

These are trusted server integration interfaces, not an HTTP authorization
surface. Content hashes provide integrity checks, not authentication or model
acceptance. Do not publish actual account captures, private configuration or
database exports in the public source repository.

## Read-only build command

Run `node scripts/soccer-return-error-build.mjs --database --league epl --from
2026-10-19 --through 2026-10-28 --output /private/path/return-error.json` in an
authorized server environment with the existing database configuration. This
uses the complete-game continuation scanner and hydrates selected original
captures one at a time; if that requested range is incomplete, the artifact
explicitly blocks fitting. The scanner writes only its normal derived job/cache
state. This tool does not write market, model, settlement or acceptance records.
The existing protocol loader may initialize its schema in the same way as the
application's normal read path. An interrupted CLI export should be restarted as
a new scan, since private compact datasets are retained in that process only.

Alternatively use `--input /private/path/evidence.json` with a full original
evidence export, including archived result evidence on `checks`. A public UI
summary is insufficient and cannot be converted into source observations.
Use `--include-dataset` only when a private compact observation export is
needed. Output files are created with mode 0600. No actual account data is
included in this directory. The default candidate protocol remains unregistered
and has no calendar split; it is available as `candidate-protocol-v1.json`.
