# Tai888 Reader 2.0.7 / MLB EV 9.4.4

## Goal

A user-authenticated desktop Chrome session displays the Tai888 MLB board. The Reader reads only the visible MLB market DOM, normalizes the four supported markets, and securely pushes a versioned snapshot to MLB EV. It does not log in, read credentials/cookies/session, bypass Cloudflare, or place bets.

## Data flow

1. Tai888 page DOM -> Reader parser.
2. Reader pairing -> short-lived device token.
3. Device-bound ingest -> complete official Taipei slate validation -> Runtime Cache snapshot.
4. MLB EV `/api/credit-lines` -> fresh Reader snapshot.
5. First analysis -> frozen full-game and first-five joint score distributions.
6. Later price-only changes -> `/api/reprice`, keeping the same distribution and recalculating settlement, EV, robust EV and deterministic score.
7. Core baseball-data changes -> normal full analysis/version path.

## Safety and freshness

- Only `*.tai888.in`, `tai888.in` and `mlb-positive-ev.vercel.app` are in extension host permissions.
- Account/balance/password/session text is filtered client-side and server-side.
- URL metadata is allow-listed to Tai888 origin + pathname and the literal `#/BS` board marker. Query strings, arbitrary hashes, `document.title`, and raw frame URLs are discarded at content, background, browser-parser, and server-parser boundaries and are never stored or uploaded.
- Device tokens expire and are bound to a reader ID.
- The server calculates the raw-board and normalized payload hashes; client hashes are never trusted.
- Reader snapshots carry monotonic observed/page-activity/received timestamps and exact game counts.
- A single authoritative tab/frame must contain the complete official slate, with four markets/eight executable directions per game.
- Same-date complete tabs with different fingerprints, inactive mutation preference, and more than four open Tai888 tabs all fail closed.
- The website acknowledges the exact `boardDate + payloadHash + pageActivityAt` revision only after every Reader game finishes analysis; same-hash heartbeats receive newly signed rows and price-only reprice.
- Market rows and frozen reprice snapshots are server-signed and verified before analysis.
- Stale or offline snapshots are not treated as executable current prices.
- No betting controls are read or operated.

## Versions

- Website: 9.4.4
- Next.js: 15.5.23
- Extension: 2.0.7 (`2.0.7 LOCKED MARKET FIX`)
- Reader API/parser/store versions are returned by health/status endpoints and included in stored snapshots.

## Architecture limit

Vercel Runtime Cache has no atomic compare-and-swap across regions. Operate exactly one Reader writer. Concurrent Readers require a persistent database that supports conditional writes or transactions.
