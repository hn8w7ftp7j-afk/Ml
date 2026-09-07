# Source time and original engine replay

- MLB feature provenance records each dependency's actual transport receipt time and the latest dependency receipt time. Statistical `asOf` and forecast `validAt` are separate. HTTP body acquisition must complete before assigning `fetchedAt`; cache hits retain their original timestamps.
- Cross-team aggregate dependencies use `dependencyReceipts`, separate from individual personnel source receipts. This prevents attaching the other starter's source to a player's identity audit.
- All dependency timestamps are checked against the saved analysis cutoff. Missing, invalid and future times remain failures. Failed fetches retain failure status; acquiring an empty response does not make the underlying data complete.
- Historical records are immutable. No current fetch time, game date, statistical period or invented timestamp is backfilled into old evidence.
- The read-only PIT model audit selects the matching engine. The 2026-08 v11.0.0 engine is restored verbatim from commit 53d2522cc47b0ebdbed069d8af3f1391eadcd40c with its transitive relative module dependencies. SHA-256 hashes are tested against the manifest. Current predictions still use the current engine.
- Matching a version only selects a candidate engine: rebuilt distribution hashes and W/R must actually match the saved outputs. Hash mismatch remains a mismatch. No model values are adjusted to force a match.
- Historical accuracy is not established by reproduction. Missing historical per-feature time evidence, settlement eligibility, selection bias and locked out-of-sample validation remain separate gates. The audit continues to disclose its 1.5% rebate setting because older snapshots did not independently preserve settings.

Database insertion time is exposed as an independent pregame existence check for both the price snapshot and original distribution snapshot. It is never relabeled as a provider publication/acquisition time, never replaces missing per-feature timestamps, and is not written into immutable payloads.
