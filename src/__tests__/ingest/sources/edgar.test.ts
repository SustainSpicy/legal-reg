import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());

vi.mock('../../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
}));

vi.mock('../../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_test_${name.toLowerCase().replace(/\s+/g, '_')}`,
}));

import { resolveEDGAREntity, fetchEDGARSubmissions } from '../../../ingest/sources/edgar.js';

function jsonResponse(data: unknown, ok = true): Response {
  return { ok, json: async () => data, status: ok ? 200 : 404 } as unknown as Response;
}

const TICKER_MAP = {
  '0': { cik_str: 320193, title: 'Apple Inc', ticker: 'AAPL' },
  '1': { cik_str: 789019, title: 'Microsoft Corporation', ticker: 'MSFT' },
  '2': { cik_str: 1018724, title: 'Washington Software Corp', ticker: 'WSSW' },
};

function makeSubmissions(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cik: '320193',
    name: 'Apple Inc',
    stateOfIncorporation: 'DE',
    filings: {
      recent: {
        form: ['10-K', '10-Q'],
        filingDate: ['2025-01-15', '2024-07-10', '2015-03-01'],
        accessionNumber: ['001', '002', '003'],
      },
    },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
  mockSetCache.mockResolvedValue(undefined);
});

afterEach(() => vi.unstubAllGlobals());

// ---- loadTickerMap (internal — tested via resolveEDGAREntity) ----------------

describe('loadTickerMap — cache behaviour', () => {
  it('uses cached ticker map when available (no fetch)', async () => {
    mockGetCached.mockResolvedValueOnce(TICKER_MAP);
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(makeSubmissions()));
    vi.stubGlobal('fetch', mockFetch);

    await resolveEDGAREntity('Apple Inc');

    // Only the submissions fetch should happen — not the ticker map fetch
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0]![0]).toContain('CIK');
  });

  it('fetches and caches ticker map on a miss, then re-uses for submissions', async () => {
    mockGetCached.mockResolvedValue(null);
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse(TICKER_MAP))   // ticker map
      .mockResolvedValueOnce(jsonResponse(makeSubmissions())), // submissions
    );

    await resolveEDGAREntity('Apple Inc');

    expect(mockSetCache).toHaveBeenCalledWith('edgar:company_tickers', TICKER_MAP, 86400);
  });
});

// ---- resolveEDGAREntity — 3-pass matching ------------------------------------

describe('resolveEDGAREntity — matching passes', () => {
  beforeEach(() => {
    mockGetCached.mockResolvedValue(TICKER_MAP);
  });

  it('resolves via exact title match (pass 1)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(makeSubmissions())));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result).not.toBeNull();
    expect(result!.canonical_name).toBe('Apple Inc');
  });

  it('resolves via starts-with match (pass 2) when no exact match', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(makeSubmissions({ cik: '789019', name: 'Microsoft Corporation' })),
    ));

    const result = await resolveEDGAREntity('Microsoft');
    expect(result!.canonical_name).toBe('Microsoft Corporation');
  });

  it('resolves via contains match (pass 3) when no exact or starts-with match', async () => {
    // 'Software' doesn't start-match 'Washington Software Corp' (Pass 2 fails),
    // but normaliseName('Washington Software Corp') = 'washington software' which
    // includes normaliseName('Software') = 'software' — Pass 3 succeeds.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(makeSubmissions({ cik: '1018724', name: 'Washington Software Corp' })),
    ));

    const result = await resolveEDGAREntity('Software');
    expect(result!.canonical_name).toBe('Washington Software Corp');
  });

  it('returns null when no match is found in any pass', async () => {
    mockGetCached.mockResolvedValue(TICKER_MAP);
    vi.stubGlobal('fetch', vi.fn());

    const result = await resolveEDGAREntity('Completely Unknown Corp XYZ');
    expect(result).toBeNull();
  });
});

// ---- resolveEDGAREntity — entity fields -------------------------------------

describe('resolveEDGAREntity — entity fields', () => {
  beforeEach(() => {
    mockGetCached.mockResolvedValue(TICKER_MAP);
  });

  it('builds jurisdiction from stateOfIncorporation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(makeSubmissions())));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result!.jurisdiction).toBe('US-DE');
  });

  it('uses "US" as jurisdiction when stateOfIncorporation is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(makeSubmissions({ stateOfIncorporation: undefined })),
    ));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result!.jurisdiction).toBe('US');
  });

  it('sets status to "active" when most recent filing is within 3 years', async () => {
    const recentDate = new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(makeSubmissions({ filings: { recent: { form: ['10-K'], filingDate: [recentDate], accessionNumber: ['001'] } } })),
    ));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result!.status).toBe('active');
  });

  it('sets status to "unknown" when most recent filing is older than 3 years', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(makeSubmissions({ filings: { recent: { form: ['10-K'], filingDate: ['2010-01-01'], accessionNumber: ['001'] } } })),
    ));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result!.status).toBe('unknown');
  });

  it('sets status to "unknown" when there are no filing dates', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse(makeSubmissions({ filings: { recent: { form: [], filingDate: [], accessionNumber: [] } } })),
    ));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result!.status).toBe('unknown');
  });

  it('sets source to "edgar" and includes CIK in source_url', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(makeSubmissions())));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result!.source).toBe('edgar');
    expect(result!.source_url).toContain('320193');
  });

  it('returns null when submissions fetch returns non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const result = await resolveEDGAREntity('Apple Inc');
    expect(result).toBeNull();
  });
});

// ---- fetchEDGARSubmissions ---------------------------------------------------

describe('fetchEDGARSubmissions', () => {
  it('pads CIK to 10 digits in the URL', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(makeSubmissions()));
    vi.stubGlobal('fetch', mockFetch);

    await fetchEDGARSubmissions('12345');
    expect(mockFetch.mock.calls[0]![0]).toContain('CIK0000012345');
  });

  it('returns null on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const result = await fetchEDGARSubmissions('999');
    expect(result).toBeNull();
  });
});
