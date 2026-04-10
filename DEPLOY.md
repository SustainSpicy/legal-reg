# CorpSignal MCP — Render Deployment Guide

## What you're deploying

A Node.js MCP server that provides entity compliance lookups (KYB), sanctions screening,
and risk scoring for US (all 50 states), UK, and Canada. Runs with a Redis cache sidecar.

---

## Prerequisites

- A [Render](https://render.com) account
- The live API keys (provided separately — do NOT commit these to git)

---

## Step 1 — Create a Redis instance on Render

1. In the Render dashboard, click **New → Redis**
2. Name it `corpsignal-redis`
3. Choose the **Starter** plan (or higher for production load)
4. Click **Create Redis**
5. Once created, copy the **Internal Redis URL** — it looks like:
   `redis://red-xxxxxxxxxxxx:6379`
   You will need this in Step 3.

---

## Step 2 — Create a Web Service on Render

1. Click **New → Web Service**
2. Choose **Deploy an existing image** → No, choose **Deploy from source code**
3. Connect your Git repo (push this codebase to GitHub/GitLab first), OR choose
   **Upload files** if Render supports it, OR use the Render CLI (see Step 2b below)
4. Set the following:
   - **Runtime**: Docker
   - **Dockerfile path**: `./Dockerfile`
   - **Instance type**: Starter (512 MB RAM minimum; Standard recommended)
   - **Port**: `3000`

### Step 2b — If deploying without Git (zip upload)

Render does not support zip uploads directly. The easiest path without Git:

1. Create a free GitHub account if you don't have one
2. Create a new **private** repository
3. Extract this zip, then from inside the folder:
   ```bash
   git init
   git add .
   git commit -m "initial"
   git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
   git push -u origin main
   ```
4. Then connect that GitHub repo in the Render dashboard

---

## Step 3 — Set environment variables

In the Render Web Service → **Environment** tab, add these variables:

| Key | Value | Notes |
|-----|-------|-------|
| `REDIS_URL` | `redis://red-xxxxxxxxxxxx:6379` | The Internal URL from Step 1 |
| `NODE_ENV` | `production` | Enables billing middleware |
| `PORT` | `3000` | Must match the port Render expects |
| `CONTEXT_API_KEY` | *(provided separately)* | Context Protocol billing key |
| `COMPANIES_HOUSE_API_KEY` | *(provided separately)* | UK entity lookups + PSC |
| `EDGAR_CONTACT_EMAIL` | *(your real email)* | Required by SEC — use a real address |

> **Important:** Never commit `.env` to Git. These values must only be set in the
> Render dashboard environment tab.

---

## Step 4 — Deploy

1. Click **Create Web Service** — Render will build the Docker image (~5–8 minutes
   on first deploy; subsequent deploys use the layer cache)
2. Watch the deploy log — you should see:
   ```
   [cache] Redis connected
   [ingest:sanctions] Refreshing OFAC_SDN...
   [ingest:sanctions] OFAC_SDN — 18698 entries cached
   ...
   [server] CorpSignal MCP running on :3000
   ```

---

## Step 5 — Seed the Redis cache

Once the service is running, open a **Shell** in the Render dashboard
(Web Service → Shell tab) and run:

```bash
node dist/scripts/seed-smoke-tests.js
```

You should see:
```
[cache] Redis connected
[seed] Smoke test entities seeded successfully.
```

This pre-warms the cache with known test entities so the Context Protocol
validation system gets deterministic results.

---

## Step 6 — Verify

Check the health endpoint (replace with your Render URL):

```bash
curl https://YOUR-SERVICE.onrender.com/health
# → {"status":"ok","version":"1.0.0","timestamp":"..."}
```

Test a live tool call:

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "entity_lookup",
      "arguments": {
        "entity_name": "Acme Holdings LLC",
        "jurisdiction": "US-DE"
      }
    }
  }'
```

Expected response contains `"status":"active"` and `"source":"delaware_sos"`.

---

## Troubleshooting

**Redis connection error on startup**
- Double-check `REDIS_URL` is the Internal URL (not External) from Render Redis
- Internal URLs only work between services in the same Render region

**`[server] WARNING: EDGAR_CONTACT_EMAIL is a placeholder`**
- Set `EDGAR_CONTACT_EMAIL` to a real email in the Render environment tab

**`Unauthorized` on MCP calls**
- Ensure `CONTEXT_API_KEY` is set to a valid live key (`sk_live_...`)
- Ensure `NODE_ENV=production` (not `development`)

**Build fails on `npm ci`**
- Node 22 is required — Render's Docker build will use the version in the Dockerfile
  (`node:22-alpine`), so this should not be an issue

**Slow first response after deploy**
- Render free/starter instances spin down after inactivity. Upgrade to a paid instance
  type or use Render's **Always On** setting to prevent cold starts.

---

## MCP endpoint

Once live, the MCP endpoint for the Context Protocol registry is:

```
https://YOUR-SERVICE.onrender.com/mcp
```
