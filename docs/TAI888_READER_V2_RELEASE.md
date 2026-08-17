# Tai888 Reader 2.1.0 / Baseball EV 9.6.0

## Goal

A user-authenticated desktop Chrome session displays the Tai888 MLB, NPB, KBO and CPBL boards. The Reader reads only the visible standard-market DOM, identifies each authoritative league tab, normalizes the four supported markets, and securely pushes league-scoped snapshots to Baseball EV. It does not log in, read credentials/cookies/session, bypass Cloudflare, or place bets.

## Data flow

1. Tai888 page DOM -> Reader parser.
2. Reader pairing -> short-lived device token.
3. Device-bound ingest -> league-specific official Taipei slate validation -> league/date Runtime Cache snapshot.
4. Baseball EV `/api/credit-lines` -> fresh Reader snapshot for the requested league.
5. First analysis -> frozen full-game and first-five joint score distributions.
6. Later price-only changes -> `/api/reprice`, keeping the same distribution and recalculating settlement, EV, robust EV and deterministic score.
7. Core baseball-data changes -> normal full analysis/version path. NPB/KBO/CPBL results remain diagnostic shadow output and cannot be wagered.

## Safety and freshness

- Only `*.tai888.in`, `tai888.in` and `mlb-positive-ev.vercel.app` are in extension host permissions.
- Account/balance/password/session text is filtered client-side and server-side.
- URL metadata is allow-listed to Tai888 origin + pathname and the literal `#/BS` board marker. Query strings, arbitrary hashes, `document.title`, and raw frame URLs are discarded at content, background, browser-parser, and server-parser boundaries and are never stored or uploaded.
- Device tokens expire and are bound to a reader ID.
- The server calculates the raw-board and normalized payload hashes; client hashes are never trusted.
- Reader snapshots carry monotonic observed/page-activity/received timestamps and exact game counts.
- A single authoritative tab/frame is selected per league. Every visible, open game must contain four markets/eight executable directions; a visible partial game rejects the whole batch and keeps the prior trusted snapshot. Official games not shown by Tai888, or shown fully locked, remain non-executable rather than being fabricated.
- Same-date complete tabs with different fingerprints, inactive mutation preference, and more than four open Tai888 tabs all fail closed.
- The website acknowledges the exact `boardDate + payloadHash + pageActivityAt` revision only after every Reader game finishes analysis; same-hash heartbeats receive newly signed rows and price-only reprice.
- Market rows and frozen reprice snapshots are server-signed and verified before analysis.
- Stale or offline snapshots are not treated as executable current prices.
- No betting controls are read or operated.

## Versions

- Website: 9.6.0
- Next.js: 15.5.23
- Extension: 2.1.0 (`2.1.0 FOUR LEAGUE TABS`)
- Reader API/parser/store versions are returned by health/status endpoints and included in stored snapshots.

MLB retains compatibility with Reader 2.0.3+ during migration. NPB, KBO and CPBL require Reader 2.1.0+ and fail closed on older clients.

## Architecture limit

Vercel Runtime Cache has no atomic compare-and-swap across regions. Operate exactly one Reader writer. Concurrent Readers require a persistent database that supports conditional writes or transactions.
