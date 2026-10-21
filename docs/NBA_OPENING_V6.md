# NBA opening totals V6: conservative early point fallback

V5 fixed half-total probability losses in 2021–2022 development, but its newly
consumed 2017 external test failed full-total opening MAE and the viewed current
2023–2026 regressions showed additional opening-point failures. Those results
remain unchanged. V6 explicitly declines the unsupported early point correction.

## Fixed hybrid point model

If **both teams have fewer than ten strictly earlier regular games**, the point
forecast is exactly the existing canonical prior-20 baseline. Opening point MAE
therefore equals that benchmark by construction. This is a model fallback and
does not demonstrate improved opening point accuracy. Once either team reaches
ten earlier games, the point forecast is the unchanged V4 prediction. The V4 raw
prediction/raw errors/current correction are preserved separately; hybrid errors
must not feed back into and change the mature V4 point calculation.

Full and half retain separate target state. Every date is processed as a batch
before its results update anything. No own, same-date or later outcome is used
for that date's forecast.

## Independently estimated predictive distribution

Probability estimates do **not** borrow baseline probabilities to obtain gate
equality. V6 reconstructs its own hybrid point errors in every prior season.
Its shape is the matching target/candidate/version/phase residual distribution
from the previous three closed seasons, centered at its 365-day weighted mean.
The predictive location is the hybrid point plus strictly earlier current-season
hybrid error sum divided by `120 + count`, across both phases. One coherent
rounded-score distribution supports arbitrary quoted lines and credit payoffs.

No constant or candidate is searched. The only changed point policy is the
declared early fallback; the location/shape algorithm is V5's fixed formulation
using V6's own matching errors. The original sample minimums and raw whole MAE,
opening MAE, Brier and Log Loss comparisons remain unchanged.

Protocol SHA256:
`01bd869099a83f1113e499732ebc6bac10be5f716961ca7ef02aa793f09ce795`.

Development-selection SHA256:
`63dc240cf3a12821b34cd00d9683f1462a061eb14f9cd9dd6ef6dfcdc6f5e746`.

Both targets pass all original comparisons in each of viewed 2021–2026.
Opening MAE equals the benchmark exactly in each year, as declared. In the most
recent viewed 2026 cohort (1230 games, 145 early), full MAE is 15.154645 versus
15.327674, Brier 0.246205 versus 0.249979 and Log Loss 0.685528 versus 0.693105.
Half MAE is 9.905260 versus 9.919837, Brier 0.249383 versus 0.249772 and Log Loss
0.692085 versus 0.692691. These small historical gains are development evidence,
not proof of a fresh independent result or future betting performance.

## Development and new external validation

All viewed 2021–2026 seasons are development, and each target must pass all four
comparisons in every year. Source history is the reviewed 2018–2022 archive plus
the byte-pinned existing 2023–2026 training archive. No year is silently dropped.

The fresh external season is **2011**, with strictly earlier 2007–2010 source
history. Protocol, implementation and development selection must be committed
before any predictive 2011 metrics are calculated. A failure ends the experiment
without selecting or tuning a replacement against that consumed season.

2017 has already been consumed by V5 and cannot be reused as unseen. The 2011
test is external backward-era retrospective evidence, not prospective OOS or
proof of historical pregame availability. Historical reference-threshold losses
do not establish actual bookmaker win rates or profit. No production score may
activate without reviewed independent evidence, every development regression,
runtime/replay parity, unchanged spread/settlement checks and full CI.

## Shared score-free runtime boundary

The runtime supplies the exact score-free hybrid point and canonical prior-20
baseline to `totalsV6AsOfRow`; early points differing from that baseline are
rejected. `totalsV6Distribution` computes location solely from prior observations
and exposes separate point and distribution center. Its transformed residuals
retain game/date/year identity for arbitrary-threshold CDF and seasonal R stress.

```sh
node scripts/nba-opening-v6-test.mjs
node scripts/nba-opening-v6.mjs
```

`--write-development` only creates evidence once. This runner has no 2011
evaluation entry point. A separate frozen-evidence evaluator owns that test.
