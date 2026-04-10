# Grant Review Submission — CorpSignal MCP

**To:** grants@ctxprotocol.com
**Subject:** CorpSignal MCP — Grant Review Submission

---

## Tool Details

**Tool name:** CorpSignal MCP

**Endpoint URL:** `https://YOUR-SERVICE.onrender.com/mcp`
*(replace with your live Render URL after deployment)*

**Tool ID:** `[PASTE YOUR TOOL ID FROM ctxprotocol.com → Developer → Tools]`
*(copy the ID shown on your tool card — used for testing identification)*

**Public GitHub repo:** `https://github.com/YOUR_USERNAME/YOUR_REPO`
*(link to the repository containing this MCP server codebase)*

**Wallet address:** `[PASTE YOUR WALLET ADDRESS FOR PAYMENT VERIFICATION]`

---

## 5 Must-Win Prompts

### Prompt 1 — Entity lookup: active Delaware company

**Prompt:**
> "Look up Stripe Inc in Delaware and tell me if it is an active registered entity."

**Tool called:** `entity_lookup`

**Input:**
```json
{
  "entity_name": "Stripe Inc",
  "jurisdiction": "US-DE",
  "include_officers": true,
  "include_registered_agent": true
}
```

**Expected evidence fields:**
| Field | Expected value |
|-------|---------------|
| `status` | `"active"` |
| `jurisdiction` | `"US-DE"` |
| `source` | `"delaware_sos"` |
| `canonical_name` | Exact registered name from DE SOS |
| `incorporated_at` | ISO date string (not null) |
| `registered_agent.name` | Non-empty string |
| `confidence` | ≥ 0.85 |
| `data_freshness` | `"fresh"` |

**Expected response shape (Execute):**
```json
{
  "entity_id": "corpsig_us_de_stripe_inc",
  "canonical_name": "Stripe, Inc.",
  "jurisdiction": "US-DE",
  "status": "active",
  "incorporated_at": "2011-...",
  "registered_agent": { "name": "...", "address": "..." },
  "officers": [ { "name": "...", "role": "...", "since": "..." } ],
  "source": "delaware_sos",
  "source_url": "https://icis.corp.delaware.gov/...",
  "freshness_secs": 0,
  "confidence": 0.97,
  "data_freshness": "fresh"
}
```

---

### Prompt 2 — Sanctions screen: clean entity returns `clear: true`

**Prompt:**
> "Screen Barclays Bank PLC for sanctions across all lists."

**Tool called:** `sanctions_screen`

**Input:**
```json
{
  "entity_name": "Barclays Bank PLC",
  "jurisdiction": "GB",
  "lists": ["OFAC_SDN", "OFAC_CONS", "FinCEN", "UN_1267", "EU_CFSP", "HM_TREASURY"],
  "fuzzy_threshold": 0.85
}
```

**Expected evidence fields:**
| Field | Expected value |
|-------|---------------|
| `clear` | `true` |
| `hits` | `[]` (empty array) |
| `lists_checked` | All 6 lists present |
| `screened_at` | ISO 8601 timestamp |
| `fuzzy_candidates` | Array (may contain near-miss candidates for human review) |
| `data_freshness` | `"fresh"` |

**Expected response shape (Execute):**
```json
{
  "entity_name": "Barclays Bank PLC",
  "screened_at": "2024-...",
  "clear": true,
  "hits": [],
  "fuzzy_candidates": [],
  "lists_checked": ["OFAC_SDN", "OFAC_CONS", "FinCEN", "UN_1267", "EU_CFSP", "HM_TREASURY"],
  "freshness_secs": 0,
  "data_freshness": "fresh"
}
```

---

### Prompt 3 — Compliance risk score: full factor breakdown

**Prompt:**
> "Give me a compliance risk score for Acme Holdings LLC registered in Delaware, and show me every factor that contributed to the score."

**Tool called:** `compliance_risk_score`

**Input:**
```json
{
  "entity_name": "Acme Holdings LLC",
  "jurisdiction": "US-DE"
}
```

**Expected evidence fields:**
| Field | Expected value |
|-------|---------------|
| `risk_score` | Number in range 0–1 |
| `risk_tier` | One of `"low"`, `"medium"`, `"high"`, `"critical"` |
| `score_breakdown` | Array with ≥ 3 signal objects |
| `score_breakdown[*].signal` | Named signal (e.g. `"registration_status"`, `"sanctions_clear"`, `"offshore_jurisdiction"`) |
| `score_breakdown[*].weight` | Number 0–1 |
| `score_breakdown[*].contribution` | Number (weighted delta to score) |
| `score_breakdown[*].source` | Non-empty string (e.g. `"delaware_sos"`, `"OFAC_SDN"`) |
| `formula_version` | Non-empty string (e.g. `"v1.0"`) |
| `data_freshness` | `"fresh"` |

