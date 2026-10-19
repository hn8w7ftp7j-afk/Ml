# EPL/UCL missing-score root cause — 11.10.23

This release fixes identity integration and exposes calculation readiness. It
does **not** complete or activate football W/R/S. A release/build/test success
must not be reported as successful real-market scoring.

## Reproduced on Production 11.10.21

- EPL 2026-10-20: the completed Tottenham–Coventry fixture retained historical
  HT quotes with null S/W/R. Unlabelled full-game columns remained UNKNOWN.
- UCL 2026-10-21: nine official fixtures and nine Reader fixtures were visible,
  but all Reader games were UNMATCHED. Board Chinese variants such as 費倫巴治,
  多蒙特 and 波圖 were absent from the exact alias table.
- The normal `buildSoccerAnalysis` path calls `scoreSoccerQuote` without source
  contract, scenario distributions, empirical error artifact or acceptance.
  Both production contract and model/uncertainty registrations are empty.
  Consequently no formal numeric score can be produced by that path.
- Generated FT distributions omitted league/gameId; HT omitted gameId. The
  downstream scoring identity gate requires both. Fixing this does not supply
  the missing model/settlement inputs.

## Corrections

1. Apply 14 exact board-to-provider aliases only at server matching time.
   Keep the installed Reader wire format, raw labels, keys/codes, hashes and
   strict capture reparse unchanged. Both teams, date, kickoff and league
   must still agree; conflicting raw identity and ambiguous candidates fail.
2. Bind verified game/league identity onto generated FT/HT distributions.
   Reject conflicting scope. Every computed probability/rate is unchanged.
3. Save a hashed `scoreReadiness` receipt and show actual quote/score counts
   with the missing calculation stages. Historical payloads derive the same
   explanation from their existing scorer evidence. No null becomes a score.
4. Advance the analysis schema version so restored earlier results are not
   silently treated as current-version analyses.

## Validation boundary

Tests exercise real retained ESPN normalizers and generated FT/HT distributions,
the shipped score/quote pipeline, SQL/API tests, exact old-Reader wire reparse,
and rendered JSX. Synthetic accepted-calculation tests remain tests only.

Still required before the original numeric-score goal can pass:

- Account-applicable football settlement and per-outcome rebate terms, including
  normal HT scope and applicable source/time binding.
- Actual football scenario and empirical net-return error inputs, plus reviewed
  model/calibration/uncertainty evidence. Loss-metric bootstrap intervals are
  not a substitute for per-market R.
- Known FT scope evidence for the currently unlabelled source columns.
- Production reanalysis showing a genuine numeric S/W/R for a live original
  quote. Neither a displayed dash nor a useful readiness explanation meets it.

The confirmed 1% of football principal and NBA 1.5% remain separate and unchanged.
The fixed S formula, 7.2/W>0/R>0 gates and candidate/publication guards are unchanged.
