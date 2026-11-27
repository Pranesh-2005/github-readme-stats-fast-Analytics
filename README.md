# README Stats Analytics

Dashboard for github-readme-stats-fast usage, read from Axiom. Built to run on a Vercel
account shared with other apps, so it spends as little quota as possible.

## Local
```
node server.mjs          # http://127.0.0.1:4317, reads .env, no key needed
```

## Deploy (Vercel, framework "Other", no build)
Set these env vars on the project:
- `AXIOM_QUERY_TOKEN` read-only Axiom token (query on the dataset only)
- `AXIOM_DOMAIN` e.g. `us-east-1.aws.edge.axiom.co`
- `AXIOM_DATASET` `ghstats`
- `EXCLUDE_USERS` comma list of test users to hide
- `DASH_KEY` long random string. Required: without it the API refuses every call.
- `VERCEL_TOKENS` optional, `acc1:<token>,acc3:<token>` (labels = ANALYTICS_APP of the stats app).
  Adds total requests and CDN cache hits from Vercel's usage API. Only accounts that served the
  main URL in the range are counted. These are full-access Vercel tokens: create dedicated ones
  with an expiry, and mark them Sensitive.

`server.mjs`, `.env`, `server.log` and this README are excluded by `.vercelignore`.

## Quota budget
- Page: one file (CSS + JS inlined), browser-cached 1 h. No other static requests.
- Data: one function call runs all 9 Axiom queries in parallel (maxDuration 15 s).
- Browser cache: inside the TTL a reload makes zero API calls.
- Server cache: per range, TTL floor 5 min; Sync is throttled to once a minute.
- Hidden tabs never poll. Calls without the right `x-dash-key` stop before any Axiom query.
- Rough cost of leaving it open 8 h/day at the 15 min default: about 40 Vercel requests
  and 32 function calls a day, around 1,200 a month.
