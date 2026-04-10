# CorpSignal MCP

**One-line summary:** Real-time entity compliance intelligence — KYB lookups, sanctions screening, risk scoring, filings, and beneficial ownership across US (all 50 states), UK, and Canada, served from a cache-first Redis layer at sub-400ms p95 latency.

---

## Features

- **Entity lookup** (`entity_lookup`) — Resolves a company name against official registries: 4 live US SOS REST APIs (DE, NY, IL, GA), 32 additional US states via structured portals, all 5 Canadian registries (federal ISED, BC, Ontario, Alberta, Quebec), and UK Companies House. Falls through to SEC EDGAR for any US entity not found at the state level. Returns status (active / dissolved / unknown), incorporation date, registered agent, officers list, and source registry.

- **Sanctions screening** (`sanctions_screen`) — Fuzzy-matched name screen against 6 consolidated lists ingested nightly: OFAC SDN (~18,700 entries), OFAC Consolidated (~440), EU CFSP (~5,860), HM Treasury (~5,140), UN Security Council 1267 (~270), FinCEN Civil Money Penalties (~120). Returns hit list with matched name, alias, sanctions programme, and listing date. Configurable minimum score threshold (default 0.75).

- **Compliance risk score** (`compliance_risk_score`) — Composite 0–100 risk score with full factor breakdown: entity status (active = low base, dissolved/unknown = elevated), sanctions exposure (any hit = +40), offshore jurisdiction flag (BVI, Cayman, Panama, etc. = +15), filing recency (>3 years stale = +10), and officer count anomaly (<2 officers = +5). Returns score, band (low / medium / high / critical), and per-factor detail so the reasoning is auditable.

- **Filings fetch** (`filings_fetch`) — Retrieves recent SEC EDGAR filings for US entities (10-K, 10-Q, 8-K, DEF 14A, S-1, and more) and SEDAR+ filings for Canadian entities. Returns filing type, title, filing date, and direct accession link. Configurable limit (default 10, max 50) and optional filing-type filter.

- **Beneficial owners** (`beneficial_owners`) — Three-layer ownership resolution: (1) GLEIF LEI registry for direct and ultimate parent relationships for any entity with an LEI; (2) SEC EDGAR Schedule 13G/D for US public companies with >5% shareholders; (3) UK Companies House PSC register for UK entities. Returns owner name, ownership percentage or threshold, ownership type, and data source.

- **Cache-first architecture** — All five tools read from Redis first (TTL 24 h for entity/sanctions data, 6 h for filings). Background cron jobs refresh sanctions lists on startup and nightly. p95 cache-hit latency is under 400 ms.

- **Billing integration** — Each tool call is metered via the Context Protocol billing middleware using `CONTEXT_API_KEY`. Rates: entity_lookup $0.001, sanctions_screen $0.001, filings_fetch $0.002, beneficial_owners $0.003, compliance_risk_score $0.005.

---

## Try asking

**Quick start — single entity check**
> "Look up Acme Holdings LLC incorporated in Delaware."

**Discovery — unknown jurisdiction**
> "Find me everything you can about Maple Leaf Ventures Inc — I think it's Canadian but I'm not sure which province."

**Comparative — side-by-side risk**
> "Score the compliance risk for both Brightwater Capital Ltd (UK) and Brightwater Capital LLC (US-DE) and tell me which is higher risk and why."

**Deep analysis — full KYB workflow**
> "Run a full KYB on Nexus Global Trading Corp registered in Wyoming: entity status, sanctions screen on the company and its officers, beneficial owners, and the last five SEC filings."

**Workflow chain — onboarding checklist**
> "I need to onboard Horizon Infrastructure Partners LP (US-TX). Check if the entity is active, screen it for sanctions, get the beneficial owners, and give me a final risk score."

**Risk / edge-case — offshore flag**
> "What is the compliance risk score for Caledonian Holding Company Ltd registered in the Cayman Islands, and which specific factors are driving the score?"

**Power-user — bulk screening**
> "Screen these five counterparties for sanctions hits with a minimum match score of 0.85: [list]. Flag any that appear on EU CFSP or HM Treasury lists specifically."

---

## Agent tips

**Workflow sequence for KYB onboarding:**
1. `entity_lookup` — confirm the entity is active and get its canonical name + officers
2. `sanctions_screen` — screen the canonical entity name, then screen each officer name individually
3. `beneficial_owners` — identify ultimate parent and >5% holders
4. `compliance_risk_score` — get the composite score and factor breakdown for the decision record
5. `filings_fetch` — pull recent filings if additional financial due diligence is required

**Always use canonical names from `entity_lookup` for downstream calls.** The name returned in `canonical_name` is the exact registered form. Using a trade name or abbreviation in `sanctions_screen` reduces match accuracy.

**Jurisdiction codes follow ISO 3166-2 subdivision format:**
- US states: `US-DE`, `US-NY`, `US-CA`, etc.
- Canadian provinces: `CA-BC`, `CA-ON`, `CA-AB`, `CA-QC`; federal: `CA`
- United Kingdom: `GB`
- Pass the most specific jurisdiction you know — it routes to the correct registry directly instead of falling through to EDGAR.

**Sanctions threshold tuning:** The default minimum score of `0.75` balances recall and precision. For high-risk onboarding workflows, lower to `0.70` to catch near-matches. For bulk name screening where false positives are costly, raise to `0.85`.

**`compliance_risk_score` is deterministic and auditable.** The `factors` array in the response lists every signal and its contribution. Include this array in your compliance record — it documents the basis for the risk decision without requiring a human to re-run the check.

**Beneficial owners for private companies:** `beneficial_owners` uses GLEIF LEI for structural ownership. If an entity has no LEI (common for small private firms), the tool returns an empty owners list rather than an error — this is expected and should be noted in the compliance record as "LEI not registered; manual verification required."

**Filings for research:** Use `filing_types` to filter — e.g., `["SC 13G", "SC 13D"]` to fetch only beneficial ownership disclosures directly from EDGAR, independent of the `beneficial_owners` tool.
