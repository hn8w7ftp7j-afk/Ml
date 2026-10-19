# Football total-market tail settlement — 11.10.21

Based on main `32a9add2b1317f1cfc7af61f67c63f978f658395` (11.10.20).
This change completes a numerical settlement calculation; it does not register
account terms, accept a football model, or activate formal football candidates.

## Problem and calculation

The generated Poisson/Dixon–Coles score distribution retains its original cells
and records omitted probability. Previously every positive tail made the point
EV unavailable, even when all omitted scores had the same settlement outcome.

For a verified complete score rectangle `0..H × 0..A`, every omitted score has
at least `min(H+1,A+1)` total goals. If that minimum is strictly greater than
every total-market settlement leg, its entire tail is a full win for OVER and
a full loss for UNDER. Add the omitted probability times that state's payoff.
Do not rescale any cell, discard probability, or invent a representative score.

Recompute the disclosed generator and require the complete matching rectangle,
PMF, retained mass and tail mass before applying this rule. A family label alone
does not establish tail location. HT distributions must additionally match their
own disclosed adaptive marginal generator, not an inherited FT-tail mixture.
Unsupported, altered or incomplete distributions and non-invariant tail outcomes
retain their intervals and unavailable point EV. Handicap tails remain unresolved.

## Output and integration

- Preserve `retainedMass`, `tailMass`, score rows and retained EV.
- Report resolved and unresolved tail mass and a separate `tailSettlement` with
  generator/support evidence, outcome, fractions and payoff contributions.
- Include resolved tail events in complete settlement/profit probabilities.
- Bound only the remaining unresolved contribution. Point EV is available only
  when no unresolved probability remains, subject to floating-point precision.
- Apply explicitly supplied per-outcome rebate terms to the tail's actual
  settlement outcome, using the confirmed whole-stake basis. A contract can
  exclude wins or losses separately. Do not assume all states receive 1%.
- Recompute each conditional scenario through this settlement path. A resolved
  numerical tail does not supply a scenario, an empirical error margin or R.

## Acceptance boundary

Production settlement and model/calibration/uncertainty registrations remain
empty. The normal analysis path still lacks approved contracts and validated
scenario inputs; its formal S/W/R and candidate eligibility remain unavailable.
Live prematch personnel/context evidence is also incomplete. User account terms
and actual model/source/uncertainty evidence must be obtained and accepted before
enabling formal scores. Synthetic test inputs are never installed as evidence.

No MLB/NBA implementation, shared score formula, baseline prediction or source
contract is changed. Verification results belong in the release PR; local tests
do not establish Production end-to-end operation or predictive profitability.
