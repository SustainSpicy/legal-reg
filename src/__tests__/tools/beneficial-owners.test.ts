import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());
const mockResolveCompanyNumber = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
  beneficialOwnersCacheKey: (id: string) => `bowners:${id}`,
}));

vi.mock('../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_test_${name.toLowerCase().replace(/\s+/g, '_')}`,
}));

vi.mock('../../ingest/sources/companies-house-filings.js', () => ({
  resolveCompanyNumber: mockResolveCompanyNumber,
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

import { registerBeneficialOwners } from '../../tools/beneficial-owners.js';
import type { BeneficialOwnersOutputType } from '../../schemas/beneficial-owners.js';

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

function mockResponse(data: unknown, ok = true): Response {
  return { ok, json: async () => data } as unknown as Response;
}

const GLEIF_SEARCH_MATCH = {
  data: [{
    id: 'LEI_001',
    attributes: {
      entity: { legalName: { name: 'Apple Inc' }, registeredAddress: { country: 'US' } },
      registration: { registrationStatus: 'ISSUED' },
    },
  }],
};

const GLEIF_DIRECT_PARENTS = {
  data: [{
    id: 'LEI_PARENT_001',
    attributes: {
      entity: { legalName: { name: 'Apple Holding Co' }, registeredAddress: { country: 'US' } },
      registration: { registrationStatus: 'ISSUED' },
    },
  }],
};

const PSC_RESPONSE = {
  items: [{
    name: 'Acme Holdings Ltd',
    nationality: 'GB',
    notified_on: '2021-01-15',
    natures_of_control: ['ownership-of-shares-75-to-100-percent'],
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
  mockSetCache.mockResolvedValue(undefined);
  mockResolveCompanyNumber.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('beneficial_owners — cache hit', () => {
  it('returns cached result without making any upstream calls', async () => {
    const cached: BeneficialOwnersOutputType = {
      entity_id: 'corpsig_test_apple_inc',
      canonical_name: 'Apple Inc',
      jurisdiction: 'US-DE',
      owners: [],
      disclosure_status: 'unavailable',
      source: 'none',
      freshness_secs: 0,
      data_freshness: 'fresh',
    };
    mockGetCached.mockResolvedValue(cached);
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const server = makeServer();
    registerBeneficialOwners(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: BeneficialOwnersOutputType };
    expect(mockFetch).not.toHaveBeenCalled();
    expect(resp.structuredContent.disclosure_status).toBe('unavailable');
  });
});

describe('beneficial_owners — UK (GB) PSC path', () => {
  it('returns PSC owners when company number resolves and API key is set', async () => {
    vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'test-key');
    mockResolveCompanyNumber.mockResolvedValue('12345678');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(mockResponse(PSC_RESPONSE)));

    const server = makeServer();
    registerBeneficialOwners(server as never);

    const resp = await server.callTool({ entity_name: 'Test UK Ltd', jurisdiction: 'GB' }) as { structuredContent: BeneficialOwnersOutputType };
    expect(resp.structuredContent.source).toBe('UK_PSC');
    expect(resp.structuredContent.owners).toHaveLength(1);
    expect(resp.structuredContent.owners[0]!.name).toBe('Acme Holdings Ltd');
    expect(resp.structuredContent.disclosure_status).toBe('full');
  });

  it('returns ENTITY_NOT_FOUND when company number cannot be resolved', async () => {
    mockResolveCompanyNumber.mockResolvedValue(null);

    const server = makeServer();
    registerBeneficialOwners(server as never);

    const resp = await server.callTool({ entity_name: 'Ghost UK Ltd', jurisdiction: 'GB' }) as { isError?: boolean };
    expect(resp.isError).toBe(true);
  });
});

describe('beneficial_owners — US GLEIF path', () => {
  it('returns GLEIF owners when LEI registry has data', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockResponse(GLEIF_SEARCH_MATCH))    // GLEIF search
      .mockResolvedValueOnce(mockResponse(GLEIF_DIRECT_PARENTS))  // direct parents (parallel)
      .mockResolvedValueOnce(mockResponse({ data: [] })),         // ultimate parents (parallel)
    );

    const server = makeServer();
    registerBeneficialOwners(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: BeneficialOwnersOutputType };
    expect(resp.structuredContent.source).toBe('GLEIF_LEI');
    expect(resp.structuredContent.owners.length).toBeGreaterThan(0);
    expect(resp.structuredContent.owners[0]!.source).toBe('GLEIF_LEI');
  });
});

describe('beneficial_owners — US EDGAR fallback', () => {
  it('falls back to EDGAR Schedule 13G/D when GLEIF returns no data', async () => {
    const edgarResponse = {
      hits: {
        hits: [{
          _source: { entity_name: 'Berkshire Hathaway Inc', period_of_report: '2024-12-31' },
          _id: 'EDGAR_HIT_001',
        }],
      },
    };
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockResponse({ data: [] }))    // GLEIF search — empty
      .mockResolvedValueOnce(mockResponse(edgarResponse)), // EDGAR SC 13G/D
    );

    const server = makeServer();
    registerBeneficialOwners(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: BeneficialOwnersOutputType };
    expect(resp.structuredContent.source).toBe('EDGAR_PROXY');
    expect(resp.structuredContent.disclosure_status).toBe('partial');
    expect(resp.structuredContent.owners[0]!.name).toBe('Berkshire Hathaway Inc');
  });

  it('reports disclosure_status unavailable when both GLEIF and EDGAR return nothing', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(mockResponse({ data: [] }))                // GLEIF — empty
      .mockResolvedValueOnce(mockResponse({ hits: { hits: [] } })),     // EDGAR — empty
    );

    const server = makeServer();
    registerBeneficialOwners(server as never);

    const resp = await server.callTool({ entity_name: 'Small Private LLC', jurisdiction: 'US-DE' }) as { structuredContent: BeneficialOwnersOutputType };
    expect(resp.structuredContent.disclosure_status).toBe('unavailable');
    expect(resp.structuredContent.source).toBe('none');
    expect(resp.structuredContent.owners).toHaveLength(0);
  });
});

describe('beneficial_owners — unsupported jurisdiction', () => {
  it('returns BENEFICIAL_OWNERSHIP_UNAVAILABLE for jurisdictions outside US/GB/CA', async () => {
    const server = makeServer();
    registerBeneficialOwners(server as never);

    const resp = await server.callTool({ entity_name: 'Firma GmbH', jurisdiction: 'DE' }) as { isError?: boolean };
    expect(resp.isError).toBe(true);
  });
});
