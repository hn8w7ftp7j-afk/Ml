# NBA opening totals release 11.10.29

Opening full/first-half totals now use the reviewed V6 hybrid during the existing
same-season warmup gap. Both spread markets retain the original forecasts,
valuations and stress evidence. Same-season and preseason models are unchanged.

When both teams have fewer than ten prior games, the point prediction is exactly
the canonical prior-20 benchmark. Early point MAE therefore equals the benchmark
by construction; no superior early point accuracy is claimed. Mature points
retain V4. Probabilities use this hybrid candidate's own same-phase closed-season
errors, centered for distribution shape, plus a prior-only current-season error
location. Historical replay and arbitrary credit quotes share that distribution.
Original credit fractions, 1.5% rebate, R stress and S/candidate rules remain.

All four original raw metric gates pass for both targets separately in every
viewed 2021–2026 season. Protocol/implementation/selection were frozen in pushed
commit `9756419da65c06369166cbae1119ff8c39b3f2f8` before evaluating untouched2011.
The independently sourced 2007–2011 archive has6150 games and966 raw checkpoints
(150 team schedules +816 daily scoreboards), no missing completed regular games,
and actual quarter/half checks. The2011 external cohort has1230 games,145 early.

| 2011 target | Whole MAE / baseline | Early MAE / baseline | Brier / baseline | Log Loss / baseline |
| --- | --- | --- | --- | --- |
| Full total | 14.226896 /14.663369 | 14.750025 /14.750025 | .239649 /.251355 | .672168 /.695858 |
| Half total | 9.050184 /9.218657 | 9.170914 /9.170914 | .242491 /.251764 | .677931 /.696681 |

This is an earlier-era external retrospective test, not prospective OOS or
historical pregame-capture certification. Reference thresholds are not bookmaker
odds or proven betting returns. Forward captures retain composite model and
new engine versions, original quotes and the existing pre-tipoff database guard.
No automatic wagering/execution or formal promotion is granted.

Release evidence is server-only and byte-pinned:

- Protocol `01bd869099a83f1113e499732ebc6bac10be5f716961ca7ef02aa793f09ce795`
- Selection `63dc240cf3a12821b34cd00d9683f1462a061eb14f9cd9dd6ef6dfcdc6f5e746`
- Independent report `7afaad0d3ad268fcb9eac4a17793ad1c085400a27637c562c6f7f50844417cb8`
- Development report `4411b1804e4ed332b9d4f2e89f4a2a48f6c395de34fe5cb2467fdf03a89b108f`
- Source archive `abbf2fc1c41d5509a2b7ff182aa4949702b66a6d6266dc82d7b795f915cb49e9`

Runtime checks independent and every development-year raw metric, source hashes,
candidate/protocol/market identity and exact report binding before valuations.
The client recognizes only this composite release and retains quote/page/start
freshness, failed-market and S/W/R qualification checks. Missing quotes stay
unavailable. A stale Reader capture must be refreshed, not relabeled as current.

Node22.23.3 and24.19.0 tests cover source/alias counterexamples, frozen evidence
replay, target-label-free runtime parity, own/same-date/future exclusion,
unapproved/source/model/report/metric tampering, full credit/R/S and all eight
production-default directions through service/capture/client/UI. FullCI and
post-deploy checks are recorded in PR364. Earlier V3/V4/V5 failures stay intact.
