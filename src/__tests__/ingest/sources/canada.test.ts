import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_test_${name.toLowerCase().replace(/\s+/g, '_')}`,
}));

import {
  lookupFederalCanadaEntity,
  lookupBCEntity,
  lookupOntarioEntity,
  lookupAlbertaEntity,
  lookupQuebecEntity,
  resolveCanadianEntity,
  fetchSEDARFilings,
} from '../../../ingest/sources/canada.js';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(data: unknown, ok = true): Response {
  return { ok, json: async () => data, status: ok ? 200 : 500 } as unknown as Response;
}

// ---- lookupFederalCanadaEntity ----------------------------------------------

describe('lookupFederalCanadaEntity', () => {
  it('returns an active entity from Corporations Canada results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      corpList: [{
        corpNm: 'Maple Corp Inc',
        corpSt: 'Active',
        incorporationDt: '2005-03-15',
        corporationNumber: 'CA12345',
        registeredOffice: { streetAddress: '123 Main St', city: 'Ottawa', province: 'ON', postalCode: 'K1A 0A6' },
      }],
    })));

    const result = await lookupFederalCanadaEntity('Maple Corp Inc');
    expect(result).not.toBeNull();
    expect(result!.canonical_name).toBe('Maple Corp Inc');
    expect(result!.jurisdiction).toBe('CA');
    expect(result!.status).toBe('active');
    expect(result!.incorporated_at).toBe('2005-03-15');
    expect(result!.source).toBe('corporations_canada');
  });

  it('builds source_url from corporationNumber', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      corpList: [{ corpNm: 'Corp A', corpSt: 'Active', corporationNumber: 'XY999' }],
    })));

    const result = await lookupFederalCanadaEntity('Corp A');
    expect(result!.source_url).toContain('XY999');
  });

  it('returns null on empty corpList', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ corpList: [] })));

    const result = await lookupFederalCanadaEntity('Ghost Corp');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error (fetch returns non-ok)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const result = await lookupFederalCanadaEntity('Any Corp');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network error')));

    const result = await lookupFederalCanadaEntity('Any Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupBCEntity ---------------------------------------------------------

describe('lookupBCEntity', () => {
  it('returns an entity from BC Corporate Registry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      businesses: [{
        name: 'Pacific Ventures Ltd',
        identifier: 'BC1234567',
        status: 'Active',
        incorporationDate: '2010-08-20',
      }],
    })));

    const result = await lookupBCEntity('Pacific Ventures Ltd');
    expect(result!.canonical_name).toBe('Pacific Ventures Ltd');
    expect(result!.jurisdiction).toBe('CA-BC');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('bc_corporate_registry');
    expect(result!.source_url).toContain('BC1234567');
  });

  it('returns null on empty businesses array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ businesses: [] })));

    expect(await lookupBCEntity('Ghost Ltd')).toBeNull();
  });

  it('returns null on network failure', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('timeout')));

    expect(await lookupBCEntity('Any Corp')).toBeNull();
  });
});

// ---- lookupOntarioEntity ----------------------------------------------------

describe('lookupOntarioEntity', () => {
  it('returns an entity with registered office from Ontario Business Registry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      searchResults: [{
        entityName: 'Ontario Holdings Corp',
        entityStatus: 'ACTIVE',
        entityIdentifier: 'ON-555',
        incorporationDate: '2000-01-01',
        registeredOfficeAddress: '200 King St W, Toronto, ON',
      }],
    })));

    const result = await lookupOntarioEntity('Ontario Holdings Corp');
    expect(result!.canonical_name).toBe('Ontario Holdings Corp');
    expect(result!.jurisdiction).toBe('CA-ON');
    expect(result!.status).toBe('active');
    expect(result!.registered_agent?.address).toBe('200 King St W, Toronto, ON');
    expect(result!.source_url).toContain('ON-555');
  });

  it('returns null on empty results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ searchResults: [] })));

    expect(await lookupOntarioEntity('Ghost Corp')).toBeNull();
  });
});

// ---- lookupAlbertaEntity ----------------------------------------------------

describe('lookupAlbertaEntity', () => {
  it('returns an entity from Alberta Corporate Registry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      results: [{
        legalName: 'Prairie Energy Ltd',
        corpStatus: 'Active',
        incorporationDate: '1998-06-30',
        corporationNumber: 'AB-9876',
        registeredOffice: '400 4th St SW, Calgary, AB',
      }],
    })));

    const result = await lookupAlbertaEntity('Prairie Energy Ltd');
    expect(result!.canonical_name).toBe('Prairie Energy Ltd');
    expect(result!.jurisdiction).toBe('CA-AB');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('alberta_corporate_registry');
  });

  it('returns null on empty results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ results: [] })));

    expect(await lookupAlbertaEntity('Ghost Corp')).toBeNull();
  });
});

// ---- lookupQuebecEntity -----------------------------------------------------

describe('lookupQuebecEntity', () => {
  it('returns an entity from Registraire des entreprises', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      listeEntreprises: [{
        nomEntreprise: 'Entreprise Quebec Inc',
        etatEntreprise: 'en règle',
        dateImmatriculation: '2003-11-01',
        numeroEntreprise: 'QC-001',
        adresseEtablissement: '2000 McGill College, Montréal, QC',
      }],
    })));

    const result = await lookupQuebecEntity('Entreprise Quebec Inc');
    expect(result!.canonical_name).toBe('Entreprise Quebec Inc');
    expect(result!.jurisdiction).toBe('CA-QC');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('req_quebec');
    expect(result!.source_url).toContain('QC-001');
  });

  it('maps French dissolved status correctly', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      listeEntreprises: [{ nomEntreprise: 'Corp QC', etatEntreprise: 'radié' }],
    })));

    const result = await lookupQuebecEntity('Corp QC');
    expect(result!.status).toBe('dissolved');
  });
});

// ---- resolveCanadianEntity — dispatch ----------------------------------------

describe('resolveCanadianEntity — dispatch', () => {
  it('routes CA-BC to lookupBCEntity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      businesses: [{ name: 'BC Co', identifier: 'BC1', status: 'Active' }],
    })));

    const result = await resolveCanadianEntity('BC Co', 'CA-BC');
    expect(result!.jurisdiction).toBe('CA-BC');
  });

  it('routes CA-ON to lookupOntarioEntity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      searchResults: [{ entityName: 'ON Co', entityStatus: 'ACTIVE' }],
    })));

    const result = await resolveCanadianEntity('ON Co', 'CA-ON');
    expect(result!.jurisdiction).toBe('CA-ON');
  });

  it('routes CA-AB to lookupAlbertaEntity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      results: [{ legalName: 'AB Co', corpStatus: 'Active' }],
    })));

    const result = await resolveCanadianEntity('AB Co', 'CA-AB');
    expect(result!.jurisdiction).toBe('CA-AB');
  });

  it('routes CA-QC to lookupQuebecEntity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      listeEntreprises: [{ nomEntreprise: 'QC Co', etatEntreprise: 'active' }],
    })));

    const result = await resolveCanadianEntity('QC Co', 'CA-QC');
    expect(result!.jurisdiction).toBe('CA-QC');
  });

  it('routes bare "CA" jurisdiction to Corporations Canada', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      corpList: [{ corpNm: 'Federal Corp', corpSt: 'Active' }],
    })));

    const result = await resolveCanadianEntity('Federal Corp', 'CA');
    expect(result!.jurisdiction).toBe('CA');
  });
});

// ---- mapStatus via various Canada sources ------------------------------------

describe('mapStatus (Canada) — tested through entity lookups', () => {
  const cases: Array<[string, string, EntityLookupOutputType['status']]> = [
    ['Active', 'CA-BC', 'active'],
    ['Good Standing', 'CA-BC', 'active'],
    ['en règle', 'CA-QC', 'active'],
    ['DISSOLVED', 'CA-BC', 'dissolved'],
    ['CANCELLED', 'CA-BC', 'dissolved'],
    ['Winding Up', 'CA-BC', 'dissolved'],
    ['Suspended', 'CA-BC', 'suspended'],
    ['Inactive', 'CA-BC', 'suspended'],
    ['Unknown Status', 'CA-BC', 'unknown'],
  ];

  it.each(cases)('raw status "%s" → entity status "%s"', async (rawStatus, jurisdiction, expectedStatus) => {
    const responseMap: Record<string, unknown> = {
      'CA-BC': { businesses: [{ name: 'Test Corp', status: rawStatus }] },
      'CA-QC': { listeEntreprises: [{ nomEntreprise: 'Test Corp', etatEntreprise: rawStatus }] },
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(responseMap[jurisdiction])));
    const result = await resolveCanadianEntity('Test Corp', jurisdiction);
    expect(result!.status).toBe(expectedStatus);
  });
});

// ---- fetchSEDARFilings -------------------------------------------------------

describe('fetchSEDARFilings', () => {
  it('returns filings from SEDAR+ search results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      filings: [{
        id: 'SEDAR001',
        formType: 'AIF',
        filedDate: '2024-03-31',
        documentUrl: 'https://sedar.example.com/doc/001',
      }],
      totalCount: 1,
    })));

    const { filings, totalAvailable } = await fetchSEDARFilings('Acme Corp');
    expect(filings).toHaveLength(1);
    expect(filings[0]!.filing_id).toBe('SEDAR_SEDAR001');
    expect(filings[0]!.type).toBe('AIF');
    expect(filings[0]!.source).toBe('SEDAR');
    expect(totalAvailable).toBe(1);
  });

  it('filters by filingTypes when provided', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      filings: [
        { id: 'F1', formType: 'AIF', filedDate: '2024-03-01' },
        { id: 'F2', formType: 'MD&A', filedDate: '2024-06-01' },
      ],
      totalCount: 2,
    })));

    const { filings } = await fetchSEDARFilings('Acme Corp', 10, ['AIF']);
    expect(filings.every((f) => f.type === 'AIF')).toBe(true);
  });

  it('returns empty filings on HTTP error without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const { filings, totalAvailable } = await fetchSEDARFilings('Any Corp');
    expect(filings).toHaveLength(0);
    expect(totalAvailable).toBe(0);
  });

  it('returns empty filings when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network')));

    const { filings } = await fetchSEDARFilings('Any Corp');
    expect(filings).toHaveLength(0);
  });
});

// Type alias so the test file compiles (EntityLookupOutputType used in it.each)
type EntityLookupOutputType = { status: 'active' | 'dissolved' | 'suspended' | 'unknown' };
