import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());
const mockAddToEntityWatchlist = vi.hoisted(() => vi.fn());
const mockEntityCacheKey = vi.hoisted(() => vi.fn(
  (jur: string, name: string) => `entity:${jur.toLowerCase()}:${name.toLowerCase()}`,
));

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
  entityCacheKey: mockEntityCacheKey,
  addToEntityWatchlist: mockAddToEntityWatchlist,
}));

const mockLookupSOSEntity = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/sos-portals.js', () => ({
  lookupSOSEntity: mockLookupSOSEntity,
  SCRAPE_ONLY_STATES: ['US-AL', 'US-AK', 'US-AR', 'US-HI', 'US-MS', 'US-MT', 'US-ND', 'US-WV'],
}));

const mockResolveUKEntity = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/companies-house.js', () => ({
  resolveUKEntity: mockResolveUKEntity,
}));

const mockResolveEDGAREntity = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/edgar.js', () => ({
  resolveEDGAREntity: mockResolveEDGAREntity,
}));

const mockScrapeEntityOnDemand = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sos-scraper.js', () => ({
  scrapeEntityOnDemand: mockScrapeEntityOnDemand,
}));

const mockResolveCanadianEntity = vi.hoisted(() => vi.fn());
vi.mock('../../ingest/sources/canada.js', () => ({
  resolveCanadianEntity: mockResolveCanadianEntity,
}));

import { resolveEntityFromCache, resolveEntityUpstream } from '../../resolvers/entity-resolver.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

function makeEntity(overrides: Partial<EntityLookupOutputType> = {}): EntityLookupOutputType {
  return {
    entity_id: 'corpsig_us_de_acme',
    canonical_name: 'Acme Corp',
    jurisdiction: 'US-DE',
    status: 'active',
    incorporated_at: null,
    registered_agent: null,
    officers: [],
    source: 'delaware_sos',
    source_url: null,
    freshness_secs: 0,
    confidence: 0.95,
    data_freshness: 'fresh',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetCache.mockResolvedValue(undefined);
  mockAddToEntityWatchlist.mockResolvedValue(undefined);
  mockGetCached.mockResolvedValue(null);
  mockLookupSOSEntity.mockResolvedValue(null);
  mockResolveUKEntity.mockResolvedValue(null);
  mockResolveEDGAREntity.mockResolvedValue(null);
  mockScrapeEntityOnDemand.mockResolvedValue(null);
  mockResolveCanadianEntity.mockResolvedValue(null);
});

// ---- resolveEntityFromCache -------------------------------------------------

describe('resolveEntityFromCache', () => {
  it('returns entity on an exact cache-key hit', async () => {
    const entity = makeEntity();
    mockGetCached.mockResolvedValueOnce(entity);

    const result = await resolveEntityFromCache('Acme Corp', 'US-DE');
    expect(result).toBe(entity);
    expect(mockGetCached).toHaveBeenCalledTimes(1);
  });

  it('falls through to canonical-id lookup on an exact-key miss', async () => {
    const entity = makeEntity();
    mockGetCached
      .mockResolvedValueOnce(null)    // exact key miss
      .mockResolvedValueOnce(entity); // id key hit

    const result = await resolveEntityFromCache('Acme Corp', 'US-DE');
    expect(result).toBe(entity);
    expect(mockGetCached).toHaveBeenCalledTimes(2);
    expect(mockGetCached.mock.calls[1]![0]).toMatch(/entity:id:/);
  });

  it('returns null on double cache miss', async () => {
    mockGetCached.mockResolvedValue(null);

    const result = await resolveEntityFromCache('Ghost Corp', 'US-DE');
    expect(result).toBeNull();
  });
});

// ---- resolveEntityUpstream — source routing ---------------------------------

describe('resolveEntityUpstream — UK (GB)', () => {
  it('routes to resolveUKEntity and returns the result', async () => {
    const entity = makeEntity({ jurisdiction: 'GB', source: 'companies_house' });
    mockResolveUKEntity.mockResolvedValue(entity);

    const result = await resolveEntityUpstream('Test Corp Ltd', 'GB');
    expect(mockResolveUKEntity).toHaveBeenCalledWith('Test Corp Ltd');
    expect(result.status).toBe('active');
    expect(result.confidence).toBeGreaterThan(0);
  });

  it('does not call SOS or EDGAR for GB jurisdiction', async () => {
    mockResolveUKEntity.mockResolvedValue(makeEntity({ jurisdiction: 'GB' }));

    await resolveEntityUpstream('Test Corp Ltd', 'GB');
    expect(mockLookupSOSEntity).not.toHaveBeenCalled();
    expect(mockResolveEDGAREntity).not.toHaveBeenCalled();
  });
});

