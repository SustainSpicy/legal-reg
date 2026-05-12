import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());
const mockResolveEntityFromCache = vi.hoisted(() => vi.fn());
const mockFetchEDGARSubmissions = vi.hoisted(() => vi.fn());
const mockResolveEDGAREntity = vi.hoisted(() => vi.fn());
const mockFetchCHFilings = vi.hoisted(() => vi.fn());
const mockResolveCompanyNumber = vi.hoisted(() => vi.fn());
const mockFetchSEDARFilings = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
  filingsCacheKey: (id: string) => `filings:${id}`,
}));

vi.mock('../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_test_${name.toLowerCase().replace(/\s+/g, '_')}`,
  resolveEntityFromCache: mockResolveEntityFromCache,
}));

vi.mock('../../ingest/sources/edgar.js', () => ({
  fetchEDGARSubmissions: mockFetchEDGARSubmissions,
  resolveEDGAREntity: mockResolveEDGAREntity,
}));

vi.mock('../../ingest/sources/companies-house-filings.js', () => ({
  fetchCHFilings: mockFetchCHFilings,
  resolveCompanyNumber: mockResolveCompanyNumber,
}));

vi.mock('../../ingest/sources/canada.js', () => ({
  fetchSEDARFilings: mockFetchSEDARFilings,
}));

vi.mock('../../errors/codes.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../errors/codes.js')>();
  return {
    ...actual,
    structuredError: (code: string, msg: string) => ({
      content: [{ type: 'text', text: JSON.stringify({ error: { code, message: msg } }) }],
      isError: true,
    }),
  };
});

import { registerFilingsFetch } from '../../tools/filings-fetch.js';
import type { FilingsFetchOutputType } from '../../schemas/filings.js';

function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  return {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => { handler = fn; }),
    callTool: (args: Record<string, unknown>) => {
      if (!handler) throw new Error('not registered');
      return handler(args);
    },
  };
}

const EDGAR_ENTITY = {
  entity_id: 'corpsig_us_de_apple',
  canonical_name: 'Apple Inc.',
  jurisdiction: 'US-DE',
  status: 'active' as const,
  incorporated_at: null,
  registered_agent: null,
  officers: [],
  source: 'edgar',
  source_url: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193',
  freshness_secs: 0,
  confidence: 0.99,
  data_freshness: 'fresh' as const,
};

const EDGAR_SUBMISSIONS = {
  filings: {
    recent: {
      form: ['10-K', '8-K', '10-Q'],
      filingDate: ['2024-11-01', '2024-10-31', '2024-08-02'],
      accessionNumber: ['0000320193-24-000123', '0000320193-24-000122', '0000320193-24-000121'],
    },
  },
};

const CH_FILINGS = [{
  filing_id: 'CH_001',
  type: 'confirmation-statement',
  date: '2024-06-01',
  description: 'Confirmation statement',
  url: 'https://api.companieshouse.gov.uk/document/abc',
  source: 'COMPANIES_HOUSE' as const,
}];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
  mockSetCache.mockResolvedValue(undefined);
  mockResolveEntityFromCache.mockResolvedValue(null);
  mockResolveEDGAREntity.mockResolvedValue(null);
  mockFetchEDGARSubmissions.mockResolvedValue(null);
  mockFetchCHFilings.mockResolvedValue({ filings: [], totalAvailable: 0 });
  mockResolveCompanyNumber.mockResolvedValue(null);
  mockFetchSEDARFilings.mockResolvedValue({ filings: [], totalAvailable: 0 });
});

describe('filings_fetch — EDGAR path (US)', () => {
  it('returns filings from EDGAR for a US public company', async () => {
    mockResolveEDGAREntity.mockResolvedValue(EDGAR_ENTITY);
    mockFetchEDGARSubmissions.mockResolvedValue(EDGAR_SUBMISSIONS);
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: FilingsFetchOutputType };
    expect(resp.structuredContent.source).toBe('edgar');
    expect(resp.structuredContent.filings.length).toBeGreaterThan(0);
    expect(resp.structuredContent.filings[0]!.source).toBe('EDGAR');
  });

  it('filters filings by filing_types when specified', async () => {
    mockResolveEDGAREntity.mockResolvedValue(EDGAR_ENTITY);
    mockFetchEDGARSubmissions.mockResolvedValue(EDGAR_SUBMISSIONS);
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({
      entity_name: 'Apple Inc',
      jurisdiction: 'US-DE',
      filing_types: ['10-K'],
    }) as { structuredContent: FilingsFetchOutputType };

    expect(resp.structuredContent.filings.every((f) => f.type === '10-K')).toBe(true);
    expect(resp.structuredContent.filings.length).toBeGreaterThan(0);
  });

  it('returns ENTITY_NOT_FOUND when no EDGAR entity can be resolved', async () => {
    mockResolveEDGAREntity.mockResolvedValue(null);
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({ entity_name: 'Ghost Corp', jurisdiction: 'US-DE' }) as { isError?: boolean };
    expect(resp.isError).toBe(true);
  });

  it('respects the limit parameter', async () => {
    mockResolveEDGAREntity.mockResolvedValue(EDGAR_ENTITY);
    mockFetchEDGARSubmissions.mockResolvedValue(EDGAR_SUBMISSIONS);
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({
      entity_name: 'Apple Inc',
      jurisdiction: 'US-DE',
      limit: 1,
    }) as { structuredContent: FilingsFetchOutputType };
    expect(resp.structuredContent.filings).toHaveLength(1);
  });
});

