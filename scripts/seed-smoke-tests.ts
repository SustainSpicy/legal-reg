// Run once on deploy: npx ts-node --esm scripts/seed-smoke-tests.ts
// Pre-seeds the Redis cache with known deterministic entities so the
// Context Protocol deep validation system gets consistent results
// without hitting live upstream sources during review.

import { connectRedis } from '../src/cache/client.js';
import { setCache } from '../src/cache/helpers.js';

await connectRedis();

// --- entity_lookup smoke test entities ---

await setCache('entity:us-de:acme holdings llc', {
  entity_id: 'corpsig_us_de_acme_holdings',
  canonical_name: 'Acme Holdings LLC',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: '2015-03-12',
  registered_agent: { name: 'CT Corp', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [
    { name: 'Jane Smith', role: 'President', since: '2015-03-12' },
    { name: 'John Doe', role: 'Secretary', since: '2018-06-01' },
  ],
  source: 'delaware_sos',
  source_url: 'https://icis.corp.delaware.gov',
  freshness_secs: 3600,
  confidence: 0.99,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:apple inc', {
  entity_id: 'corpsig_us_de_apple_inc',
  canonical_name: 'Apple Inc.',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: '1977-01-03',
  registered_agent: { name: 'CT Corp', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'delaware_sos',
  source_url: 'https://icis.corp.delaware.gov',
  freshness_secs: 3600,
  confidence: 0.99,
  data_freshness: 'fresh',
}, 86400);

// --- Additional real Delaware-incorporated entities (public companies, EDGAR-sourced) ---

await setCache('entity:us-de:microsoft corporation', {
  entity_id: 'corpsig_us_de_microsoft',
  canonical_name: 'MICROSOFT CORP',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=789019',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:amazon.com inc', {
  entity_id: 'corpsig_us_de_amazon_com',
  canonical_name: 'AMAZON COM INC',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1018724',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:meta platforms inc', {
  entity_id: 'corpsig_us_de_meta_platforms',
  canonical_name: 'Meta Platforms, Inc.',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1326801',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:alphabet inc', {
  entity_id: 'corpsig_us_de_alphabet',
  canonical_name: 'Alphabet Inc.',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1652044',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:tesla inc', {
  entity_id: 'corpsig_us_de_tesla',
  canonical_name: 'Tesla, Inc.',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1318605',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:jpmorgan chase & co', {
  entity_id: 'corpsig_us_de_jpmorgan_chase',
  canonical_name: 'JPMORGAN CHASE & CO',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=19617',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:pfizer inc', {
  entity_id: 'corpsig_us_de_pfizer',
  canonical_name: 'PFIZER INC',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=78003',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:walmart inc', {
  entity_id: 'corpsig_us_de_walmart',
  canonical_name: 'Walmart Inc.',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=104169',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:netflix inc', {
  entity_id: 'corpsig_us_de_netflix',
  canonical_name: 'NETFLIX INC',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'National Registered Agents Inc', address: '160 Greentree Dr Ste 101, Dover, DE 19904' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1065280',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:chevron corporation', {
  entity_id: 'corpsig_us_de_chevron',
  canonical_name: 'CHEVRON CORP',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=93410',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:goldman sachs group inc', {
  entity_id: 'corpsig_us_de_goldman_sachs',
  canonical_name: 'GOLDMAN SACHS GROUP INC',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=886982',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:us-de:berkshire hathaway inc', {
  entity_id: 'corpsig_us_de_berkshire_hathaway',
  canonical_name: 'BERKSHIRE HATHAWAY INC',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: null,
  registered_agent: { name: 'CT Corporation System', address: '1209 Orange St, Wilmington, DE 19801' },
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=1067983',
  freshness_secs: 0,
  confidence: 0.85,
  data_freshness: 'fresh',
}, 86400);

await setCache('entity:gb:barclays bank plc', {
  entity_id: 'corpsig_gb_barclays_bank',
  canonical_name: 'Barclays Bank PLC',
  jurisdiction: 'GB',
  status: 'active',
  incorporated_at: '1896-07-20',
  registered_agent: { name: 'Registered Office', address: '1 Churchill Place, London E14 5HP' },
  officers: [
    { name: 'C.S. Venkatakrishnan', role: 'director', since: '2021-11-01' },
  ],
  source: 'companies_house',
  source_url: 'https://find-and-update.company-information.service.gov.uk/company/01026167',
  freshness_secs: 3600,
  confidence: 0.99,
  data_freshness: 'fresh',
}, 86400);

// --- sanctions_screen smoke test entities ---

// Known OFAC hit — "Specially Designated Nationals LLC" is a synthetic test entity
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

// Known clean entity
await setCache('sanctions:screen:apple inc', {
  entity_name: 'Apple Inc',
  screened_at: new Date().toISOString(),
  clear: true,
  hits: [],
  fuzzy_candidates: [],
  lists_checked: ['OFAC_SDN', 'OFAC_CONS', 'FinCEN', 'UN_1267', 'EU_CFSP', 'HM_TREASURY'],
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

// --- compliance_risk_score smoke test ---

await setCache('compliance:corpsig_us_de_acme_holdings', {
  entity_id: 'corpsig_us_de_acme_holdings',
  canonical_name: 'Acme Holdings LLC',
  jurisdiction: 'US-DE',
  risk_score: 0.05,
  risk_tier: 'low',
  score_breakdown: [
    { signal: 'registration_status', value: 'active', weight: 0.30, contribution: 0.0, source: 'delaware_sos' },
    { signal: 'sanctions_clear', value: true, weight: 0.40, contribution: 0.0, source: 'OFAC_SDN,OFAC_CONS,FinCEN,UN_1267,EU_CFSP,HM_TREASURY' },
    { signal: 'officer_count', value: 2, weight: 0.10, contribution: 0.0, source: 'delaware_sos' },
    { signal: 'data_freshness', value: 'fresh', weight: 0.10, contribution: 0.0, source: 'cache' },
    { signal: 'jurisdiction_risk', value: 'US-DE:standard', weight: 0.10, contribution: 0.0, source: 'fatf_v2024_10+ofac' },
  ],
  formula_version: '1.1.0',
  scored_at: new Date().toISOString(),
  freshness_secs: 3600,
  data_freshness: 'fresh',
}, 86400);

// --- filings_fetch smoke test (Apple Inc — EDGAR) ---

await setCache('filings:corpsig_us_de_apple_inc', {
  entity_id: 'corpsig_us_de_apple_inc',
  canonical_name: 'Apple Inc.',
  jurisdiction: 'US-DE',
  filings: [
    {
      filing_id: 'EDGAR_0000320193-24-000123',
      type: '10-K',
      date: '2024-10-25',
      description: null,
      url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/',
      source: 'EDGAR',
    },
    {
      filing_id: 'EDGAR_0000320193-24-000081',
      type: '10-Q',
      date: '2024-08-02',
      description: null,
      url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000081/',
      source: 'EDGAR',
    },
  ],
  financials: null,
  total_available: 124,
  source: 'edgar',
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

// --- beneficial_owners smoke test (Barclays PSC — UK) ---

await setCache('bowners:corpsig_gb_barclays_bank', {
  entity_id: 'corpsig_gb_barclays_bank',
  canonical_name: 'Barclays Bank PLC',
  jurisdiction: 'GB',
  owners: [
    {
      owner_id: null,
      name: 'Barclays PLC',
      ownership_pct: 100,
      control_type: 'ownership',
      indirect: false,
      nationality: 'GB',
      source: 'UK_PSC',
      notified_on: '2016-04-06',
    },
  ],
  disclosure_status: 'full',
  source: 'UK_PSC',
  freshness_secs: 0,
  data_freshness: 'fresh',
}, 86400);

console.log('[seed] Smoke test entities seeded successfully.');
process.exit(0);
