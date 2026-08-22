# MLB Positive EV v9.2

## Daily flow

1. Press `一鍵分析今日 MLB`.
2. The server loads today’s MLB schedule and an authorized reference-line provider.
3. Every matched game is analyzed once and receives a frozen full-game/F5 joint score distribution.
4. Reference lines are clearly marked as non-final screening scores.
5. Enter a complete actual Taiwan-credit contract and water, including cross-key-number changes such as `讓1+50 → 讓2-80`.
6. Price-only changes use `/api/reprice` with the frozen distribution. No MLB refetch, simulation, or GPT numeric scoring is allowed.

## Two price layers

- Reference lines are analyzed with the provider’s actual decimal payout and no Taiwan-credit rebate.
- Actual Taiwan-credit contracts are repriced separately with the configured 1.5% rebate.
- The two price layers are never mixed in one formal result set.
- Rankings prefer the actual contract for a market after the user enters one; other markets continue to show their reference screening result.

## Safety

- GPT cannot choose numeric scores.
- Only actual executable Taiwan-credit prices enter the formal bet pool.
- Split lines settle and rebate per leg before aggregation.
- Large distribution snapshots are not written into browser storage.
- The server and first client render use the same deterministic defaults; browser storage loads only after hydration.
- Safari/private-mode storage failures are caught and cannot crash the app.
- App-level and global error recovery screens are available.
- No unauthorized page scraping, login simulation, cookie reuse, CAPTCHA bypass, or Cloudflare bypass is used.

## Authorized providers

- `JBOT_API_TOKEN`: Taiwan Sports Lottery reference line API.
- The Odds API integration was removed in v10.7.1 and is not a scoring dependency.

Provider keys stay server-side. Without a configured key, the website states that the authorized provider is not configured and keeps screenshot import available.
