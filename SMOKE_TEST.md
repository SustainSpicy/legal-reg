# CorpSignal — Smoke Test Guide

This guide lets a reviewer independently verify that the SOS scrapers resolve real
entities, populate the cache, and that all downstream guards are in place.

## Prerequisites

```
npm install
cp .env.example .env          # fill in REDIS_URL (local Redis or Upstash)
npm run seed                  # seed synthetic Acme Holdings LLC for unit tests
```

Playwright is already installed as a dependency; no separate install needed.

## 1 — Unit tests (mocked, no network)

```
npm test
```

Expected: **all tests pass** (351 tests across 21 suites). These cover:
- ICIS 3-step DE scraper logic
- SOS sources: CA, NY, TX, FL, CO, WA, IL, GA
- Entity-ID contamination guards (`MIN_ENTITY_CONFIDENCE = 0.7`)
- EDGAR fallback gating (`SOS_PORTAL_LIVE` blocks EDGAR for live-portal states)
- Sanctions matching, compliance scoring, entity resolver pipeline

## 2 — Delaware SOS smoke test (15 Fortune 500 entities, live ICIS)

```
npm run smoke:de
```

Hits ICIS live for 15 DE-incorporated Fortune 500 companies (Amazon, Alphabet, Meta,
Tesla, JPMorgan, Pfizer, Visa, Oracle, Uber, Airbnb, Stripe, PayPal, Walmart, Home
Depot, Costco), writes each to Redis, then reads back to confirm cache write.

Expected output per entity:
```
✓ Amazon.com Inc (US-DE)  →  delaware_sos   conf=0.90  cache=✓
```

Exit code 0 = at least one entity resolved; non-zero = all failed.

## 3 — Other SOS state smoke tests

```
npm run smoke:ny    # 5 NY domestic corps (Corning, NY Life, Con Ed, Regeneron, Loews)
npm run smoke:tx    # 6 TX corps (AT&T, ConocoPhillips, Sysco, TI, Enterprise, Halliburton)
npm run smoke:ca    # 5 CA public companies via EDGAR fallback (BizFile is Incapsula-blocked)
npm run smoke       # all 31 entities across DE / CA / NY / TX
```

## 4 — Entity-ID contamination check (manual MCP call)

Start the server (`npm run dev`) and issue:

```json
{ "tool": "entity_lookup",
  "arguments": { "entity_name": "Totally Unknown Corp XYZ 999", "jurisdiction": "US-DE" } }
```

Expected: `ENTITY_NOT_FOUND` structured error, **not** a result for a different company.

Then call `compliance_risk_score`, `filings_fetch`, or `beneficial_owners` with
`entity_id: "corpsig_us_de_totally_unknown_corp_xyz_999"`.

Expected: `ENTITY_NOT_RESOLVED` structured error from every downstream tool.

## 5 — EDGAR / US-DE isolation check

```json
{ "tool": "entity_lookup",
  "arguments": { "entity_name": "Microsoft Corporation", "jurisdiction": "US-DE" } }
```

Microsoft is incorporated in Washington (US-WA), not Delaware. Expected: `ENTITY_NOT_FOUND`
for US-DE. EDGAR is not consulted for states in `SOS_PORTAL_LIVE` (DE, NY, TX, FL, CO,
WA, IL, GA) — a null SOS result is authoritative there.

## Architecture summary

| Layer | What it does |
|---|---|
| `src/ingest/sources/sos-delaware.ts` | 3-step ICIS ASPX scrape (GET ViewState → POST search → POST detail) |
| `src/ingest/sources/sos-*.ts` | NY/TX Socrata JSON, FL Sunbiz JSON+HTML, CO dual-Socrata+HTML, WA CCFS, IL JSON POST, GA eCorp JSON |
| `src/resolvers/entity-resolver.ts` | SOS portal → EDGAR fallback (gated by `SOS_PORTAL_LIVE`); 4-hour cache write-through |
| `src/tools/*.ts` | All 4 tools reject `confidence < 0.7 \|\| status === 'unknown'` via `MIN_ENTITY_CONFIDENCE` |
| `scripts/probe-sos-scrapers.ts` | Live probe / smoke runner — same binary as `npm run smoke:*` |
