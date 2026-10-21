# Earlier-era external retrospective NBA source archive

This is a separate 2013–2017 archive for a newly frozen external retrospective
test. It does not replace the reviewed 2018–2022 archive, any V3 evidence, or any
production training source. The 2017 outcomes are quarantined from predictive
evaluation until the new protocol and development selection have been frozen.
The acquisition and packaging scripts import no predictive model.

All 30 team schedules in each year define an expected completed-game oracle.
Each event must occur in both participating teams' schedules with matching
identity, date, scores and regular-season type. The calendar is derived from
the completed event dates in New York time, rather than an assumed 82-game
schedule or guessed season boundaries. Every daily scoreboard must agree with
the oracle, every quarter must be a nonnegative integer with ordered period
numbers, and the full period sum must equal the final result. The actual Q1+Q2
sum is retained as first-half score. All 961 raw sources were downloaded,
checksummed, compressed and re-read by the preparer before packaging.

| Season ending year | Verified completed games | Team schedules | Missing games |
| --- | ---: | ---: | ---: |
| 2013 | 1229 | 30 | 0 |
| 2014 | 1230 | 30 | 0 |
| 2015 | 1230 | 30 | 0 |
| 2016 | 1230 | 30 | 0 |
| 2017 | 1230 | 30 | 0 |

There are 6149 games, 150 team schedules and 811 daily scoreboards. The source
calendar, quarter checks and game identities have complete coverage. A complete
source archive is not a prediction result: no 2017 predictive metric was
calculated during acquisition or packaging.

Reviewed archive SHA256:
`b387b11e4127df1d953821b37575b035d91b63cdd6d6125f8321fab52720578c`.

The compressed server-only module verifies its raw archive checksum and deeply
freezes the decoded value. `auditOpeningIndependentArchive(history, archive)`
checks this exact reviewed pin, all source metadata, checksums/date mappings,
quarantine/year scope, coverage and evaluated-row identities. An arbitrary
caller-supplied hash or plausible coverage count cannot pass this audit.

## Meaning of independent evidence

The source corpus contains earlier-era results that were not used for the
2021/2022/2023–2026 candidate metrics. It can supply a new external retrospective
test after a protocol and development selection lock. However, the model's
design was informed by later-era findings. This is **not prospective out of
sample evidence**, proof of historical pregame access, official NBA verification,
historical bookmaker quotes, or proof of profitable betting. Current-era
regression review and exact runtime/replay consistency remain separate duties.
This archive alone cannot activate any W/R/S score.

## Reproduction

```sh
node scripts/download-nba-opening-independent-history.mjs /path/to/scratch/source-cache
node scripts/prepare-nba-opening-independent-history.mjs /path/to/scratch/source-cache/opening-independent-history.json
node scripts/nba-opening-independent-evidence-test.mjs
```

The downloader has a persisted 1200-request bound for these exact five seasons,
eight concurrent requests, source-size/time limits and resumable checksummed
checkpoints. A new acquisition has different retrieval metadata and must not
silently replace the reviewed package or its pin. Its raw cache must be replayed
and reviewed again before an explicit new pin is accepted.
