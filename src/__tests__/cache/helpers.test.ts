import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures these are initialised before vi.mock factories run
const mockRedis = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  del: vi.fn(),
  zAdd: vi.fn(),
  zRemRangeByRank: vi.fn(),
  zRange: vi.fn(),
}));

vi.mock('../../cache/client.js', () => ({
  redis: mockRedis,
  isRedisConnected: vi.fn().mockReturnValue(true),
}));

import {
  entityCacheKey,
  sanctionsCacheKey,
  sanctionsScreenCacheKey,
  filingsCacheKey,
  complianceCacheKey,
  beneficialOwnersCacheKey,
  getCached,
  setCache,
  deleteCache,
  addToEntityWatchlist,
  getEntityWatchlist,
  addToUKWatchlist,
  getUKWatchlist,
  setScraperHealth,
  getScraperHealth,
} from '../../cache/helpers.js';

beforeEach(() => vi.clearAllMocks());

// ---- Key generators ----------------------------------------------------------

describe('cache key generators', () => {
  it('entityCacheKey lowercases jurisdiction and name', () => {
    expect(entityCacheKey('US-DE', 'Apple Inc')).toBe('entity:us-de:apple inc');
  });

  it('sanctionsCacheKey uses list name verbatim', () => {
    expect(sanctionsCacheKey('OFAC_SDN')).toBe('sanctions:list:OFAC_SDN');
  });

  it('sanctionsScreenCacheKey lowercases the name', () => {
    expect(sanctionsScreenCacheKey('Apple Inc')).toBe('sanctions:screen:apple inc');
  });

  it('filingsCacheKey uses entity id', () => {
    expect(filingsCacheKey('corpsig_us_de_apple')).toBe('filings:corpsig_us_de_apple');
  });

  it('complianceCacheKey uses entity id', () => {
    expect(complianceCacheKey('corpsig_us_de_apple')).toBe('compliance:corpsig_us_de_apple');
  });

  it('beneficialOwnersCacheKey uses entity id', () => {
    expect(beneficialOwnersCacheKey('corpsig_us_de_apple')).toBe('bowners:corpsig_us_de_apple');
  });
});

// ---- getCached / setCache / deleteCache ---------------------------------------

describe('getCached', () => {
  it('returns parsed JSON on a cache hit', async () => {
    mockRedis.get.mockResolvedValue(JSON.stringify({ foo: 'bar' }));
    const result = await getCached<{ foo: string }>('some-key');
    expect(result).toEqual({ foo: 'bar' });
  });

  it('returns null on a cache miss', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await getCached('missing-key');
    expect(result).toBeNull();
  });

  it('returns null if Redis throws', async () => {
    mockRedis.get.mockRejectedValue(new Error('redis down'));
    const result = await getCached('error-key');
    expect(result).toBeNull();
  });
});

describe('setCache', () => {
  it('serialises the value as JSON with EX TTL', async () => {
    await setCache('my-key', { x: 1 }, 3600);
    expect(mockRedis.set).toHaveBeenCalledWith('my-key', JSON.stringify({ x: 1 }), { EX: 3600 });
  });

  it('does not throw if Redis throws', async () => {
    mockRedis.set.mockRejectedValue(new Error('write error'));
    await expect(setCache('k', {}, 60)).resolves.toBeUndefined();
  });
});

describe('deleteCache', () => {
  it('calls redis.del', async () => {
    await deleteCache('to-delete');
    expect(mockRedis.del).toHaveBeenCalledWith('to-delete');
  });
});

// ---- Entity watchlist --------------------------------------------------------

describe('addToEntityWatchlist', () => {
  it('calls zAdd with a timestamp score', async () => {
    const before = Date.now();
    await addToEntityWatchlist('Apple Inc', 'US-DE');
    const after = Date.now();
    expect(mockRedis.zAdd).toHaveBeenCalledOnce();
    const [key, entry] = mockRedis.zAdd.mock.calls[0]! as [string, { score: number; value: string }];
    expect(key).toBe('watchlist:us_de');
    expect(entry.value).toBe('apple inc');
    expect(entry.score).toBeGreaterThanOrEqual(before);
    expect(entry.score).toBeLessThanOrEqual(after);
  });

  it('trims the watchlist after adding', async () => {
    await addToEntityWatchlist('Apple Inc', 'US-DE');
    expect(mockRedis.zRemRangeByRank).toHaveBeenCalledWith('watchlist:us_de', 0, -201);
  });
});

