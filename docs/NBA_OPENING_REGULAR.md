# NBA regular-season opening bridge — 11.10.20

## Problem and bounded change

The original same-season regular model correctly returned insufficient history
for the first 2026–27 regular games (zero team games, zero same-season errors).
Preseason has a separate model and cannot be substituted for regular games.
The bridge runs only for the existing `NBA_MODEL_SAME_SEASON_HISTORY_INSUFFICIENT`
condition. It does not replace any ready same-season result, source failure,
identity rejection, unsupported contract, preseason or postseason model.

## Sources and math

4,922 archived regular games for season-ending years 2023–2026 were matched by
ESPN event ID, Taipei date, season/type, home/away teams and final score against
681 daily ESPN scoreboards. Every game's complete period scores sum to its final
score; first half uses periods one and two, excluding overtime. The normalized
archive carries scoreboard SHA-256 checkpoints and the complete retrieval
manifest. These are retrospective secondary-source records, not historical
pregame captures or a new claim of official-source verification.

Previous-season team points for/against form the prior. Each earlier current
regular game updates those means with prior-equivalent weight 20. Four fixed
ridge regressions (penalty 1000, minimum 30 earlier training games) predict full
total, full home-minus-away margin, actual half total and actual half margin.
Coefficients fit **closed earlier seasons only**. Current games update the input
means, not those coefficients. Historical replay uses this identical rule.
Same-day and later results cannot enter inputs, training or error distributions.
Neutral venues remain unsupported pending separate verification.

The prior weight was chosen from 10/20/40 on 2025 relative MAE across the four
quantities. 2026 was excluded from coefficient fitting for its replay and from
that selection. An initial prototype refitted coefficients within the target
season; this runtime/replay mismatch was corrected and all final evidence was
regenerated. Thus the report is a retrospective temporal holdout, **not** a
prospectively blinded model trial or evidence of current betting profitability.

## Final temporal validation and market gates

The exact report is `docs/nba-opening-validation.json` (1,230 games in 2026;
145 early games where both teams had fewer than ten earlier regular games).
Predeclared acceptance requires no regression versus the prior-team baseline
in full-season MAE, early MAE, Brier and Log Loss, with at least 1,000 total and
100 early validation games. Probability checks use pregame reference thresholds,
not reconstructed historical bookmaker quotes. Reliability bins/ECE are retained
as diagnostics, never numerical caps or model coefficients.

| Quantity | Result | Full-season MAE model / baseline | Early MAE model / baseline |
| --- | --- | --- | --- |
| Full margin | PASS | 11.573 / 12.028 | 11.249 / 11.613 |
| Half margin | PASS | 9.189 / 9.358 | 8.699 / 8.814 |
| Full total | FAIL | 15.228 / 15.328 | 15.575 / 14.710 |
| Half total | FAIL | 9.896 / 9.920 | 11.009 / 10.722 |

Only the two passing spread markets receive W/R/S. The totals remain visibly
pending validation. No thresholds or results were relaxed to make failed totals
look successful. Missing quotes remain missing.

W uses the existing Taiwan-credit settlement helper, original favorite-side and
water mapping, paired empirical errors, 365-day time weights and NBA's unchanged
1.5% rebate implementation. R is the minimum of W and each prior regular-season
stress estimate; at least two distinct seasons with 30 errors each are required.
S uses the unchanged shared deterministic formula. Neither R nor the displayed
probabilities are certified current betting returns. Personnel changes, confirmed
lineups, injuries and minutes remain absent; results retain `executable=false`,
`promotionEligible=false`, `strictPointInTime=false`, and no validated betting win
rate. The original candidate thresholds and manual-ledger workflow are unchanged.

## Integration and verification

The bridge has a distinct model version and result validator. Analysis jobs,
all-direction ranking, quote freshness and immutable forward captures consume
the same exact results; a changed quote invalidates the old result. Current
sample counts and the opening-model label are shown on the existing NBA card.
The existing same-season model resumes once its original sample guard passes;
its original R/S evidence requirements still apply.

Reproduction:

```sh
node scripts/download-nba-opening-history.mjs /absolute/scratch/archive.json
node scripts/prepare-nba-opening-training.mjs /absolute/scratch/archive.json
node scripts/nba-opening-model-test.mjs
npm run test:nba
npm test
npm run build
```

Production deployment and interactive verification must be recorded after the
release; a successful local build alone is not final acceptance. Overall opening
market coverage is **PARTIAL**, because both totals failed validation.
