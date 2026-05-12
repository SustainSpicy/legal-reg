import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node-cron', () => ({ default: { schedule: vi.fn() } }));

const mockFetchCompanyProfile = vi.hoisted(() => vi.fn());
const mockFetchCompanyOfficers = vi.hoisted(() => vi.fn());
const mockResolveUKEntity = vi.hoisted(() => vi.fn());

vi.mock('../../ingest/sources/companies-house.js', () => ({
  fetchCompanyProfile: mockFetchCompanyProfile,
  fetchCompanyOfficers: mockFetchCompanyOfficers,
  resolveUKEntity: mockResolveUKEntity,
}));

const mockSetCache = vi.hoisted(() => vi.fn());
const mockEntityCacheKey = vi.hoisted(() => vi.fn((jur: string, name: string) => `entity:${jur.toLowerCase()}:${name.toLowerCase()}`));
const mockAddToUKWatchlist = vi.hoisted(() => vi.fn());
const mockGetUKWatchlist = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  setCache: mockSetCache,
  entityCacheKey: mockEntityCacheKey,
  addToUKWatchlist: mockAddToUKWatchlist,
  getUKWatchlist: mockGetUKWatchlist,
}));

vi.mock('../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_gb_${name.toLowerCase().replace(/\s+/g, '_')}`,
}));

import { handleCompaniesHouseWebhook, cacheUKEntity, startCompaniesHouseCron } from '../../ingest/companies-house.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';
import cron from 'node-cron';

const PROFILE = {
  company_name: 'Test Corp Ltd',
  company_status: 'active',
  date_of_creation: '2010-05-15',
  registered_office_address: {
    address_line_1: '123 High Street',
    locality: 'London',
    postal_code: 'EC1A 1BB',
    country: 'England',
  },
};

const OFFICERS = [
  { name: 'Jane Smith', officer_role: 'director', appointed_on: '2010-05-15' },
];

const UK_ENTITY: EntityLookupOutputType = {
  entity_id: 'corpsig_gb_test_corp',
  canonical_name: 'Test Corp Ltd',
  jurisdiction: 'GB',
  status: 'active',
  incorporated_at: '2010-05-15',
  registered_agent: null,
  officers: [],
  source: 'companies_house',
  source_url: null,
  freshness_secs: 0,
  confidence: 0.95,
  data_freshness: 'fresh',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSetCache.mockResolvedValue(undefined);
  mockAddToUKWatchlist.mockResolvedValue(undefined);
  mockGetUKWatchlist.mockResolvedValue([]);
  mockFetchCompanyProfile.mockResolvedValue(PROFILE);
  mockFetchCompanyOfficers.mockResolvedValue(OFFICERS);
  mockResolveUKEntity.mockResolvedValue(UK_ENTITY);
});

// ---- handleCompaniesHouseWebhook --------------------------------------------

describe('handleCompaniesHouseWebhook — company-profile events', () => {
  it('refreshes cache and adds to watchlist on a valid company-profile event', async () => {
    await handleCompaniesHouseWebhook({
      resource_kind: 'company-profile',
      resource_id: '12345678',
      data: { company_name: 'Test Corp Ltd' },
    });

    expect(mockFetchCompanyProfile).toHaveBeenCalledWith('12345678');
    expect(mockFetchCompanyOfficers).toHaveBeenCalledWith('12345678');
    expect(mockSetCache).toHaveBeenCalledOnce();
    expect(mockAddToUKWatchlist).toHaveBeenCalledWith('Test Corp Ltd');
  });

  it('builds entity with active status when company_status is "active"', async () => {
    await handleCompaniesHouseWebhook({
      resource_kind: 'company-profile',
      resource_id: '12345678',
    });

    const [, cachedEntity] = mockSetCache.mock.calls[0]! as [string, EntityLookupOutputType, number];
    expect(cachedEntity.status).toBe('active');
    expect(cachedEntity.jurisdiction).toBe('GB');
    expect(cachedEntity.officers).toHaveLength(1);
    expect(cachedEntity.officers[0]!.name).toBe('Jane Smith');
  });

  it('builds entity with dissolved status when company_status is not "active"', async () => {
    mockFetchCompanyProfile.mockResolvedValue({ ...PROFILE, company_status: 'dissolved' });

    await handleCompaniesHouseWebhook({
      resource_kind: 'company-profile',
      resource_id: '99999999',
    });

    const [, cachedEntity] = mockSetCache.mock.calls[0]! as [string, EntityLookupOutputType, number];
    expect(cachedEntity.status).toBe('dissolved');
  });

  it('uses 4-hour TTL when writing to cache', async () => {
    await handleCompaniesHouseWebhook({
      resource_kind: 'company-profile',
      resource_id: '12345678',
    });

    const [, , ttl] = mockSetCache.mock.calls[0]! as [string, unknown, number];
    expect(ttl).toBe(14400);
  });
});