describe('resolveEntityUpstream — Canada (CA)', () => {
  it('routes to resolveCanadianEntity with jurisdiction', async () => {
    const entity = makeEntity({ jurisdiction: 'CA-BC' });
    mockResolveCanadianEntity.mockResolvedValue(entity);

    await resolveEntityUpstream('BC Holdings Corp', 'CA-BC');
    expect(mockResolveCanadianEntity).toHaveBeenCalledWith('BC Holdings Corp', 'CA-BC');
    expect(mockLookupSOSEntity).not.toHaveBeenCalled();
  });
});

describe('resolveEntityUpstream — US API states', () => {
  it('returns SOS result and does NOT call EDGAR when SOS succeeds', async () => {
    const entity = makeEntity();
    mockLookupSOSEntity.mockResolvedValue(entity);

    await resolveEntityUpstream('Acme Corp', 'US-DE');
    expect(mockLookupSOSEntity).toHaveBeenCalledWith('Acme Corp', 'US-DE');
    expect(mockResolveEDGAREntity).not.toHaveBeenCalled();
  });

  it('falls back to EDGAR when SOS returns null (pending states only)', async () => {
    // US-DE is in SOS_PORTAL_LIVE — EDGAR is blocked there. Use US-NV (pending, no portal).
    const edgarEntity = makeEntity({ jurisdiction: 'US-NV', source: 'edgar' });
    mockLookupSOSEntity.mockResolvedValue(null);
    mockResolveEDGAREntity.mockResolvedValue(edgarEntity);

    const result = await resolveEntityUpstream('Acme Corp', 'US-NV');
    expect(mockResolveEDGAREntity).toHaveBeenCalledWith('Acme Corp');
    expect(result.source).toBe('edgar');
  });

  it('returns a stub when both SOS and EDGAR return null', async () => {
    const result = await resolveEntityUpstream('Ghost Corp', 'US-DE');
    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe(0);
    expect(result.data_freshness).toBe('stale');
  });
});

describe('resolveEntityUpstream — US scrape-only states', () => {
  it('routes to scrapeEntityOnDemand for scrape-only jurisdictions', async () => {
    const entity = makeEntity({ jurisdiction: 'US-WV' });
    mockScrapeEntityOnDemand.mockResolvedValue(entity);

    await resolveEntityUpstream('Mountain Corp', 'US-WV');
    expect(mockScrapeEntityOnDemand).toHaveBeenCalledWith('Mountain Corp', 'US-WV');
    expect(mockLookupSOSEntity).not.toHaveBeenCalled();
  });

  it('returns a stub when scraper returns null', async () => {
    mockScrapeEntityOnDemand.mockResolvedValue(null);

    const result = await resolveEntityUpstream('Unknown WV Corp', 'US-WV');
    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe(0);
  });
});

// ---- resolveEntityUpstream — write-through behaviour -----------------------

describe('resolveEntityUpstream — cache write-through', () => {
  it('caches a live result with 4-hour TTL', async () => {
    mockLookupSOSEntity.mockResolvedValue(makeEntity());

    await resolveEntityUpstream('Acme Corp', 'US-DE');

    // Two writes: name key + entity:id reverse-index key, both at 4-hour TTL
    expect(mockSetCache).toHaveBeenCalledTimes(2);
    for (const call of mockSetCache.mock.calls) {
      const [, , ttl] = call as [string, unknown, number];
      expect(ttl).toBe(14400);
    }
  });

  it('adds entity to watchlist on a successful live resolution', async () => {
    mockLookupSOSEntity.mockResolvedValue(makeEntity());

    await resolveEntityUpstream('Acme Corp', 'US-DE');
    expect(mockAddToEntityWatchlist).toHaveBeenCalledWith('Acme Corp', 'US-DE');
  });

  it('does NOT add to watchlist when returning a stub', async () => {
    await resolveEntityUpstream('Ghost Corp', 'US-DE');
    expect(mockAddToEntityWatchlist).not.toHaveBeenCalled();
  });

  it('caches a stub with short 5-minute TTL so the next request retries upstream', async () => {
    await resolveEntityUpstream('Ghost Corp', 'US-DE');

    const [, , ttl] = mockSetCache.mock.calls[0]! as [string, unknown, number];
    expect(ttl).toBe(300);
  });
});

// ---- resolveEntityUpstream — error resilience -------------------------------

describe('resolveEntityUpstream — error resilience', () => {
  it('catches upstream exceptions and returns a stub instead of propagating', async () => {
    mockLookupSOSEntity.mockRejectedValue(new Error('SOS API is down'));

    const result = await resolveEntityUpstream('Acme Corp', 'US-DE');
    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe(0);
  });

  it('still writes the stub to cache even after an upstream error', async () => {
    mockLookupSOSEntity.mockRejectedValue(new Error('timeout'));

    await resolveEntityUpstream('Acme Corp', 'US-DE');
    // Two writes: name key + entity:id reverse-index key
    expect(mockSetCache).toHaveBeenCalledTimes(2);
  });
});
