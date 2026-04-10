// Companies House Filings API
// Endpoint: GET /company/{company_number}/filing-history
// Free official API — same key as companies-house.ts (COMPANIES_HOUSE_API_KEY)

import type { FilingItemType } from '../../schemas/filings.js';

const CH_BASE = 'https://api.companieshouse.gov.uk';

function authHeader(): Record<string, string> {
  const key = process.env['COMPANIES_HOUSE_API_KEY'] ?? '';
  const encoded = Buffer.from(`${key}:`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

interface CHFilingItem {
  transaction_id: string;
  type: string;
  date: string;
  description?: string;
  links?: { document_metadata?: string };
}

interface CHFilingResponse {
  items?: CHFilingItem[];
  total_count?: number;
}

export async function fetchCHFilings(
  companyNumber: string,
  limit = 10,
  filingTypes?: string[],
): Promise<{ filings: FilingItemType[]; totalAvailable: number }> {
  const params = new URLSearchParams({
    items_per_page: String(Math.min(limit * 2, 40)), // fetch more to allow type filtering
    start_index: '0',
    ...(filingTypes?.length ? { category: filingTypes[0]! } : {}),
  });

  const url = `${CH_BASE}/company/${companyNumber}/filing-history?${params.toString()}`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) throw new Error(`CH filings fetch failed: ${res.status}`);

  const data = await res.json() as CHFilingResponse;
  const items = data.items ?? [];

  const filings: FilingItemType[] = items
    .filter((item) => !filingTypes || filingTypes.includes(item.type))
    .slice(0, limit)
    .map((item) => ({
      filing_id: `CH_${item.transaction_id}`,
      type: item.type,
      date: item.date,
      description: item.description ?? null,
      url: item.links?.document_metadata
        ? `https://document-api.company-information.service.gov.uk/document/${item.links.document_metadata.split('/').pop()}`
        : null,
      source: 'COMPANIES_HOUSE' as const,
    }));

  return { filings, totalAvailable: data.total_count ?? filings.length };
}

// Resolve company number from entity name via Companies House search
export async function resolveCompanyNumber(entityName: string): Promise<string | null> {
  const url = `${CH_BASE}/search/companies?q=${encodeURIComponent(entityName)}&items_per_page=1`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) return null;

  const data = await res.json() as { items?: Array<{ company_number: string }> };
  return data.items?.[0]?.company_number ?? null;
}
