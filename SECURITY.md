# Security Policy

This repository must never contain live API keys, passwords, cookies, exported betting data, or user screenshots.

## Production requirements

- Store `AI_GATEWAY_API_KEY`, `APP_PASSWORD`, and `SESSION_SECRET` only in Vercel Environment Variables.
- Keep the GitHub repository private for normal operation.
- Enable Vercel Firewall rate limiting for `/api/vision` and `/api/analyze`.
- Rotate any secret immediately if it appears in a screenshot, log, commit, issue, or chat.
- Review Dependabot alerts and upgrade Next.js/React promptly.

## Reporting

Do not open a public issue containing secrets or exploit details. Revoke the affected secret first, then contact the repository owner privately.
