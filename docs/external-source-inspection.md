# External source inspection (not market verification)

The `/external-audit` page and POST `/api/external-audit` endpoint inspect potential
Asian baseball sources independently of the existing reference-lines, verification,
scoring, ranking and model pipelines. This is transport scaffolding, not completion
of live market integration. `verified` is always false.

Server-only settings:

- `ODDSPAPI_API_KEY`: CPBL, tournament 32233, Pinnacle via OddsPapi v4.
- `ODDS_API_NET_KEY`: NPB and KBO via odds-api.net v1.

Use the platform's secret settings. Never commit keys or expose them as NEXT_PUBLIC
variables. Account authorization, actual market coverage and live responses have
not been tested. Missing settings produce NOT_CONFIGURED without a network call.
Keep existing app authentication: the endpoint spends provider quota.

Requests are manual, bounded by timeout and local per-IP rate limit. There is no
automatic polling or retry of source authorization errors. In-memory rate limits
are per server instance, not a global quota guarantee. Results are not cached;
pagination or 500-quote truncation is explicitly marked partial.

The NPB/KBO inspector uses each bookmaker's snapshot timestamp, never the response
timestamp to refresh stale quotes. CPBL exposes price-change timestamps explicitly
as such, not observation timestamps. CPBL market IDs, participant IDs and periods
are deliberately not guessed. Event eligibility is checked against the provider's
league/date list, not yet against the official schedule. Dates mean Asia/Taipei.

Before enabling actual external verification:

1. Test authorized live responses and catalogue IDs for each league and period.
2. Match official IDs, team aliases, start times and doubleheaders unambiguously.
3. Match exact market, line, side, innings and settlement rules; never substitute
   full-game prices for first-five-innings prices.
4. Establish observation freshness and bookmaker independence; multiple resellers
   of the same bookmaker are not independent markets.
5. Add captured pregame fixtures and integration tests before changing any scoring
   or verification consumer. Current scoring files remain unchanged.

References: https://oddspapi.io/us/docs,
https://oddspapi.io/blog/mlb-odds-api-run-lines-totals/,
https://odds-api.net/docs, https://odds-api.net/coverage.

Run `npm run test:external-audit`, `npm test` and `npm run build`.
Mock tests prove local failure handling, not provider availability or freshness.
