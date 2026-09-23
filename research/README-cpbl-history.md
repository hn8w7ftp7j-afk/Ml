# CPBL historical starter validation

Research only: these files are not imported by the application and do not change production predictions.

The protocol was committed before evaluation. The empirical helper is frozen by both source-file and function hashes. The baseline calls the production function from v11.9.43, rather than maintaining a separate reimplementation.

## Reproduce

Install the repository dependencies with `npm ci`. Extract the accompanying evidence archive into a data directory. It includes the official monthly schedules, raw game details, acquisition receipts, actual-personnel reconciliation and the history manifest. Then run:

```sh
node research/cpbl-complete-history.mjs /absolute/path/to/data /absolute/path/to/prior-audit
python research/cpbl-verify-evaluation.py /absolute/path/to/data
```

The optional prior-audit directory contains `inventory-game-map.json`; without it, the new-versus-known grouping is unavailable and should not be interpreted as a new sample. To acquire missing game details using already downloaded schedules:

```sh
python research/cpbl-acquire-history.py /absolute/path/to/data /absolute/path/to/prior-audit
```

No credentials are used. Sources are public CPBL regular-season APIs. Fetches use six workers, validate cached content hashes, preserve raw responses, deduplicate official game IDs, and fail closed on conflicting team identities. An empty monthly response is recorded as a coverage limitation, never proof that no games existed.

## Comparison

Primary comparison: production formula with six prior team games versus the frozen empirical cadence formula with 24. Registered diagnostics also compare the production formula with 24 games and empirical formula with six, to separate history coverage from formula changes.

Both formulas are evaluated unconditionally on every eligible historical team-side. Production uses rotation projection only as a fallback when an official starter is unavailable. These results therefore measure fallback formula quality, not overall website starter identity accuracy; historical official-announcement availability is not reconstructed.

For every target, history must belong to the same season and team and have an earlier Taiwan local game date. Same-day games are conservatively excluded. Predictions are generated before the actual target starter is read. The outcome reconciles explicit scorebook starter roles with the first thrown pitch and documented pre-pitch replacements.

Report coverage, correct predictions over all eligible sides, correct predictions over covered sides, common-coverage paired counts, candidate recall, and team/month breakdowns. Candidate weights are heuristic relative scores, not calibrated probabilities. Candidate recall also depends on candidate-set size.

## Limits

This is a retrospective event-time replay, not a reconstruction of exactly what was available to the website before each game. Raw records were acquired later and may contain corrections. The provider does not supply an independently archived completion timestamp for every historical game; suspended/resumed games therefore require additional care in any production promotion study. Active roster eligibility is not independently verified. The 2025 endpoint returned no games and does not provide an independent season in this run.

The known August/September audit sample must be separated from newly acquired games. Do not tune the frozen helper on these outcomes or promote it automatically. Any later formula adjustment needs a new protocol and independent validation.

## Result on 2026-09-23

The 2026 monthly schedules resolve to 360 unique game IDs. Of these, 330 finished games (660 team-sides, March 28 through September 22) meet the cutoff; 15 were future schedule entries and 15 were not finished by the cutoff. There were no acquisition failures or unverified actual-starter exclusions. The independent verifier passed raw hashes, identities, history dates, weights and summary accounting.

| Method | Covered | Correct / all 660 | Candidate recall |
| --- | ---: | ---: | ---: |
| Production formula, 6 games | 639 (96.8%) | 59 (8.9%) | 412 (62.4%) |
| Frozen candidate, 24 games | 628 (95.2%) | 266 (40.3%) | 549 (83.2%) |
| Production formula, 24 games | 639 (96.8%) | 59 (8.9%) | 416 (63.0%) |
| Frozen candidate, 6 games | 515 (78.0%) | 195 (29.5%) | 345 (52.3%) |

Among the 560 team-sides outside the prior audit, production scored 48/560 (8.6%) and the candidate 216/560 (38.6%). All six teams improved in this retrospective comparison. On the 625 sides covered by both primary methods, production scored 58 and the candidate 266; 22 were correct only for production and 230 only for the candidate.

Decision: retain production behavior and keep this candidate in research. The source lacks independent 2025 coverage and archived acquisition/completion timing, and production runtime cost plus current roster eligibility have not been validated. The improvement is evidence for further prospective validation, not a calibrated confidence claim or an already deployed improvement.