describe('filings_fetch — Companies House path (GB)', () => {
  it('returns filings from Companies House for a UK entity', async () => {
    mockResolveCompanyNumber.mockResolvedValue('12345678');
    mockFetchCHFilings.mockResolvedValue({ filings: CH_FILINGS, totalAvailable: 1 });
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({ entity_name: 'Barclays Bank PLC', jurisdiction: 'GB' }) as { structuredContent: FilingsFetchOutputType };
    expect(resp.structuredContent.source).toBe('companies_house');
    expect(resp.structuredContent.filings).toHaveLength(1);
    expect(resp.structuredContent.filings[0]!.source).toBe('COMPANIES_HOUSE');
  });

  it('returns ENTITY_NOT_FOUND when the company number cannot be resolved', async () => {
    mockResolveCompanyNumber.mockResolvedValue(null);
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({ entity_name: 'Ghost UK Ltd', jurisdiction: 'GB' }) as { isError?: boolean };
    expect(resp.isError).toBe(true);
  });
});

describe('filings_fetch — SEDAR path (CA)', () => {
  it('returns filings from SEDAR for a Canadian entity', async () => {
    const sedarFilings = [{
      filing_id: 'SEDAR_001',
      type: 'Annual Report',
      date: '2024-03-15',
      description: 'Annual Report',
      url: null,
      source: 'SEDAR' as const,
    }];
    mockFetchSEDARFilings.mockResolvedValue({ filings: sedarFilings, totalAvailable: 1 });
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({ entity_name: 'RBC', jurisdiction: 'CA' }) as { structuredContent: FilingsFetchOutputType };
    expect(resp.structuredContent.source).toBe('sedar');
    expect(resp.structuredContent.filings).toHaveLength(1);
  });

  it('returns ENTITY_NOT_FOUND when SEDAR has no results for a private company', async () => {
    mockFetchSEDARFilings.mockResolvedValue({ filings: [], totalAvailable: 0 });
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({ entity_name: 'Private Co Canada', jurisdiction: 'CA' }) as { isError?: boolean };
    expect(resp.isError).toBe(true);
  });
});

describe('filings_fetch — cache', () => {
  it('returns cached filings without hitting upstream sources', async () => {
    const cached: FilingsFetchOutputType = {
      entity_id: 'corpsig_test_apple_inc',
      canonical_name: 'Apple Inc.',
      jurisdiction: 'US-DE',
      filings: [{ filing_id: 'EDGAR_001', type: '10-K', date: '2024-11-01', description: null, url: null, source: 'EDGAR' }],
      financials: null,
      total_available: 1,
      source: 'edgar',
      freshness_secs: 0,
      data_freshness: 'fresh',
    };
    mockGetCached.mockResolvedValue(cached);
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: FilingsFetchOutputType };
    expect(mockResolveEDGAREntity).not.toHaveBeenCalled();
    expect(resp.structuredContent.filings).toHaveLength(1);
  });

  it('applies filing_types filter to cached results', async () => {
    const cached: FilingsFetchOutputType = {
      entity_id: 'corpsig_test_apple_inc',
      canonical_name: 'Apple Inc.',
      jurisdiction: 'US-DE',
      filings: [
        { filing_id: 'E1', type: '10-K', date: '2024-11-01', description: null, url: null, source: 'EDGAR' },
        { filing_id: 'E2', type: '8-K', date: '2024-10-15', description: null, url: null, source: 'EDGAR' },
      ],
      financials: null,
      total_available: 2,
      source: 'edgar',
      freshness_secs: 0,
      data_freshness: 'fresh',
    };
    mockGetCached.mockResolvedValue(cached);
    const server = makeServer();
    registerFilingsFetch(server as never);

    const resp = await server.callTool({
      entity_name: 'Apple Inc',
      jurisdiction: 'US-DE',
      filing_types: ['10-K'],
    }) as { structuredContent: FilingsFetchOutputType };

    expect(resp.structuredContent.filings).toHaveLength(1);
    expect(resp.structuredContent.filings[0]!.type).toBe('10-K');
  });
});
