import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_test_${name.toLowerCase().replace(/\s+/g, '_')}`,
}));

import {
  searchCompaniesHouse,
  fetchCompanyProfile,
  fetchCompanyOfficers,
  resolveUKEntity,
} from '../../../ingest/sources/companies-house.js';

function jsonResponse(data: unknown, ok = true): Response {
  return { ok, json: async () => data, status: ok ? 200 : 401 } as unknown as Response;
}

const SEARCH_RESULTS = [
  { company_number: '12345678', title: 'Test Corp Ltd', company_status: 'active', date_of_creation: '2010-05-15', company_type: 'ltd' },
];

const PROFILE = {
  company_number: '12345678',
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

const OFFICERS_RESPONSE = {
  items: [
    { name: 'Jane Smith', officer_role: 'director', appointed_on: '2010-05-15' },
    { name: 'Bob Jones', officer_role: 'secretary', appointed_on: '2015-01-01', resigned_on: '2022-06-30' },
  ],
};

beforeEach(() => {
  vi.stubEnv('COMPANIES_HOUSE_API_KEY', 'test-api-key');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ---- searchCompaniesHouse ---------------------------------------------------

describe('searchCompaniesHouse', () => {
  it('returns search results from Companies House', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ items: SEARCH_RESULTS })));

    const results = await searchCompaniesHouse('Test Corp Ltd');
    expect(results).toHaveLength(1);
    expect(results[0]!.company_number).toBe('12345678');
  });

  it('returns empty array when items field is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({})));

    const results = await searchCompaniesHouse('Unknown');
    expect(results).toHaveLength(0);
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    await expect(searchCompaniesHouse('Test Corp')).rejects.toThrow('Companies House search failed');
  });

  it('sends Authorization header', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse({ items: [] }));
    vi.stubGlobal('fetch', mockFetch);

    await searchCompaniesHouse('Test');
    const headers = mockFetch.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^Basic /);
  });
});

// ---- fetchCompanyProfile ----------------------------------------------------

describe('fetchCompanyProfile', () => {
  it('returns the company profile', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(PROFILE)));

    const profile = await fetchCompanyProfile('12345678');
    expect(profile.company_name).toBe('Test Corp Ltd');
    expect(profile.company_status).toBe('active');
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    await expect(fetchCompanyProfile('99999999')).rejects.toThrow('Companies House profile fetch failed');
  });
});

// ---- fetchCompanyOfficers ---------------------------------------------------

describe('fetchCompanyOfficers', () => {
  it('returns only current officers (filters out resigned ones)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(OFFICERS_RESPONSE)));

    const officers = await fetchCompanyOfficers('12345678');
    expect(officers).toHaveLength(1);
    expect(officers[0]!.name).toBe('Jane Smith');
  });

  it('returns empty array on HTTP error (does not throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const officers = await fetchCompanyOfficers('00000000');
    expect(officers).toHaveLength(0);
  });

  it('returns empty array when items field is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({})));

    const officers = await fetchCompanyOfficers('12345678');
    expect(officers).toHaveLength(0);
  });
});

// ---- resolveUKEntity --------------------------------------------------------

describe('resolveUKEntity', () => {
  it('returns null when search returns no results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ items: [] })));

    const result = await resolveUKEntity('Nonexistent Corp');
    expect(result).toBeNull();
  });

  it('builds entity with active status for active company', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: SEARCH_RESULTS }))
      .mockResolvedValueOnce(jsonResponse(PROFILE))
      .mockResolvedValueOnce(jsonResponse(OFFICERS_RESPONSE)));

    const result = await resolveUKEntity('Test Corp Ltd');
    expect(result).not.toBeNull();
    expect(result!.status).toBe('active');
    expect(result!.jurisdiction).toBe('GB');
    expect(result!.source).toBe('companies_house');
    expect(result!.confidence).toBe(0.95);
  });

  it('builds entity with dissolved status for non-active company', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: [{ ...SEARCH_RESULTS[0], company_status: 'dissolved' }] }))
      .mockResolvedValueOnce(jsonResponse({ ...PROFILE, company_status: 'dissolved' }))
      .mockResolvedValueOnce(jsonResponse({ items: [] })));

    const result = await resolveUKEntity('Old Corp Ltd');
    expect(result!.status).toBe('dissolved');
  });

  it('maps current officers into the entity officers list', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: SEARCH_RESULTS }))
      .mockResolvedValueOnce(jsonResponse(PROFILE))
      .mockResolvedValueOnce(jsonResponse(OFFICERS_RESPONSE)));

    const result = await resolveUKEntity('Test Corp Ltd');
    expect(result!.officers).toHaveLength(1);
    expect(result!.officers[0]!.name).toBe('Jane Smith');
    expect(result!.officers[0]!.role).toBe('director');
  });

  it('builds registered_agent from office address', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: SEARCH_RESULTS }))
      .mockResolvedValueOnce(jsonResponse(PROFILE))
      .mockResolvedValueOnce(jsonResponse({ items: [] })));

    const result = await resolveUKEntity('Test Corp Ltd');
    expect(result!.registered_agent?.name).toBe('Registered Office');
    expect(result!.registered_agent?.address).toContain('123 High Street');
  });

  it('includes company number in source_url', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({ items: SEARCH_RESULTS }))
      .mockResolvedValueOnce(jsonResponse(PROFILE))
      .mockResolvedValueOnce(jsonResponse({ items: [] })));

    const result = await resolveUKEntity('Test Corp Ltd');
    expect(result!.source_url).toContain('12345678');
  });
});
