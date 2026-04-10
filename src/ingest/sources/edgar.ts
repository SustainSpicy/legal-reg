// SEC EDGAR Full-Text Search API
// Free, official:
//   Company search: https://efts.sec.gov/LATEST/search-index?q=...
//   Submissions:    https://data.sec.gov/submissions/CIK{10-digit}.json
//   Company tickers: https://www.sec.gov/files/company_tickers.json (loaded once, cached)

import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { setCache, getCached } from '../../cache/helpers.js';

const SUBMISSIONS_BASE = 'https://data.sec.gov/submissions';
const TICKERS_URL = 'https://www.sec.gov/files/company_tickers.json';
const TICKERS_CACHE_KEY = 'edgar:company_tickers';
const TICKERS_TTL = 86400; // 24h — tickers file changes infrequently

function edgarHeaders(): Record<string, string> {
  const contact = process.env['EDGAR_CONTACT_EMAIL'] ?? 'compliance@corpsignal.io';
  return {
    'User-Agent': `CorpSignal-MCP/1.0 (${contact})`,
    Accept: 'application/json',
  };
}

interface TickerEntry {
  cik_str: number;
  title: string;
  ticker: string;
}

interface EDGARSubmissions {
  cik: string;
  name: string;
  stateOfIncorporation?: string;
  filings: {
    recent: {
      form: string[];
      filingDate: string[];
      accessionNumber: string[];
    };
  };
}

async function loadTickerMap(): Promise<Record<string, TickerEntry>> {
  const cached = await getCached<Record<string, TickerEntry>>(TICKERS_CACHE_KEY);
  if (cached) return cached;

  const res = await fetch(TICKERS_URL, { headers: edgarHeaders() });
  if (!res.ok) throw new Error(`EDGAR tickers fetch failed: ${res.status}`);
  const data = await res.json() as Record<string, TickerEntry>;
  await setCache(TICKERS_CACHE_KEY, data, TICKERS_TTL);
  return data;
}

export async function fetchEDGARSubmissions(cik: string): Promise<EDGARSubmissions | null> {
  const paddedCik = cik.padStart(10, '0');
  const url = `${SUBMISSIONS_BASE}/CIK${paddedCik}.json`;
  const res = await fetch(url, { headers: edgarHeaders() });
  if (!res.ok) return null;
  return res.json() as Promise<EDGARSubmissions>;
}

export async function resolveEDGAREntity(entityName: string): Promise<EntityLookupOutputType | null> {
  const tickers = await loadTickerMap();
  const normQuery = entityName.toLowerCase().trim();

  // Pass 1: exact title match
  let match: TickerEntry | null = null;
  for (const entry of Object.values(tickers)) {
    if (entry.title.toLowerCase() === normQuery) {
      match = entry;
      break;
    }
  }

  // Pass 2: starts-with match
  if (!match) {
    for (const entry of Object.values(tickers)) {
      if (entry.title.toLowerCase().startsWith(normQuery)) {
        match = entry;
        break;
      }
    }
  }

  // Pass 3: contains match
  if (!match) {
    for (const entry of Object.values(tickers)) {
      if (entry.title.toLowerCase().includes(normQuery) || normQuery.includes(entry.title.toLowerCase())) {
        match = entry;
        break;
      }
    }
  }

  if (!match) return null;

  const cik = String(match.cik_str);
  const profile = await fetchEDGARSubmissions(cik);
  if (!profile) return null;

  const dates = profile.filings.recent.filingDate.filter(Boolean);
  // Earliest filing date is the best available incorporation approximation
  const earliestDate = dates.length > 0 ? dates[dates.length - 1]! : null;
  // Most recent filing date — used to infer active/dormant status
  const latestDate = dates.length > 0 ? dates[0]! : null;

  const jurisdiction = profile.stateOfIncorporation
    ? `US-${profile.stateOfIncorporation}`
    : 'US';

  // EDGAR only indexes SEC registrants, but revoked/deregistered filers remain
  // in the database. A company with no filing in the last 3 years is likely
  // deregistered or dormant; we mark it 'unknown' rather than claiming 'active'.
  let status: 'active' | 'unknown' = 'unknown';
  if (latestDate) {
    const daysSinceLastFiling =
      (Date.now() - new Date(latestDate).getTime()) / 86_400_000;
    if (daysSinceLastFiling < 1095) status = 'active'; // < 3 years
  }

  return {
    entity_id: generateEntityId(jurisdiction, profile.name),
    canonical_name: profile.name,
    jurisdiction,
    status,
    incorporated_at: earliestDate,
    registered_agent: null,
    officers: [],
    source: 'edgar',
    source_url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
    freshness_secs: 0,
    confidence: 0.85,
    data_freshness: 'fresh',
  };
}