describe('handleCompaniesHouseWebhook — ignored events', () => {
  it('ignores events with a resource_kind other than company-profile', async () => {
    await handleCompaniesHouseWebhook({
      resource_kind: 'officer',
      resource_id: '12345678',
    });

    expect(mockFetchCompanyProfile).not.toHaveBeenCalled();
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('ignores events missing resource_id', async () => {
    await handleCompaniesHouseWebhook({
      resource_kind: 'company-profile',
    });

    expect(mockFetchCompanyProfile).not.toHaveBeenCalled();
    expect(mockSetCache).not.toHaveBeenCalled();
  });

  it('ignores unknown payload shapes without throwing', async () => {
    // Non-object primitives coerce to an object cast — resource_kind is undefined → early return
    await expect(handleCompaniesHouseWebhook('bad')).resolves.toBeUndefined();
    await expect(handleCompaniesHouseWebhook({})).resolves.toBeUndefined();
    await expect(handleCompaniesHouseWebhook({ resource_kind: 'filing' })).resolves.toBeUndefined();
  });
});

describe('handleCompaniesHouseWebhook — error resilience', () => {
  it('does not propagate when fetchCompanyProfile throws', async () => {
    mockFetchCompanyProfile.mockRejectedValue(new Error('CH API down'));

    await expect(handleCompaniesHouseWebhook({
      resource_kind: 'company-profile',
      resource_id: '12345678',
    })).resolves.toBeUndefined();

    expect(mockSetCache).not.toHaveBeenCalled();
  });
});

// ---- cacheUKEntity ----------------------------------------------------------

describe('cacheUKEntity', () => {
  it('resolves entity via resolveUKEntity and writes to cache with watchlist entry', async () => {
    await cacheUKEntity('Test Corp Ltd');

    expect(mockResolveUKEntity).toHaveBeenCalledWith('Test Corp Ltd');
    expect(mockSetCache).toHaveBeenCalledOnce();
    expect(mockAddToUKWatchlist).toHaveBeenCalledWith('Test Corp Ltd');
  });

  it('does not write to cache when resolveUKEntity returns null', async () => {
    mockResolveUKEntity.mockResolvedValue(null);

    await cacheUKEntity('Unknown Co Ltd');

    expect(mockSetCache).not.toHaveBeenCalled();
    expect(mockAddToUKWatchlist).not.toHaveBeenCalled();
  });

  it('does not propagate when resolveUKEntity throws', async () => {
    mockResolveUKEntity.mockRejectedValue(new Error('network error'));

    await expect(cacheUKEntity('Test Corp Ltd')).resolves.toBeUndefined();
    expect(mockSetCache).not.toHaveBeenCalled();
  });
});

// ---- startCompaniesHouseCron ------------------------------------------------

describe('startCompaniesHouseCron', () => {
  it('schedules a cron job at 3am UTC daily', () => {
    startCompaniesHouseCron();

    expect(cron.schedule).toHaveBeenCalledWith('0 3 * * *', expect.any(Function));
  });

  it('the scheduled callback triggers nightly sync against the watchlist', async () => {
    mockGetUKWatchlist.mockResolvedValue(['Test Corp Ltd', 'Another Co']);

    startCompaniesHouseCron();
    const [[, callback]] = (cron.schedule as ReturnType<typeof vi.fn>).mock.calls as [[string, () => Promise<void>]];

    // Fast-forward: call the cron callback (uses real setTimeout for 500ms delays,
    // so we stub resolveUKEntity to resolve quickly and just verify it's called)
    vi.useFakeTimers();
    const syncPromise = callback();
    // Advance past the 500ms delay between each entity
    await vi.runAllTimersAsync();
    await syncPromise;
    vi.useRealTimers();

    expect(mockResolveUKEntity).toHaveBeenCalledTimes(2);
    expect(mockResolveUKEntity).toHaveBeenCalledWith('Test Corp Ltd');
    expect(mockResolveUKEntity).toHaveBeenCalledWith('Another Co');
  });

  it('skips sync when watchlist is empty', async () => {
    mockGetUKWatchlist.mockResolvedValue([]);

    startCompaniesHouseCron();
    const [[, callback]] = (cron.schedule as ReturnType<typeof vi.fn>).mock.calls as [[string, () => Promise<void>]];
    await callback();

    expect(mockResolveUKEntity).not.toHaveBeenCalled();
  });
});
