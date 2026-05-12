import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub Playwright so the module loads without a browser binary
vi.mock('playwright', () => ({ chromium: { launch: vi.fn() } }));
vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());
const mockGetScraperHealth = vi.hoisted(() => vi.fn());
const mockSetScraperHealth = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
  entityCacheKey: (jur: string, name: string) =>
    `entity:${jur.toLowerCase()}:${name.toLowerCase()}`,
  getScraperHealth: mockGetScraperHealth,
  setScraperHealth: mockSetScraperHealth,
}));

// Scraper configs are used inside scrapeEntityOnDemand
vi.mock('../../ingest/sources/sos-scraper-configs.js', () => ({
  SCRAPER_CONFIGS: [
    {
      jurisdiction: 'US-WV',
      searchUrl: 'https://apps.wv.gov/SOS/BusinessEntitySearch/',
      searchInputSelector: 'input#EntityName',
      searchButtonSelector: 'input#btnSearch',
      resultRowSelector: '#grdResults tr:not(:first-child)',
      fields: { name: 'td:nth-child(1)', status: 'td:nth-child(3)' },
    },
  ],
}));

vi.mock('../../ingest/sources/sos-portals.js', () => ({
  SCRAPE_ONLY_STATES: ['US-WV'],
  mapScrapedRecordToEntity: vi.fn((rec: { entity_name: string; jurisdiction: string }) => ({
    entity_id: `corpsig_${rec.jurisdiction}_${rec.entity_name}`,
    canonical_name: rec.entity_name,
    jurisdiction: rec.jurisdiction,
    status: 'active',
    incorporated_at: null,
    registered_agent: null,
    officers: [],
    source: 'sos_scraper',
    source_url: null,
    freshness_secs: 0,
    confidence: 0.9,
    data_freshness: 'fresh',
  })),
}));

import { scrapeEntityOnDemand } from '../../ingest/sos-scraper.js';
import type { ScraperHealth } from '../../cache/helpers.js';

const CACHED_ENTITY = {
  entity_id: 'corpsig_us_wv_acme',
  canonical_name: 'Acme WV LLC',
  jurisdiction: 'US-WV',
  status: 'active' as const,
  incorporated_at: null,
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
  mockSetCache.mockResolvedValue(undefined);
  mockSetScraperHealth.mockResolvedValue(undefined);
});

describe('scrapeEntityOnDemand — cache hit with healthy scraper', () => {
  it('returns cached entity unchanged when last success is recent', async () => {
    mockGetCached.mockResolvedValue(CACHED_ENTITY);
    const freshHealth: ScraperHealth = {
      lastRunAt: Date.now() - 3_600_000, // 1 hour ago
      lastSuccessAt: Date.now() - 3_600_000,
      lastCount: 50,
      consecutiveFailures: 0,
    };
    mockGetScraperHealth.mockResolvedValue(freshHealth);

    const result = await scrapeEntityOnDemand('Acme WV LLC', 'US-WV');
    expect(result?.confidence).toBe(0.9);
    expect(result?.data_freshness).toBe('fresh');
  });
});

describe('scrapeEntityOnDemand — cache hit with stale scraper', () => {
  it('downgrades confidence when lastSuccessAt is older than 48 hours', async () => {
    mockGetCached.mockResolvedValue(CACHED_ENTITY);
    const staleHealth: ScraperHealth = {
      lastRunAt: Date.now() - 50 * 3_600_000, // 50 hours ago
      lastSuccessAt: Date.now() - 50 * 3_600_000,
      lastCount: 0,
      consecutiveFailures: 3,
    };
    mockGetScraperHealth.mockResolvedValue(staleHealth);

    const result = await scrapeEntityOnDemand('Acme WV LLC', 'US-WV');
    expect(result?.confidence).toBeLessThanOrEqual(0.5);
    expect(result?.data_freshness).toBe('stale');
  });

  it('downgrades confidence when scraper has never succeeded (lastSuccessAt is null)', async () => {
    mockGetCached.mockResolvedValue(CACHED_ENTITY);
    const neverSucceeded: ScraperHealth = {
      lastRunAt: Date.now() - 1_000,
      lastSuccessAt: null,
      lastCount: 0,
      consecutiveFailures: 1,
    };
    mockGetScraperHealth.mockResolvedValue(neverSucceeded);

    const result = await scrapeEntityOnDemand('Acme WV LLC', 'US-WV');
    expect(result?.confidence).toBeLessThanOrEqual(0.5);
    expect(result?.data_freshness).toBe('stale');
  });

  it('does not exceed original confidence cap of 0.5', async () => {
    // Even if original confidence is 0.3, it stays at 0.3 (min, not overridden)
    const lowConfEntity = { ...CACHED_ENTITY, confidence: 0.3 };
    mockGetCached.mockResolvedValue(lowConfEntity);
    const staleHealth: ScraperHealth = {
      lastRunAt: Date.now(),
      lastSuccessAt: null,
      lastCount: 0,
      consecutiveFailures: 5,
    };
    mockGetScraperHealth.mockResolvedValue(staleHealth);

    const result = await scrapeEntityOnDemand('Acme WV LLC', 'US-WV');
    expect(result?.confidence).toBe(0.3); // min(0.3, 0.5) = 0.3
  });
});

describe('scrapeEntityOnDemand — cache miss on unsupported jurisdiction', () => {
  it('returns null for a jurisdiction with no scraper config', async () => {
    mockGetCached.mockResolvedValue(null);
    const result = await scrapeEntityOnDemand('Some Entity', 'US-AL'); // not in mock configs
    expect(result).toBeNull();
  });
});
