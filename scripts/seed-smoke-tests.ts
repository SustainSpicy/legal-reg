// Run once on deploy: npx ts-node --esm scripts/seed-smoke-tests.ts
//
// Seeds ONLY synthetic / fake test entities into Redis so the smoke test
// suite has deterministic data without relying on live upstream sources.
//
// IMPORTANT: Do NOT seed real companies here. Real entities (Apple, Microsoft,
// Barclays, etc.) must come from live ingest (EDGAR, OpenCorporates, Companies
// House) so that production queries reflect actual registration data.
// Seeding real companies with static officer/agent data causes stale records
// to be served in place of live data.

import { connectRedis } from '../src/cache/client.js';
import { setCache } from '../src/cache/helpers.js';

await connectRedis();

// ---------------------------------------------------------------------------
// entity_lookup — synthetic Delaware LLC
// ---------------------------------------------------------------------------
// "Acme Holdings LLC" is a fictional entity used exclusively for smoke tests.
// We write both the name-based key and the entity:id: reverse-index key so
// downstream tools (compliance, filings, bowners) can look it up by entity_id.

const acmeEntity = {
  entity_id: 'corpsig_us_de_acme_holdings',
  canonical_name: 'Acme Holdings LLC',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: '2015-03-12',
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [
    { name: 'Jane Smith', role: 'President', since: '2015-03-12' },
    { name: 'John Doe', role: 'Secretary', since: '2018-06-01' },
  ],
  source: 'delaware_sos',
  source_url: 'https://icis.corp.delaware.gov',
  freshness_secs: 0,
  confidence: 0.99,
  data_freshness: 'fresh',
};

await setCache('entity:us-de:acme holdings llc', acmeEntity, 86400);
// Reverse-index so entity_id-only calls to compliance/filings/bowners pass the guard
await setCache('entity:id:corpsig_us_de_acme_holdings', acmeEntity, 86400);

// ---------------------------------------------------------------------------
// sanctions_screen
// ---------------------------------------------------------------------------

// Synthetic OFAC hit — name mirrors the OFAC SDN list name format
await setCache('sanctions:screen:specially designated nationals llc', {
  entity_name: 'Specially Designated Nationals LLC',
  screened_at: new Date().toISOString(),
  clear: false,
  hits: [
    {
      list: 'OFAC_SDN',
      entry_id: 'OFAC_SMOKE_001',
      matched_name: 'Specially Designated Nationals LLC',
      score: 1.0,
      match_type: 'exact',
      listed_on: '2020-01-15',
      program: 'SDGT',
    },
  ],
  fuzzy_candidates: [],
  lists_checked: ['OFAC_SDN', 'OFAC_CONS', 'FinCEN', 'UN_1267', 'EU_CFSP', 'HM_TREASURY'],
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

// Known-clean entity
await setCache('sanctions:screen:acme holdings llc', {
  entity_name: 'Acme Holdings LLC',
  screened_at: new Date().toISOString(),
  clear: true,
  hits: [],
  fuzzy_candidates: [],
  lists_checked: ['OFAC_SDN', 'OFAC_CONS', 'FinCEN', 'UN_1267', 'EU_CFSP', 'HM_TREASURY'],
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

// ---------------------------------------------------------------------------
// compliance_risk_score — uses Acme entity above (2 officers → no officer penalty)
// ---------------------------------------------------------------------------

await setCache('compliance:corpsig_us_de_acme_holdings', {
  entity_id: 'corpsig_us_de_acme_holdings',
  canonical_name: 'Acme Holdings LLC',
  jurisdiction: 'US-DE',
  risk_score: 0.05,
  risk_tier: 'low',
  score_breakdown: [
    { signal: 'registration_status', value: 'active',   weight: 0.30, contribution: 0.00, source: 'delaware_sos' },
    { signal: 'sanctions_clear',     value: true,        weight: 0.40, contribution: 0.00, source: 'OFAC_SDN,OFAC_CONS,FinCEN,UN_1267,EU_CFSP,HM_TREASURY' },
    { signal: 'officer_count',       value: 2,           weight: 0.10, contribution: 0.00, source: 'delaware_sos' },
    { signal: 'data_freshness',      value: 'fresh',     weight: 0.10, contribution: 0.00, source: 'cache' },
    { signal: 'jurisdiction_risk',   value: 'US-DE:standard', weight: 0.10, contribution: 0.05, source: 'fatf_v2024_10+ofac' },
  ],
  formula_version: '1.1.0',
  scored_at: new Date().toISOString(),
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

// ---------------------------------------------------------------------------
// filings_fetch — synthetic EDGAR-style entries for Acme
// ---------------------------------------------------------------------------

await setCache('filings:corpsig_us_de_acme_holdings', {
  entity_id: 'corpsig_us_de_acme_holdings',
  canonical_name: 'Acme Holdings LLC',
  jurisdiction: 'US-DE',
  filings: [
    {
      filing_id: 'ACME_SMOKE_2024_10K',
      type: '10-K',
      date: '2024-03-31',
      description: 'Annual report',
      url: null,
      source: 'EDGAR',
    },
    {
      filing_id: 'ACME_SMOKE_2023_10K',
      type: '10-K',
      date: '2023-03-31',
      description: 'Annual report',
      url: null,
      source: 'EDGAR',
    },
  ],
  financials: null,
  total_available: 2,
  source: 'edgar',
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

// ---------------------------------------------------------------------------
// beneficial_owners — Acme Holdings LLC (small private LLC, CTA-exempt)
// ---------------------------------------------------------------------------

await setCache('bowners:corpsig_us_de_acme_holdings', {
  entity_id: 'corpsig_us_de_acme_holdings',
  canonical_name: 'Acme Holdings LLC',
  jurisdiction: 'US-DE',
  owners: [
    {
      owner_id: null,
      name: 'Jane Smith',
      ownership_pct: 100,
      control_type: 'ownership',
      indirect: false,
      nationality: 'US',
      source: 'GLEIF_LEI',
      notified_on: '2015-03-12',
    },
  ],
  disclosure_status: 'partial',
  source: 'GLEIF_LEI',
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

console.log('[seed] Smoke test entities seeded successfully.');
process.exit(0);
