# NPB / KBO / CPBL source evidence implementation

Base reviewed: f5d0aea. This document describes local implementation, not Production acceptance.

## Implemented

- Read both feature and featureName. Asian individual acquisition times no longer borrow asOf or the global context clock. Legacy MLB extraction behavior is preserved.
- Capture official feature response text before parsing, compressed by content hash. HTTP acquisition IDs are independent of payload identity; cached reads reuse acquisition IDs. Failed feature requests have separate failure events and no successful fetchedAt.
- Capture the three history source responses. Preserve actual source publication and statistics cutoff as unknown unless the source supplies verified semantics.
- Freeze inputCutoffAt at context assembly, after provider collection. Bind the evidence identity into new Asian fingerprints so refreshed acquisition receipts cannot collide with an earlier immutable context.
- Independently report source timing and snapshot-store envelope/identity/parent-chain checks. No calibration claim follows from either check.
- Add append-only source content/event tables. New async snapshot writes externalize raw contents transactionally before storing references; old snapshots are not rewritten. Price-only transport carries references instead of raw bodies.
- Preserve PROJECTED in mobile lineup transport. Show Asian timing status and unvalidated-shadow / league-specific limitations.
- Add a separate KBO doubleheader usage-evidence diagnostic: existence of a first-game final score does not prove first-game pitcher usage was consumed. The legacy recomputed flag is retained because it affects the existing data-risk margin; it does not constitute usage proof. No W/R formula or input to that margin changed.
- Extend authenticated snapshot audit to safe-integer NPB/KBO/CPBL identities, retaining league isolation and rate limits. Asian replay uses the Asian dispatcher, never the MLB validator.
- Distinguish saved-matrix recalculation, current-engine distribution comparison and unavailable archived-engine replay. Missing historical calculation settings remain explicit, without substituting current settings and claiming exact reproduction.

## Explicit limits, not PASS

- The evidence graph now defines game identity, history, personnel, park, weather and rule nodes. New official slate records carry identity acquisition receipts; cached/legacy upstream game records without them keep the identity node and dependent derived nodes PENDING. Derived context nodes carry version, parsed value and conservative pipeline-input references; they do not imply an official source confirmed each projected value.
- Player-feature provenance currently binds a conservative group of production-pipeline inputs and references gameIdentity/history dependencies. It does not claim minimal per-field raw-source tracing. Unknown dependencies keep the result PENDING.
- No historical timestamps are invented; old snapshots lack evidence that cannot be recovered by renaming fields.
- Database transaction SQL is added, but actual Production source-table insertion and readback have not been accepted.
- Feature acquisition events are persisted at completion independently of model success, and incomplete history acquisitions attempt persistence before raising the original provider error. Process termination or unavailable storage can still prevent durable telemetry; neither is labelled saved.
- Original Asian engine archives are unavailable. Current-version mathematical reproduction is explicitly labelled a compatibility comparison.
- Independent historical prediction calibration, simulated ROI and confirmed-execution ROI are separate future acceptance reports. No such report was fabricated or rerun here.

## Verification

Local assertions cover content identity vs. event identity, cache acquisition reuse, legacy alias mapping, absence of fabricated individual times, missing/future/corrupt source evidence, non-mutation of snapshots, and all three Asian saved-matrix comparisons. Existing provider, feature-gate, snapshot-store, bet-evidence, calibration-ledger, data-audit, mobile transport and navigation assertions were exercised. Production build passed after storage/transport integration; no Production runtime acceptance is claimed.

Controlled synthetic before/after comparisons against f5d0aea cover all three leagues (including second-game contexts), requiring exact distribution-hash equality and all eight W/R pairs to match. No model weights, W/R formulas, scoring or ranking thresholds changed. No Production deployment is claimed.
