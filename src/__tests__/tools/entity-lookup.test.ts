import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockResolveFromCache = vi.hoisted(() => vi.fn());
const mockResolveUpstream = vi.hoisted(() => vi.fn());
const mockRefreshEntityCache = vi.hoisted(() => vi.fn());

vi.mock('../../resolvers/entity-resolver.js', () => ({
  resolveEntityFromCache: mockResolveFromCache,
  resolveEntityUpstream: mockResolveUpstream,
  SUPPORTED_JURISDICTIONS: {
    'US-DE': 'delaware_sos',
    'US-CA': 'california_sos',
    'GB': 'companies_house',
  },
  generateEntityId: (jur: string, name: string) =>
    `corpsig_${jur.toLowerCase().replace(/-/g, '_')}_${name.toLowerCase()}`,
  MIN_ENTITY_CONFIDENCE: 0.7,
}));

vi.mock('../../ingest/sos-portals.js', () => ({
  refreshEntityCache: mockRefreshEntityCache,
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

import { registerEntityLookup } from '../../tools/entity-lookup.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

// Minimal McpServer stub that captures the registered handler
function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  return {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => {
      handler = fn;
    }),
    callTool: async (args: Record<string, unknown>) => {
      if (!handler) throw new Error('tool not registered');
      return handler(args);
    },
  };
}

const ACTIVE_ENTITY: EntityLookupOutputType = {
  entity_id: 'corpsig_us_de_apple',
  canonical_name: 'Apple Inc.',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: '1977-01-03',
  registered_agent: { name: 'CT Corp', address: '1209 Orange St, Wilmington, DE' },
  officers: [],
  source: 'delaware_sos',
  source_url: 'https://icis.corp.delaware.gov',
  freshness_secs: 300,
  confidence: 0.99,
  data_freshness: 'fresh',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRefreshEntityCache.mockResolvedValue(null);
});

describe('entity_lookup — cache hit', () => {
  it('returns the cached entity directly without calling upstream', async () => {
    mockResolveFromCache.mockResolvedValue(ACTIVE_ENTITY);
    const server = makeServer();
    registerEntityLookup(server as never);

    const response = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' });
    expect(mockResolveUpstream).not.toHaveBeenCalled();
    expect(response).toMatchObject({ structuredContent: ACTIVE_ENTITY });
  });
});

describe('entity_lookup — cache miss, upstream found', () => {
  it('calls upstream and returns the result', async () => {
    mockResolveFromCache.mockResolvedValue(null);
    mockResolveUpstream.mockResolvedValue(ACTIVE_ENTITY);

    const server = makeServer();
    registerEntityLookup(server as never);

    const response = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: EntityLookupOutputType };
    expect(mockResolveUpstream).toHaveBeenCalledWith('Apple Inc', 'US-DE');
    expect(response.structuredContent.status).toBe('active');
  });

  it('triggers an async background cache refresh', async () => {
    mockResolveFromCache.mockResolvedValue(null);
    mockResolveUpstream.mockResolvedValue(ACTIVE_ENTITY);

    const server = makeServer();
    registerEntityLookup(server as never);
    await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' });

    // Allow the void-fired promise to settle
    await vi.waitFor(() => expect(mockRefreshEntityCache).toHaveBeenCalledWith('Apple Inc', 'US-DE'));
  });
});

describe('entity_lookup — entity not found', () => {
  it('returns a structured ENTITY_NOT_FOUND error for unknown + confidence 0 stubs', async () => {
    const stub: EntityLookupOutputType = {
      ...ACTIVE_ENTITY,
      status: 'unknown',
      confidence: 0,
      data_freshness: 'stale',
    };
    mockResolveFromCache.mockResolvedValue(null);
    mockResolveUpstream.mockResolvedValue(stub);

    const server = makeServer();
    registerEntityLookup(server as never);

    const response = await server.callTool({ entity_name: 'Ghost Corp', jurisdiction: 'US-DE' }) as { isError?: boolean };
    expect(response.isError).toBe(true);
  });
});

describe('entity_lookup — unsupported jurisdiction', () => {
  it('returns a JURISDICTION_UNSUPPORTED error immediately', async () => {
    const server = makeServer();
    registerEntityLookup(server as never);

    const response = await server.callTool({ entity_name: 'Some Corp', jurisdiction: 'US-XX' }) as { isError?: boolean };
    expect(response.isError).toBe(true);
    expect(mockResolveFromCache).not.toHaveBeenCalled();
    expect(mockResolveUpstream).not.toHaveBeenCalled();
  });
});

describe('entity_lookup — default jurisdiction', () => {
  it('defaults to US-DE when jurisdiction is omitted', async () => {
    mockResolveFromCache.mockResolvedValue(null);
    mockResolveUpstream.mockResolvedValue(ACTIVE_ENTITY);

    const server = makeServer();
    registerEntityLookup(server as never);
    await server.callTool({ entity_name: 'Apple Inc' });

    expect(mockResolveUpstream).toHaveBeenCalledWith('Apple Inc', 'US-DE');
  });
});