describe('getEntityWatchlist', () => {
  it('returns the list from Redis newest-first', async () => {
    mockRedis.zRange.mockResolvedValue(['apple inc', 'microsoft corporation']);
    const result = await getEntityWatchlist('US-DE');
    expect(result).toEqual(['apple inc', 'microsoft corporation']);
    expect(mockRedis.zRange).toHaveBeenCalledWith('watchlist:us_de', 0, -1, { REV: true });
  });

  it('returns an empty array on Redis error', async () => {
    mockRedis.zRange.mockRejectedValue(new Error('oops'));
    const result = await getEntityWatchlist('US-DE');
    expect(result).toEqual([]);
  });
});

describe('UK watchlist aliases', () => {
  it('addToUKWatchlist writes to the GB watchlist key', async () => {
    await addToUKWatchlist('Barclays Bank PLC');
    expect(mockRedis.zAdd).toHaveBeenCalledWith(
      'watchlist:gb',
      expect.objectContaining({ value: 'barclays bank plc' }),
    );
  });

  it('getUKWatchlist reads from the GB watchlist key', async () => {
    mockRedis.zRange.mockResolvedValue(['barclays bank plc']);
    await getUKWatchlist();
    expect(mockRedis.zRange).toHaveBeenCalledWith('watchlist:gb', 0, -1, { REV: true });
  });
});

// ---- Scraper health ----------------------------------------------------------

describe('setScraperHealth', () => {
  it('writes a health record to Redis', async () => {
    mockRedis.get.mockResolvedValue(null); // no prior health
    await setScraperHealth('US-WV', true, 42);
    expect(mockRedis.set).toHaveBeenCalledOnce();
    const [key, rawValue] = mockRedis.set.mock.calls[0]! as [string, string];
    expect(key).toBe('scraper:health:us_wv');
    const health = JSON.parse(rawValue) as { consecutiveFailures: number; lastCount: number; lastSuccessAt: number | null };
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastCount).toBe(42);
    expect(health.lastSuccessAt).toBeGreaterThan(0);
  });

  it('increments consecutiveFailures on failure', async () => {
    const existingHealth = {
      lastRunAt: Date.now() - 1000,
      lastSuccessAt: Date.now() - 1000,
      lastCount: 10,
      consecutiveFailures: 2,
    };
    mockRedis.get.mockResolvedValue(JSON.stringify(existingHealth));
    await setScraperHealth('US-WV', false, 0);
    const [, rawValue] = mockRedis.set.mock.calls[0]! as [string, string];
    const health = JSON.parse(rawValue) as { consecutiveFailures: number; lastSuccessAt: number | null };
    expect(health.consecutiveFailures).toBe(3);
    // lastSuccessAt preserved from existing
    expect(health.lastSuccessAt).toBe(existingHealth.lastSuccessAt);
  });

  it('resets consecutiveFailures on success', async () => {
    const existingHealth = { lastRunAt: Date.now(), lastSuccessAt: null, lastCount: 0, consecutiveFailures: 5 };
    mockRedis.get.mockResolvedValue(JSON.stringify(existingHealth));
    await setScraperHealth('US-WV', true, 100);
    const [, rawValue] = mockRedis.set.mock.calls[0]! as [string, string];
    const health = JSON.parse(rawValue) as { consecutiveFailures: number };
    expect(health.consecutiveFailures).toBe(0);
  });
});

describe('getScraperHealth', () => {
  it('returns a parsed health record', async () => {
    const stored = { lastRunAt: 1000, lastSuccessAt: 900, lastCount: 5, consecutiveFailures: 1 };
    mockRedis.get.mockResolvedValue(JSON.stringify(stored));
    const result = await getScraperHealth('US-WV');
    expect(result).toEqual(stored);
  });

  it('returns null when no record exists', async () => {
    mockRedis.get.mockResolvedValue(null);
    const result = await getScraperHealth('US-WV');
    expect(result).toBeNull();
  });
});
