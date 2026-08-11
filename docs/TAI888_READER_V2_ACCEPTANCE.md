# Tai888 Reader v2 acceptance checklist

- [x] Reader reads visible Tai888 MLB DOM only.
- [x] Correct production host: `www1.tai888.in`.
- [x] Full-game run line and total parsing.
- [x] First-five run line and total parsing.
- [x] Home marker and team-code normalization.
- [x] Split line/tail/water fields retained separately.
- [x] Reader pairing and expiring device token.
- [x] Rate limit, payload size, idempotency and replay controls.
- [x] Runtime Cache-backed latest snapshot with memory fallback for local tests.
- [x] Fresh/stale/offline status.
- [x] `/api/credit-lines` prefers fresh Reader snapshot.
- [x] Initial analysis uses the full deterministic model.
- [x] Price-only update uses frozen-distribution `/api/reprice`.
- [x] Core-data changes continue through full-analysis versioning.
- [x] Existing Taiwan-credit settlement, rebate and mirror QA preserved.
- [x] Permanent parser/auth/store/DOM tests.
- [x] Full existing test suite and optimized Production build pass.
- [x] No credentials, cookies, sessions, balances or betting actions are collected.
