import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

// Playwright is dynamically imported inside getPlaywright() — mock it at the module level
vi.mock('playwright', () => ({
  chromium: {
    launch: vi.fn(),
  },
}));

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());
const mockEntityCacheKey = vi.hoisted(() => vi.fn((jur: string, name: string) => `entity:${jur}:${name}`));
const mockSetScraperHealth = vi.hoisted(() => vi.fn());
const mockGetScraperHealth = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
  entityCacheKey: mockEntityCacheKey,
  setScraperHealth: mockSetScraperHealth,
  getScraperHealth: mockGetScraperHealth,
}));

vi.mock('../../ingest/sources/sos-portals.js', () => ({
  SCRAPE_ONLY_STATES: ['US-AL', 'US-AK', 'US-AR', 'US-HI', 'US-MS', 'US-MT', 'US-ND', 'US-WV'],
  mapScrapedRecordToEntity: vi.fn((record: { entity_name: string; jurisdiction: string; status: string }) => ({
    entity_id: `corpsig_test_${record.entity_name.toLowerCase().replace(/\s+/g, '_')}`,
    canonical_name: record.entity_name,
    jurisdiction: record.jurisdiction,
    status: record.status === 'Active' ? 'active' : 'unknown',
    incorporated_at: null,
    registered_agent: null,
    officers: [],
    source: `sos_scraper_${record.jurisdiction.toLowerCase().replace('-', '_')}`,
    source_url: null,
    freshness_secs: 0,
    confidence: 0.9,
    data_freshness: 'fresh',
  })),
}));

import { scrapeEntityOnDemand, startSOSScraperCron, SCRAPE_TTL_SECS } from '../../ingest/sos-scraper.js';
import cron from 'node-cron';

const CACHED_ENTITY = {
  entity_id: 'corpsig_test_mountain_corp',
  canonical_name: 'Mountain Corp',
  jurisdiction: 'US-WV',
  status: 'active' as const,
  incorporated_at: '2005-01-01',
  registered_agent: null,
  officers: [],
  source: 'sos_scraper_us_wv',
  source_url: null,
  freshness_secs: 0,
  confidence: 0.9,
  data_freshness: 'fresh' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null);
  mockSetCache.mockResolvedValue(undefined);
  mockSetScraperHealth.mockResolvedValue(undefined);
  mockGetScraperHealth.mockResolvedValue(null);
});

// ---- SCRAPE_TTL_SECS --------------------------------------------------------

describe('SCRAPE_TTL_SECS', () => {
  it('is 24 hours (86400 seconds)', () => {
    expect(SCRAPE_TTL_SECS).toBe(86400);
  });
});

// ---- scrapeEntityOnDemand — cache paths (no Playwright needed) --------------

describe('scrapeEntityOnDemand — cache hit (healthy scraper)', () => {
  it('returns cached entity without launching a browser', async () => {
    mockGetCached.mockResolvedValueOnce(CACHED_ENTITY);
    mockGetScraperHealth.mockResolvedValueOnce({ lastSuccessAt: Date.now() - 1000, failureCount: 0 });

    const result = await scrapeEntityOnDemand('Mountain Corp', 'US-WV');
    expect(result).not.toBeNull();
    expect(result!.canonical_name).toBe('Mountain Corp');
    expect(result!.confidence).toBe(0.9);
    expect(result!.data_freshness).toBe('fresh');
  });

  it('does not call setScraperHealth on a cache hit', async () => {
    mockGetCached.mockResolvedValueOnce(CACHED_ENTITY);
    mockGetScraperHealth.mockResolvedValueOnce({ lastSuccessAt: Date.now(), failureCount: 0 });

    await scrapeEntityOnDemand('Mountain Corp', 'US-WV');
    expect(mockSetScraperHealth).not.toHaveBeenCalled();
  });
});

describe('scrapeEntityOnDemand — cache hit with stale scraper', () => {
  it('downgrades confidence when scraper health shows lastSuccessAt > 48h ago', async () => {
    const staleTime = Date.now() - (49 * 60 * 60 * 1000); // 49 hours ago
    mockGetCached.mockResolvedValueOnce(CACHED_ENTITY);
    mockGetScraperHealth.mockResolvedValueOnce({ lastSuccessAt: staleTime, failureCount: 3 });

    const result = await scrapeEntityOnDemand('Mountain Corp', 'US-WV');
    expect(result!.confidence).toBeLessThanOrEqual(0.5);
    expect(result!.data_freshness).toBe('stale');
  });

  it('downgrades confidence when scraper has never succeeded (lastSuccessAt is null)', async () => {
    mockGetCached.mockResolvedValueOnce(CACHED_ENTITY);
    mockGetScraperHealth.mockResolvedValueOnce({ lastSuccessAt: null, failureCount: 5 });

    const result = await scrapeEntityOnDemand('Mountain Corp', 'US-WV');
    expect(result!.confidence).toBeLessThanOrEqual(0.5);
    expect(result!.data_freshness).toBe('stale');
  });

  it('preserves data when scraper health is null (unknown state)', async () => {
    // health === null means jurisdiction is not tracked — do NOT downgrade
    mockGetCached.mockResolvedValueOnce(CACHED_ENTITY);
    mockGetScraperHealth.mockResolvedValueOnce(null);

    const result = await scrapeEntityOnDemand('Mountain Corp', 'US-WV');
    expect(result!.confidence).toBe(0.9);
    expect(result!.data_freshness).toBe('fresh');
  });
});

describe('scrapeEntityOnDemand — no config for jurisdiction', () => {
  it('returns null immediately for a jurisdiction with no scraper config', async () => {
    // US-TX is not in SCRAPER_CONFIGS (it has a real API) — returns null without touching cache
    const result = await scrapeEntityOnDemand('Any Corp', 'US-TX');
    expect(result).toBeNull();
    expect(mockGetCached).not.toHaveBeenCalled();
  });
});

// ---- startSOSScraperCron ----------------------------------------------------

describe('startSOSScraperCron', () => {
  it('schedules a cron job at 2am UTC daily', () => {
    startSOSScraperCron();

    expect(cron.schedule).toHaveBeenCalledWith('0 2 * * *', expect.any(Function));
  });
});

// ---- SCRAPER_CONFIGS completeness -------------------------------------------

describe('SCRAPER_CONFIGS structure', () => {
  it('has a config for every scrape-only state', async () => {
    const { SCRAPER_CONFIGS } = await import('../../ingest/sources/sos-scraper-configs.js');
    const { SCRAPE_ONLY_STATES: states } = await import('../../ingest/sources/sos-portals.js');

    const configuredJurisdictions = SCRAPER_CONFIGS.map((c) => c.jurisdiction);
    for (const state of states) {
      expect(configuredJurisdictions).toContain(state);
    }
  });

  it('every config has the required selector fields', async () => {
    const { SCRAPER_CONFIGS } = await import('../../ingest/sources/sos-scraper-configs.js');

    for (const config of SCRAPER_CONFIGS) {
      expect(config.searchUrl).toBeTruthy();
      expect(config.searchInputSelector).toBeTruthy();
      expect(config.searchButtonSelector).toBeTruthy();
      expect(config.resultRowSelector).toBeTruthy();
      expect(config.fields.name).toBeTruthy();
    }
  });
});