**Expected response shape (Execute):**
```json
{
  "entity_id": "corpsig_us_de_acme_holdings_llc",
  "canonical_name": "Acme Holdings LLC",
  "jurisdiction": "US-DE",
  "risk_score": 0.12,
  "risk_tier": "low",
  "score_breakdown": [
    {
      "signal": "registration_status",
      "value": "active",
      "weight": 0.35,
      "contribution": 0.0,
      "source": "delaware_sos"
    },
    {
      "signal": "sanctions_clear",
      "value": true,
      "weight": 0.40,
      "contribution": 0.0,
      "source": "OFAC_SDN"
    },
    {
      "signal": "offshore_jurisdiction",
      "value": false,
      "weight": 0.15,
      "contribution": 0.0,
      "source": "jurisdiction_classifier"
    }
  ],
  "formula_version": "v1.0",
  "scored_at": "2024-...",
  "freshness_secs": 0,
  "data_freshness": "fresh"
}
```

---

### Prompt 4 — Filings fetch: recent SEC EDGAR filings with type filter

**Prompt:**
> "Fetch the last 5 annual reports (10-K filings) for Apple Inc."

**Tool called:** `filings_fetch`

**Input:**
```json
{
  "entity_name": "Apple Inc",
  "jurisdiction": "US-DE",
  "filing_types": ["10-K"],
  "limit": 5,
  "parse_financials": false
}
```

**Expected evidence fields:**
| Field | Expected value |
|-------|---------------|
| `filings` | Array with ≥ 1 item |
| `filings[*].type` | `"10-K"` |
| `filings[*].date` | ISO date string |
| `filings[*].url` | Non-null EDGAR URL (`https://www.sec.gov/...`) |
| `filings[*].source` | `"EDGAR"` |
| `total_available` | Integer > 0 |
| `data_freshness` | `"fresh"` |

**Expected response shape (Execute):**
```json
{
  "entity_id": "corpsig_us_de_apple_inc",
  "canonical_name": "Apple Inc.",
  "jurisdiction": "US-DE",
  "filings": [
    {
      "filing_id": "0000320193-23-000106",
      "type": "10-K",
      "date": "2023-11-03",
      "description": "Annual report [Sections 13 or 15(d)]",
      "url": "https://www.sec.gov/Archives/edgar/data/320193/...",
      "source": "EDGAR"
    }
  ],
  "financials": null,
  "total_available": 38,
  "source": "EDGAR",
  "freshness_secs": 0,
  "data_freshness": "fresh"
}
```

---

### Prompt 5 — Beneficial owners: UK PSC register lookup

**Prompt:**
> "Who are the beneficial owners of Revolut Ltd in the UK?"

**Tool called:** `beneficial_owners`

**Input:**
```json
{
  "entity_name": "Revolut Ltd",
  "jurisdiction": "GB",
  "include_indirect": false
}
```

**Expected evidence fields:**
| Field | Expected value |
|-------|---------------|
| `owners` | Array with ≥ 1 item (or `disclosure_status: "unavailable"` if no PSC registered) |
| `owners[*].name` | Non-empty string |
| `owners[*].control_type` | One of `"ownership"`, `"voting_rights"`, `"appointment_rights"`, `"other"` |
| `owners[*].source` | `"UK_PSC"` |
| `owners[*].indirect` | `false` (direct owners only) |
| `disclosure_status` | `"full"` or `"partial"` |
| `data_freshness` | `"fresh"` |

**Expected response shape (Execute):**
```json
{
  "entity_id": "corpsig_gb_revolut_ltd",
  "canonical_name": "REVOLUT LTD",
  "jurisdiction": "GB",
  "owners": [
    {
      "owner_id": null,
      "name": "Nikolay Storonsky",
      "ownership_pct": null,
      "control_type": "ownership",
      "indirect": false,
      "nationality": "GB",
      "source": "UK_PSC",
      "notified_on": "2017-07-01"
    }
  ],
  "disclosure_status": "full",
  "source": "UK Companies House PSC Register",
  "freshness_secs": 0,
  "data_freshness": "fresh"
}
```

---

## Notes for Reviewer

- All 5 tools are Execute methods (MCP `tools/call`). There are no Query-mode tools in this server.
- The MCP endpoint returns Server-Sent Events — requests must include `Accept: application/json, text/event-stream`.
- In production (`NODE_ENV=production`), all calls are metered via `CONTEXT_API_KEY`. For testing without billing, set `NODE_ENV=development`.
- Redis must be running for cache reads to work. On a cold cache, the server fetches live from upstream registries and caches the result.
- Full curl test commands are documented in `DEPLOY.md` in the repository root.
