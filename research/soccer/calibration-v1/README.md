# Frozen-model football calibration development package

This package fills an actual missing implementation: a reproducible score-level
calibration candidate and an intake for genuinely later, frozen-candidate
validation. It does not replace the live baseline, register an accepted model,
produce formal W/R/S, or establish that calibration improves predictions.

## Actual source population

The development window is 2026-10-20 through 2026-10-31 UTC. It contains 17 EPL
and 18 UCL normal-final games for which the existing scoreboard normalizer and
full summary agree on game/team identity, kickoff and regulation FT/HT scores.
Excluded events remain in each candidate's denominator and exclusion ledger.
The annual ESPN response is the acquired population, not proof that every game
that exists was acquired.

`retained-documents.json.gz` retains every acquired scoreboard and summary's
complete parsed JSON document plus original URL, acquisition times and hash.
The provider hash is recomputed over `JSON.stringify(data)`. These are not the
original HTTP response bytes; HTTP whitespace, headers and raw byte hashes
were not retained by the existing provider adapter. The package separately
hashes the exact gzip bytes, making subsequent changes detectable. No source
publication time is invented.

`frozen-base-models.json` retains the exact existing live FT model and conditional
HT model for each league. The FT model's training cutoff is 2026-10-18. Every
admitted development game starts after the model and HT artifact's declared
creation dates and their training cutoffs. The old model coefficients are not
rewritten. Historical model creation labels alone do not independently prove a
durable pregame freeze; `historicalFreezeReceiptVerified` remains false.

These currently retained inputs may support future predictions after a real
freeze receipt. Their current availability does not reconstruct missing
historical source publication evidence or a missing original prediction.

## Fixed candidate method

For each league's exact frozen FT/HT pair, let the baseline FT means for game i
be h_i and a_i and actual goals be H_i and A_i. The FT multipliers are
`sum(H_i)/sum(h_i)` and `sum(A_i)/sum(a_i)`. They minimize the unweighted Poisson
**marginal** negative log likelihood over positive rate multipliers. This is
not joint Dixon–Coles MLE. Baseline rho stays unchanged. If the resulting
dependence factors are invalid, the entire candidate fails rather than
dropping unfavorable games or clipping parameters.

The HT shares are `sum(HT_home_i)/sum(H_i)` and
`sum(HT_away_i)/sum(A_i)`, conditional-binomial MLEs. The HT distribution is
derived from the calibrated FT distribution with these shares using the
existing joint model. The full-time marginal, HT<=FT support and explicit
omitted mass are preserved. No independent 1X2 rescaling, truncated-matrix
normalization, invented epsilon rate, W/R/S adjustment, or acceptance threshold
is introduced. Zero or one HT shares are legal boundaries; absence of positive
FT exposure does not receive a fabricated finite multiplier.

The same development games fit and describe this candidate. Before/after exact
score log loss, 1X2 log loss/Brier and classwise fixed-bin audits are explicitly
in-sample diagnostics. The acquired old outcomes have now been used. They are
not a new untouched validation set. One real game has one calibration weight,
regardless of how many prices or market directions it had.

## Prepared genuinely later validation

The two `*-validation-plan.json` files bind the exact candidate, both exact base
models, inspected-game exclusion list and first-valid-pregame-capture policy.
Validation games must start after this new candidate's time and must not be an
already inspected game whose date later changes. The current count of verified
untouched validation games is **zero**. A plan with a content hash is not itself
a durable timestamp or external registration receipt.

`evaluateSoccerCalibrationProspectiveValidation` requires trusted adapters for
both the external durable freeze and an immutable database prediction receipt
strictly before kickoff. With either adapter absent it admits zero games. It
recomputes the original saved FT/HT distributions from the exact frozen inputs,
then rehashes and normalizes full later result documents. It compares baseline
and candidate on the same whole games. Reanalyses cannot multiply sample size;
conflicting FT/HT results quarantine the entire game. Harmless document metadata
updates with unchanged result scope do not create false score conflicts.

These interfaces remain research-only even when receipt and result checks pass.
No report automatically registers a calibration artifact or promotes a model.
Changing candidate parameters creates a new hash and requires a new future
freeze; later validation labels cannot be used to revise the same candidate.

The server now connects this flow to normal analysis: after an original
analysis is saved, `calibration-shadow-store.js` freezes the exact per-league
candidate/plan/models with the actual database clock and saves one immutable
FT/HT shadow prediction per real game. The original analysis, source archive
receipt and exact original revision are checked again. Captures at or after
kickoff, already inspected games and source receipts after the original cutoff
cannot enter this table. The baseline and its published scores remain unchanged.

`calibration-shadow-validation.js` reads only these server records. A bounded
server evaluation obtains the complete current daily scoreboard and summary,
requires normal-final regulation FT/HT crosschecks, appends immutable result
documents and revalidates their actual database receipt times. Read reports
recompute the complete stored history rather than trusting saved PASS flags.
Changed results, explicit extra periods and verified changes to kickoff, team
identity or neutral-site context quarantine the whole game, including an older
otherwise-valid result. Duplicate checks do not increase the game count.
Separate immutable attempt receipts keep repeated identical source failures
from monopolizing the small recheck queue.

The dedicated secret-authenticated `/api/cron/soccer-calibration` checks both
leagues hourly in separate bounded three-game batches. It shares no time budget
with bet settlement. A failed league does not stop the other, and unavailable
storage is reported as unknown rather than zero. The existing manual check
remains available from the calibration panel.

GET aggregation pages capture sequences in small batches and labels a time-
limited prefix as partial. A concurrent count change or database read failure
is unavailable, never a fabricated zero or complete scope. Synthetic fixtures
exercise this pipeline only in tests and are never sent to the production DB.

`lib/soccer/calibration-frozen.js` is the generated server runtime snapshot. It
contains candidates, plans and exact base models, with fixed package and inner
content hashes, so normal analysis can use these inputs without request-time
filesystem reads or loading the full source archive. Its getter returns detached
copies and checks league, models, plans and research-only restrictions. Generating
this file is not a database freeze receipt and does not permit historical capture.

## Reproduce and collect

Run `node scripts/soccer-calibration-build.mjs --retained-only --output-dir
research/soccer/calibration-v1` to verify exact archive bytes, frozen models,
candidate calculations and validation plans without network access. The command
does not rewrite the files. `node scripts/soccer-calibration-research-test.mjs`
adds real retained-source and isolated synthetic counterexamples. Synthetic
future games in tests are never written into this real evidence package.
Add `--write-runtime` explicitly to generate the server runtime snapshot after
the same exact retained checks succeed.

For a distinct development package run `node scripts/soccer-calibration-build.mjs
--collect --from YYYY-MM-DD --through YYYY-MM-DD --output-dir NEW_DIRECTORY`.
Collection always requests a fresh annual board, keeps failed reads in the
exclusion evidence and refuses to overwrite an existing package. Fitting a new
candidate does not make the current package's development data untouched again.
