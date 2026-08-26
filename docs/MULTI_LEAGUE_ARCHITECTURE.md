# Multi-league architecture

The website is one authenticated product with four isolated league modules:
MLB, NPB, KBO and CPBL.

`lib/leagues.js` is the authoritative capability registry. A league may expose
schedule, Reader, analysis, ranking and formal recommendations only after each
dependency has passed its own identity, point-in-time data, market coverage,
league-rule, joint-distribution and replay tests. Disabled capabilities fail
closed in both UI and API. No league may reuse another league's schedule,
team identities, Reader namespace, cache entries, run parameters or model
probabilities.

## Current Production state

MLB is the only league whose independent joint-score distribution is released.
Its W/R outputs remain uncalibrated shadow diagnostics: the actual-bet ledger is
available, but `formalRecommendations=false`, and score/ranking qualification is
downstream from the raw model EV shown as W.

NPB, KBO and CPBL currently expose official schedule, league-isolated Tai888
Reader data and the actual-bet ledger. Their analysis capability is
`DISABLED_FAIL_CLOSED`; they must not display W, R or a score until their own
upstream data and joint-score distribution can be built credibly. The API
returns `LEAGUE_NOT_READY` with machine-readable blockers.

Common Asian-league blockers are:

- Production PIT team-strength, independent starter-performance, credible
  lineup, pure-relief bullpen and recognized-park-factor pipelines;
- a released league-specific joint distribution linking first-five and full
  game scores;
- an official first-five result feed for automatic settlement.

For result settlement, CPBL full-game results are accepted only when the
official innings field is complete. NPB and KBO currently expose final scores
without a trustworthy final-innings field, so their full-game auto-settlement
also remains fail closed. All three Asian providers lack an official first-five
inning feed.

KBO additionally requires official starter handedness, weather or dome state,
and doubleheader bullpen recomputation. CPBL additionally requires verified
starter identity/handedness and a PIT snapshot of foreign-player constraints.
NPB must preserve its own DH/interleague, tie and extra-inning rules. None of
these gaps may be filled with MLB defaults, neutral placeholders, recent team
scores masquerading as pitcher skill, or probabilities inferred from Tai888.

## Shared output boundary

Once a league is enabled, shared presentation, settlement, persistence and QA
code may be reused, but the league model remains independent. Every game owns
one frozen joint score world and eight contractual slots: full-game runline
home/away, full-game total over/under, first-five runline home/away, and
first-five total over/under. Price-only repricing must retain the same
distribution ID/hash; a core baseball-input change must create a new one.

Tai888 supplies only the contract line and water used by the deterministic
Taiwan-credit payoff tree. External markets are optional audit evidence. Neither
source may calibrate, tilt or overwrite the score distribution, W or R.

Moving any disabled league to analysis-enabled status requires:

1. an authoritative schedule adapter with Taipei-date, doubleheader and game-
   identity tests;
2. Tai888 DOM fixtures covering four markets, eight directions, partial opening
   and malformed/duplicate market isolation;
3. league-specific PIT starter, lineup, pure bullpen, park and required context
   pipelines with source timestamps;
4. an independent first-five/full-game joint distribution and league-rule
   tests, with no MLB fallback path;
5. immutable eight-slot persistence, reprice replay and official-result
   settlement tests;
6. league-namespaced Reader, cache, database and API end-to-end tests.

Formal recommendation or bet eligibility is a later release decision. It also
requires locked out-of-sample and forward validation, but that validation gate
does not suppress a mathematically valid W once an independent league model is
released.
