# Conditional football return analysis

New pregame analyses attach a compact conditional return calculation to each
original, fresh, period-confirmed handicap/total quote. The original scoped FT
or HT score distribution is integrated with the existing credit-boundary payout
engine and the user's confirmed 1% settled-principal rebate. Full/partial wins
and losses receive the corresponding principal share; pushes receive no rebate.

Credit-boundary payout applicability is explicitly an unverified account
assumption. The UI labels this assumption alongside the numbers. It shows net
return bounds and settlement-state probabilities, never an empirical robust R,
formal W, fabricated S, confidence interval or qualified recommendation. The
bounds cover unresolved score-grid tail mass only, not model error. Unsupported
contracts, stale or changed prices, poststart games, unknown periods, wrong
model scope and training after the analysis cutoff remain unavailable.

The current model, calibration, formal scoring, candidate publication, ranking
and settlement acceptance rules are preserved. Old stored snapshots are not
rewritten or backfilled; only new analyses contain this calculation. Previously
calculated research numbers become historical when their source prices expire
or the game starts. No NBA source or model changes are included.

Verification exercises all eight directions with independently computed return
arithmetic, the retained real EPL provider fixture through buildSoccerAnalysis,
actual shipped JSX, source/scope/time mutations and unchanged formal gates.
Production testing still requires an upcoming game and genuine fresh Reader
prices; a test quote is never sent to the production Reader.
