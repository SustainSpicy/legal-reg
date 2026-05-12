import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { fetchCHFilings, resolveCompanyNumber } from '../../../ingest/sources/companies-house-filings.js';

function jsonResponse(data: unknown, ok = true): Response {
  return { ok, json: async () => data, status: ok ? 200 : 401 } as unknown as Response;
}

const FILINGS_RESPONSE = {
  items: [
    { transaction_id: 'TX001', type: 'CS01', date: '2024-11-01', description: 'Confirmation statement', links: {} },
    { transaction_id: 'TX002', type: 'AA', date: '2024-07-15', description: 'Annual accounts', links: { document_metadata: '/document/doc123' } },
    { transaction_id: 'TX003', type: 'TM01', date: '2023-12-20', description: 'Termination of director', links: {} },
  ],
  total_count: 3,
};

beforeEach(() => {
  vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'test-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---- fetchCHFilings ---------------------------------------------------------

describe('fetchCHFilings', () => {
  it('returns filings mapped to FilingItemType shape', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(FILINGS_RESPONSE)));

    const { filings, totalAvailable } = await fetchCHFilings('12345678');
    expect(filings).toHaveLength(3);
    expect(filings[0]!.filing_id).toBe('CH_TX001');
    expect(filings[0]!.type).toBe('CS01');
    expect(filings[0]!.source).toBe('COMPANIES_HOUSE');
    expect(totalAvailable).toBe(3);
  });

  it('filters by filing types when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(FILINGS_RESPONSE)));

    const { filings } = await fetchCHFilings('12345678', 10, ['AA']);
    expect(filings.every((f) => f.type === 'AA')).toBe(true);
    expect(filings).toHaveLength(1);
  });

  it('respects the limit parameter', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(FILINGS_RESPONSE)));

    const { filings } = await fetchCHFilings('12345678', 2);
    expect(filings).toHaveLength(2);
  });

  it('builds document URL from links.document_metadata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(FILINGS_RESPONSE)));

    const { filings } = await fetchCHFilings('12345678');
    const withDoc = filings.find((f) => f.filing_id === 'CH_TX002');
    expect(withDoc!.url).toContain('doc123');
  });

  it('sets url to null when links.document_metadata is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(FILINGS_RESPONSE)));

    const { filings } = await fetchCHFilings('12345678');
    const noDoc = filings.find((f) => f.filing_id === 'CH_TX001');
    expect(noDoc!.url).toBeNull();
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    await expect(fetchCHFilings('12345678')).rejects.toThrow('CH filings fetch failed');
  });

  it('returns empty filings when items is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ total_count: 0 })));

    const { filings } = await fetchCHFilings('12345678');
    expect(filings).toHaveLength(0);
  });
});

// ---- resolveCompanyNumber ---------------------------------------------------

describe('resolveCompanyNumber', () => {
  it('returns company number from first search result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      items: [{ company_number: '99887766' }],
    })));

    const num = await resolveCompanyNumber('Test Ltd');
    expect(num).toBe('99887766');
  });

  it('returns null when no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ items: [] })));

    const num = await resolveCompanyNumber('Ghost Corp');
    expect(num).toBeNull();
  });

  it('returns null on HTTP error (does not throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const num = await resolveCompanyNumber('Any Corp');
    expect(num).toBeNull();
  });
});
