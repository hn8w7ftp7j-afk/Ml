# Personnel evidence presentation v11.9.30

## 1. Scope and evidence
Base main: 460e3b4bb650819793fe303717d1b666487bca3d. This change is a presentation and receipt-mapping repair, not an independent replay or model validation.

## 2. Confirmed causes
The shared baseball page interpolated MLB usageCoverage keys even for Asian sampledGames coverage. analysis-data-audit-v1 emitted a measured-season split note regardless of acquisition status. starterInningsDisplay omitted expectedInningsEvidence and used a generic starter source instead of the dedicated innings source. NBA/NHL do not import these presentation modules.

## 3. Changes
Read-only legacy receipt presentation handles missing, zero and partial coverage without normalization. New receipts retain existing innings evidence and report split notes by status. Cards disclose assignment status, innings sample/method/source, lineup index usage, feature verification object and field traceability separately. Stored league limitations are shown on direction cards as unquantified league-level limitations. Full-copy already reads collapsed DOM, so includes the same display.

## 4. Preserved boundaries
No changes to probability distributions, W/R/S formulas, ranking thresholds, Reader authority, automatic analysis policy, bet mutations, PIT storage or archived source. Old raw JSON remains unchanged, with displayInningsEvidence explicitly separated. Source acquisition status was already separate from mapping; VERIFIED/PENDING/FAILED are not rewritten. No new feature source or measured value is invented.

## 5. Verification
Focused cross-league fixture tests cover missing split notes, Asian 5/6-game usage, MLB 0/3 coverage, invalid counts, innings evidence recovery, default-only source verification scope and immutable inputs. Existing copy and receipt tests pass. Production build passes. Full suite and deployed browser checks are recorded in the PR acceptance follow-up.

## 6. Limits and remaining work
Fixture checks do not establish live completeness for every league or independently replay the supplied snapshot. Distribution/R/S replay, upstream sensitivity and model-cohort historical validation remain separate work. Native iOS clipboard and every live market action require their own acceptance; no real bet is created by this repair.
