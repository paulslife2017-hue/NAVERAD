# NAVERAD

NAVER Search Ad dashboard and automation scripts.

## Setup

Install dependencies:

```txt
npm install
```

Run the dashboard:

```txt
npm run dev
```

Deploy:

```txt
npm run deploy
```

## Required Environment Variables

Set these in Vercel, Cloudflare/PM2 host, and any server that runs the Python schedulers:

```txt
NAVER_ACCESS_LICENSE=...
NAVER_SECRET_KEY=...
NAVER_CUSTOMER_ID=...
DASHBOARD_URL=https://your-dashboard.example.com
```

Backward-compatible aliases are also read for the first two values:

```txt
NAVER_API_KEY
NAVER_API_SECRET
```

## Security Notes

- API keys must never be committed to GitHub.
- The old keys that were previously committed should be revoked and reissued in NAVER Search Ad.
- After setting new environment variables, redeploy the dashboard and restart PM2 scheduler processes.
- Protect write endpoints such as `/api/bid`, `/api/history-write`, and `/api/cache` before exposing this publicly.
