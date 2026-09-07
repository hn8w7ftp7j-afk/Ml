# SX Bet public source (2026-09-07)

Read-only external inspection, not a scoring or verification-policy change.
UI: `/external-audit`, default provider `SX_PUBLIC`; existing configured sources remain selectable.
No account, wallet, API key, external signup or trading calls are used.

## Live checks

- `/sports`, `/leagues`, `/markets/active`: HTTP 200 without credentials.
- MLB league 171 returned markets including types 236 (first five total) and 1618 (first five winner).
- NPB 1191 and KBO 1389 returned zero active markets at inspection time; not evidence of permanent non-coverage.
- CPBL was not found in the inspected league catalog; no invented league mapping.
- `/orderbook-v3/snapshot` returned actual MLB levels and a book version, without a source timestamp.

## Contract and limits

Public v3 single-market snapshots are explicitly supported without authentication.
V3 bulk best-odds and event-snapshot routes require keys and are NOT used.
Use `showTakerPerspective=true`; implied probability is percentageOdds / 10^20.
Prices are before account-dependent fees; no claims about executable net price.
Zero liquidity, bad prices, missing timestamps and mismatched market hashes are not fresh valid quotes.
Snapshot book version is NOT a timestamp. Locally fetchedAt is labelled separately and never upgrades freshness.
One exchange cannot satisfy a multi-book independence requirement.
Official event identity and Taiwan settlement equivalence remain unverified.

Only market types 28/342 (full including extra time), 236/281 (first five) are inspected.
At most 1 page and 6 snapshots per selected event, 24-second total request deadline.
Pagination truncation and partial request failures are shown explicitly. No retries on auth/rate-limit errors.
The app's existing authenticated same-origin endpoint and rate limiter remain in place.

## Official references

- https://docs.sx.bet/api-reference/auth-matrix
- https://docs.sx.bet/api-reference/get-orderbook-snapshot
- https://docs.sx.bet/api-reference/market-types
- https://docs.sx.bet/api-reference/get-markets-active

The older blog quickstart is not a reliable v3 schema reference (units, sport IDs and endpoint authentication changed).

## Verification

`npm run test:external-audit` includes synthetic contract tests, not proof of live availability.
Live checks above are separate. Production UI and authenticated source fetch must be tested separately from build success.
