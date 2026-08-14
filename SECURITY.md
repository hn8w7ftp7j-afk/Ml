# Security Policy

This repository must never contain live API keys, passwords, cookies, exported betting data, or user screenshots.

## Production requirements

- Store `AI_GATEWAY_API_KEY`, `APP_PASSWORD`, `SESSION_SECRET`, `MARKET_INTEGRITY_SECRET`, and `READER_PAIR_SECRET` only in Vercel Environment Variables.
- `APP_PASSWORD` and an independent high-entropy `SESSION_SECRET` are both required. The site fails closed when either is absent.
- Market and reprice-snapshot HMACs use only `MARKET_INTEGRITY_SECRET` or `SESSION_SECRET`; login and Tai888 passwords are never integrity keys.
- `READER_PAIR_SECRET` must be independent and never fall back to `TAI888_PASSWORD`.
- Treat MLB official schedule verification as a security dependency. Schedule outages must stop signing/analysis with a 502 response.
- Keep the GitHub repository private for normal operation.
- Enable Vercel Firewall rate limiting for `/api/vision` and `/api/analyze`.
- Rotate any secret immediately if it appears in a screenshot, log, commit, issue, or chat.
- Review Dependabot alerts and upgrade Next.js/React promptly.

## Reporting

Do not open a public issue containing secrets or exploit details. Revoke the affected secret first, then contact the repository owner privately.
