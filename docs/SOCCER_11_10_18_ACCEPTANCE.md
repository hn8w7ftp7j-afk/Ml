# Football quote-bound publication — 11.10.18

## Scope and provenance

Rebuilt on main `80feba4f66b75b08a198584324baf9e3f2c13c10` (application 11.10.17).
The previously unpushed local 11.10.16 commit was removed by workspace maintenance
and is not present on GitHub. This release preserves the later main changes and
requires fresh tests; prior test results are not evidence for this rebuilt tree.

The user explicitly authorized this release to `hn8w7ftp7j-afk/Ml`, merging main,
and deployment to `mlb-positive-ev.vercel.app` on 2026-10-20 (Asia/Taipei).

## Implemented engineering boundary

- Keep immutable stored analysis separate from current qualification projections.
- Recompute saved accepted calculations against current server-owned settlement
  and acceptance registrations before projecting candidates. Caller flags and
  saved `VERIFIED` labels cannot register an artifact or contract.
- Bind each candidate to its original quote key, raw identity, price, side,
  period, model distribution hash, saved analysis revision, request sequence and
  Reader generation. A direction summary cannot lend its score to another quote.
- Derive projections on analysis response, qualified current-version read and
  board restoration. Restoration reads the head receipt in the same SQL query;
  older immutable attempts remain history, not publication authority.
- Require current receipt, prematch scope, analysis and quote age below three
  minutes, unblocked QA and S >= 7.2, W > 0, R > 0 in both ranking views.
- Reject changed kickoff, home/away identities, event source or neutral venue.
- Preserve client/background identity checks and non-executable research output.
- Render unit-stake W/R as percentages by multiplying by 100.

## Not promoted or fabricated

This change does not approve any settlement contract or model/calibration/
uncertainty artifact. Production registries remain empty. It neither changes
the fixed S formula nor invents W/R, rebate applicability or error margins.
Football therefore remains research-only with no qualified formal candidates.
The baseline distribution is not replaced with the experimental XI model.

Unresolved score tails still cannot be silently normalized, deleted or replaced
by a lower EV bound to manufacture a formal point estimate or R. Account terms,
prospective OOS evidence and independent uncertainty acceptance remain external
evidence requirements, not engineering flags to be switched on for release.

## Verification ledger

Fresh local tests, build and production checks are recorded in the release PR.
The accepted-publication branch is tested using explicit in-memory synthetic
registrations only. Tests also prove the shipped empty registries reject those
synthetic accepted results. Synthetic fixtures never enter Production storage.

No live bet is placed and no fake Production betting record is created. Local
PostgreSQL tests cover immutable original quote archival, cancellation/restoration,
scope isolation and unknown settlement metrics. Actual account transactions and
untested mobile/device workflows are not represented as verified.
