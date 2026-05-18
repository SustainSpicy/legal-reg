// California Secretary of State — BizFile Online API
// Base: https://bizfileonline.sos.ca.gov
// The public search endpoint accepts JSON queries and returns structured results.
// No API key required, but the site is protected by Incapsula WAF.
//
// Resolution order:
//   1. Plain fetch (fast; works from residential IPs or if WAF rules relax)
//   2. Playwright + Decodo residential proxy (bypasses Incapsula; requires PROXY_SERVER in .env)
//
// If both fail the caller falls back to EDGAR for CA-incorporated public companies.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const CA_SEARCH_URL = 'https://bizfileonline.sos.ca.gov/api/Records/businesssearch';
const CA_SEARCH_PAGE = 'https://bizfileonline.sos.ca.gov/search/business';

interface CASearchResult {
  CORP_NUM: string;
  NAME: string;
  STATUS: string;
  ENTITY_TYPE: string;
  FILING_DATE: string | null;
  AGENT_NAME: string | null;
  AGENT_ADDRESS: string | null;
}

interface CASearchResponse {
  hits?: {
    hits?: Array<{
      _source?: CASearchResult;
    }>;
  };
}

function mapCAStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s === 'active' || s.includes('good')) return 'active';
  if (s.includes('dissol') || s.includes('cancel') || s.includes('void')) return 'dissolved';
  if (s.includes('suspend')) return 'suspended';
  return 'unknown';
}

function buildSearchBody(entityName: string): string {
  return JSON.stringify({
    SEARCH_VALUE: entityName,
    SEARCH_FILTER_TYPE_ID: '0',
    SEARCH_TYPE_ID: '1',
    sortColumn: 'score',
    sortOrder: 'desc',
    numberOfRows: 5,
    startRow: 0,
  });
}

function pickBestResult(
  data: CASearchResponse,
  entityName: string,
): EntityLookupOutputType | null {
  const hits = data?.hits?.hits ?? [];
  if (hits.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const ranked = hits
    .map((h) => h._source)
    .filter((s): s is CASearchResult => !!s)
    .map((s) => ({
      s,
      score: normaliseName(s.NAME) === normQuery ? 1 : 0.8,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;
  const { s } = best;

  return {
    entity_id: generateEntityId('US-CA', s.NAME),
    canonical_name: s.NAME,
    jurisdiction: 'US-CA',
    status: mapCAStatus(s.STATUS),
    incorporated_at: s.FILING_DATE ?? null,
    registered_agent: s.AGENT_NAME
      ? { name: s.AGENT_NAME, address: s.AGENT_ADDRESS ?? '' }
      : null,
    officers: [],
    source: 'california_sos',
    source_url: 'https://bizfileonline.sos.ca.gov/search/business',
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}

// ── Path 1: plain fetch ───────────────────────────────────────────────────────

async function fetchViaHttp(entityName: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch(CA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; CorpSignal/1.0; +https://corpsignal.com)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://bizfileonline.sos.ca.gov',
      'Referer': 'https://bizfileonline.sos.ca.gov/search/business',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
    body: buildSearchBody(entityName),
  }).catch(() => null);

  if (!res?.ok) {
    if (res?.status === 403) {
      console.warn('[sos-ca] BizFile returned 403 — Incapsula WAF block (will try Playwright)');
    }
    return null;
  }

  const data = await res.json().catch(() => null) as CASearchResponse | null;
  // Incapsula challenge pages are served as 200 HTML — detect non-JSON response
  if (!data?.hits) return null;

  return pickBestResult(data, entityName);
}

// ── Path 2: Playwright + Decodo residential proxy ────────────────────────────
// Playwright executes the Incapsula JS challenge; the residential IP passes the
// IP-reputation check. Once the page is loaded we call the search API from
// inside the browser context where the challenge cookie is already set.

async function fetchViaPlaywright(entityName: string): Promise<EntityLookupOutputType | null> {
  const proxyServer = process.env['PROXY_SERVER'];
  const proxyUsername = process.env['PROXY_USERNAME'];
  const proxyPassword = process.env['PROXY_PASSWORD'];

  if (!proxyServer) return null;

  let chromium: import('playwright').BrowserType;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn('[sos-ca] Playwright not available — skipping proxy path');
    return null;
  }

  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: `http://${proxyServer}`,
      username: proxyUsername,
      password: proxyPassword,
    },
  });

  try {
    const page = await browser.newPage();

    // Load the search page — Playwright executes the Incapsula JS challenge
    await page.goto(CA_SEARCH_PAGE, { waitUntil: 'networkidle', timeout: 45000 });

    // Make the API call from inside the browser context so the challenge cookie
    // and correct TLS fingerprint are already in place
    const body = buildSearchBody(entityName);
    const data = await page.evaluate(
      async ({ url, requestBody }: { url: string; requestBody: string }) => {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: requestBody,
        });
        if (!r.ok) return null;
        return r.json();
      },
      { url: CA_SEARCH_URL, requestBody: body },
    ) as CASearchResponse | null;

    if (!data?.hits) return null;

    const result = pickBestResult(data, entityName);
    if (result) {
      console.info(`[sos-ca] Playwright+proxy resolved '${entityName}' → ${result.canonical_name}`);
    }
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[sos-ca] Playwright lookup failed for '${entityName}': ${msg}`);
    return null;
  } finally {
    await browser.close();
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function lookupCaliforniaEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  // Try fast HTTP path first; fall through to Playwright only on WAF block
  const httpResult = await fetchViaHttp(entityName);
  if (httpResult) return httpResult;

  return fetchViaPlaywright(entityName);
}
