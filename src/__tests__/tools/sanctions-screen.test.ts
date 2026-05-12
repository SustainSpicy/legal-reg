import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());
const mockScreenEntity = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
  sanctionsScreenCacheKey: (name: string) => `sanctions:screen:${name.toLowerCase()}`,
}));

vi.mock('../../resolvers/sanctions-matcher.js', () => ({
  screenEntity: mockScreenEntity,
}));

import { registerSanctionsScreen } from '../../tools/sanctions-screen.js';
import type { SanctionsScreenOutputType } from '../../schemas/sanctions.js';

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

const CLEAN_RESULT = { hits: [], fuzzy_candidates: [] };
const HIT_RESULT = {
  hits: [{
    list: 'OFAC_SDN' as const,
    entry_id: 'SDN_001',
    matched_name: 'Bad Actor Corp',
    score: 1.0,
    match_type: 'exact' as const,
    listed_on: '2020-01-01',
    program: 'SDGT',
  }],
  fuzzy_candidates: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
  mockSetCache.mockResolvedValue(undefined);
  mockScreenEntity.mockResolvedValue(CLEAN_RESULT);
});

describe('sanctions_screen — clean entity', () => {
  it('returns clear=true with no hits', async () => {
    const server = makeServer();
    registerSanctionsScreen(server as never);

    const resp = await server.callTool({ entity_name: 'Honest Trading Co' }) as { structuredContent: SanctionsScreenOutputType };
    expect(resp.structuredContent.clear).toBe(true);
    expect(resp.structuredContent.hits).toHaveLength(0);
  });

  it('checks all 6 lists by default', async () => {
    const server = makeServer();
    registerSanctionsScreen(server as never);

    const resp = await server.callTool({ entity_name: 'Honest Trading Co' }) as { structuredContent: SanctionsScreenOutputType };
    expect(resp.structuredContent.lists_checked).toHaveLength(6);
    expect(resp.structuredContent.lists_checked).toContain('OFAC_SDN');
    expect(resp.structuredContent.lists_checked).toContain('HM_TREASURY');
  });

  it('writes the result to cache after screening', async () => {
    const server = makeServer();
    registerSanctionsScreen(server as never);

    await server.callTool({ entity_name: 'Honest Trading Co' });
    expect(mockSetCache).toHaveBeenCalledOnce();
  });
});

describe('sanctions_screen — sanctioned entity', () => {
  it('returns clear=false with hits when a match is found', async () => {
    mockScreenEntity.mockResolvedValue(HIT_RESULT);
    const server = makeServer();
    registerSanctionsScreen(server as never);

    const resp = await server.callTool({ entity_name: 'Bad Actor Corp' }) as { structuredContent: SanctionsScreenOutputType };
    expect(resp.structuredContent.clear).toBe(false);
    expect(resp.structuredContent.hits).toHaveLength(1);
    expect(resp.structuredContent.hits[0]!.list).toBe('OFAC_SDN');
    expect(resp.structuredContent.hits[0]!.match_type).toBe('exact');
  });
});

describe('sanctions_screen — cache hit', () => {
  it('returns cached result without calling screenEntity', async () => {
    const cached: SanctionsScreenOutputType = {
      entity_name: 'Honest Trading Co',
      screened_at: new Date().toISOString(),
      clear: true,
      hits: [],
      fuzzy_candidates: [],
      lists_checked: ['OFAC_SDN', 'OFAC_CONS', 'FinCEN', 'UN_1267', 'EU_CFSP', 'HM_TREASURY'],
      freshness_secs: 0,
      data_freshness: 'fresh',
    };
    mockGetCached.mockResolvedValue(cached);

    const server = makeServer();
    registerSanctionsScreen(server as never);

    const resp = await server.callTool({ entity_name: 'Honest Trading Co' }) as { structuredContent: SanctionsScreenOutputType };
    expect(mockScreenEntity).not.toHaveBeenCalled();
    expect(resp.structuredContent.clear).toBe(true);
  });
});

describe('sanctions_screen — custom lists and threshold', () => {
  it('passes custom lists to screenEntity', async () => {
    const server = makeServer();
    registerSanctionsScreen(server as never);

    await server.callTool({ entity_name: 'Some Corp', lists: ['OFAC_SDN', 'EU_CFSP'] });
    expect(mockScreenEntity).toHaveBeenCalledWith(
      'Some Corp',
      ['OFAC_SDN', 'EU_CFSP'],
      expect.any(Number),
    );
  });

  it('passes custom fuzzy_threshold to screenEntity', async () => {
    const server = makeServer();
    registerSanctionsScreen(server as never);

    await server.callTool({ entity_name: 'Some Corp', fuzzy_threshold: 0.7 });
    expect(mockScreenEntity).toHaveBeenCalledWith(
      'Some Corp',
      expect.any(Array),
      0.7,
    );
  });
});
