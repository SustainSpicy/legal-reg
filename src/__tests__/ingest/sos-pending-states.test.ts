import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_test_${name.toLowerCase().replace(/\s+/g, '_')}`,
}));

import {
  lookupNevadaEntity,
  lookupOhioEntity,
  lookupVirginiaEntity,
  lookupOregonEntity,
  lookupMinnesotaEntity,
  lookupMassachusettsEntity,
  lookupWyomingEntity,
  lookupPendingStateEntity,
} from '../../ingest/sources/sos-pending-states.js';

// ---- HTML helpers -----------------------------------------------------------

function jsonResponse(data: unknown, ok = true): Response {
  return { ok, json: async () => data, text: async () => '' } as unknown as Response;
}

function htmlResponse(html: string, ok = true): Response {
  return {
    ok,
    text: async () => html,
    json: async () => ({}),
    headers: { get: (_name: string) => null },
  } as unknown as Response;
}

function viewstateHtml(extra = ''): string {
  return `<html><body>
    <input type="hidden" id="__VIEWSTATE" value="vs_abc" />
    <input type="hidden" id="__EVENTVALIDATION" value="ev_def" />
    <input type="hidden" id="__VIEWSTATEGENERATOR" value="vsg_ghi" />
    ${extra}
  </body></html>`;
}

/** 5-column table matching Oregon's "results" class selector. */
function oregonTable(name: string, status: string, incDate: string): string {
  return `<table class="results">
    <tr><th>Name</th><th>ID</th><th>Status</th><th>Type</th><th>Inc Date</th></tr>
    <tr><td>${name}</td><td>OR123</td><td>${status}</td><td>LLC</td><td>${incDate}</td></tr>
  </table>`;
}

/** 2-column table — matches Minnesota's generic first-table selector. */
function mnTable(name: string, status: string): string {
  return `<table>
    <tr><th>Name</th><th>Status</th></tr>
    <tr><td>${name}</td><td>${status}</td></tr>
  </table>`;
}

/** 4-column table matching Massachusetts' id="searchResults" selector. */
function maTable(name: string, status: string, incDate: string): string {
  return `<table id="searchResults">
    <tr><th>Name</th><th>ID</th><th>Status</th><th>Inc Date</th></tr>
    <tr><td>${name}</td><td>MA001</td><td>${status}</td><td>${incDate}</td></tr>
  </table>`;
}

/** 3-column table matching Wyoming's id="grdSearchResults" selector. */
function wyTable(name: string, status: string): string {
  return `<table id="grdSearchResults">
    <tr><th>Name</th><th>ID</th><th>Status</th></tr>
    <tr><td>${name}</td><td>WY001</td><td>${status}</td></tr>
  </table>`;
}

afterEach(() => vi.unstubAllGlobals());
beforeEach(() => vi.clearAllMocks());

// ---- JSON REST — Nevada (POST) -----------------------------------------------

describe('lookupNevadaEntity — JSON REST (POST)', () => {
  it('returns an active entity on a successful response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({ searchResultList: [{ entityName: 'Acme Corp', status: 'Active', formationDate: '2010-03-01' }] }),
    ));

    const result = await lookupNevadaEntity('Acme Corp');
    expect(result).not.toBeNull();
    expect(result!.canonical_name).toBe('Acme Corp');
    expect(result!.status).toBe('active');
    expect(result!.jurisdiction).toBe('US-NV');
    expect(result!.incorporated_at).toBe('2010-03-01');
  });

  it('prefers the exact case-insensitive name match over the first result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({
        searchResultList: [
          { entityName: 'Nevada Corp LLC', status: 'Active' },
          { entityName: 'Acme Corp', status: 'Active' },
        ],
      }),
    ));

    const result = await lookupNevadaEntity('Acme Corp');
    expect(result!.canonical_name).toBe('Acme Corp');
  });

  it('falls back to the first result when no exact match exists', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({ searchResultList: [{ entityName: 'Acme Holdings LLC', status: 'Active' }] }),
    ));

    const result = await lookupNevadaEntity('Acme Corp');
    expect(result!.canonical_name).toBe('Acme Holdings LLC');
  });

  it('returns null for an empty result list', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({ searchResultList: [] }),
    ));
    expect(await lookupNevadaEntity('Ghost Corp')).toBeNull();
  });

  it('returns null on an HTTP error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));
    expect(await lookupNevadaEntity('Acme Corp')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network error')));
    expect(await lookupNevadaEntity('Acme Corp')).toBeNull();
  });
});

// ---- mapStatus via Nevada responses ------------------------------------------

describe('mapStatus (tested through Nevada responses)', () => {
  const cases: Array<[string, string]> = [
    ['Active', 'active'],
    ['Good Standing', 'active'],
    ['Current', 'active'],
    ['Dissolved', 'dissolved'],
    ['Cancelled', 'dissolved'],
    ['Terminated', 'dissolved'],
    ['Revoked', 'dissolved'],
    ['Forfeited', 'dissolved'],
    ['Void', 'dissolved'],
    ['Expired', 'dissolved'],
    ['Suspended', 'suspended'],
    ['Delinquent', 'suspended'],
    ['Inactive', 'suspended'],
    ['Pending Review', 'unknown'],
  ];

  it.each(cases)('raw status %s → entity status %s', async (rawStatus, expectedStatus) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({ searchResultList: [{ entityName: 'Test Corp', status: rawStatus }] }),
    ));
    const result = await lookupNevadaEntity('Test Corp');
    expect(result!.status).toBe(expectedStatus);
  });
});

// ---- JSON REST — Ohio (POST, nested data array) ------------------------------

describe('lookupOhioEntity — JSON REST (POST, data array)', () => {
  it('maps registered agent from response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({
        data: [{
          name: 'Buckeye LLC',
          status: 'Active',
          formDate: '2005-11-20',
          agentName: 'CT Corp System',
          agentAddress: '4400 Easton Commons Way, Columbus, OH',
        }],
      }),
    ));

    const result = await lookupOhioEntity('Buckeye LLC');
    expect(result!.status).toBe('active');
    expect(result!.registered_agent?.name).toBe('CT Corp System');
    expect(result!.incorporated_at).toBe('2005-11-20');
  });

  it('returns null on empty data array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [] })));
    expect(await lookupOhioEntity('Ghost LLC')).toBeNull();
  });
});

// ---- JSON REST — Virginia (GET, entityId in sourceUrl) ----------------------

describe('lookupVirginiaEntity — JSON REST (GET)', () => {
  it('builds a source_url from entityId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({
        results: [{
          entityName: 'Old Dominion Corp',
          status: 'Active',
          entityId: 'VA-9876',
          dateOfFormation: '2000-07-04',
          registeredAgent: 'Registered Agents Inc',
        }],
      }),
    ));

    const result = await lookupVirginiaEntity('Old Dominion Corp');
    expect(result!.source_url).toContain('VA-9876');
    expect(result!.registered_agent?.name).toBe('Registered Agents Inc');
  });

  it('uses a fallback source_url when entityId is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({ results: [{ entityName: 'Acme Corp', status: 'Active' }] }),
    ));

    const result = await lookupVirginiaEntity('Acme Corp');
    expect(result!.source_url).toContain('cis.scc.virginia.gov');
  });
});

// ---- HTML table — Oregon (GET, "results" class) -----------------------------

describe('lookupOregonEntity — HTML table (GET)', () => {
  it('parses entity name and status from HTML table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      htmlResponse(oregonTable('Cascade Trading Co', 'Active', '2012-04-01')),
    ));

    const result = await lookupOregonEntity('Cascade Trading Co');
    expect(result!.canonical_name).toBe('Cascade Trading Co');
    expect(result!.status).toBe('active');
    expect(result!.incorporated_at).toBe('2012-04-01');
    expect(result!.jurisdiction).toBe('US-OR');
  });

  it('returns null when no matching table is found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse('<html><body>No results</body></html>')));
    expect(await lookupOregonEntity('Ghost Corp')).toBeNull();
  });

  it('returns null on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse('', false)));
    expect(await lookupOregonEntity('Any Corp')).toBeNull();
  });
});

// ---- HTML table — Minnesota (GET, generic first table) ----------------------

describe('lookupMinnesotaEntity — HTML table (generic selector)', () => {
  it('parses name and status from the first table', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      htmlResponse(mnTable('North Star LLC', 'Active')),
    ));

    const result = await lookupMinnesotaEntity('North Star LLC');
    expect(result!.canonical_name).toBe('North Star LLC');
    expect(result!.status).toBe('active');
    expect(result!.jurisdiction).toBe('US-MN');
  });
});

// ---- ASPX ViewState — Massachusetts -----------------------------------------

describe('lookupMassachusettsEntity — ASPX two-step', () => {
  it('performs GET then POST and parses the results table', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))   // step 1: GET ViewState page
      .mockResolvedValueOnce(htmlResponse(maTable('Bay State Corp', 'Active', '1998-09-15'))); // step 2: POST results
    vi.stubGlobal('fetch', mockFetch);

    const result = await lookupMassachusettsEntity('Bay State Corp');
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch.mock.calls[0]![0]).toContain('CorpSearch.aspx'); // GET
    expect(mockFetch.mock.calls[1]![1]?.method).toBe('POST');
    expect(result!.canonical_name).toBe('Bay State Corp');
    expect(result!.status).toBe('active');
    expect(result!.incorporated_at).toBe('1998-09-15');
  });

  it('includes ViewState values extracted from the GET response in the POST body', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse(maTable('Bay State Corp', 'Active', '')));
    vi.stubGlobal('fetch', mockFetch);

    await lookupMassachusettsEntity('Bay State Corp');
    const postBody = mockFetch.mock.calls[1]![1]?.body as string;
    expect(postBody).toContain('__VIEWSTATE=vs_abc');
    expect(postBody).toContain('__EVENTVALIDATION=ev_def');
  });

  it('returns null when the GET request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse('', false)));
    expect(await lookupMassachusettsEntity('Bay State Corp')).toBeNull();
  });

  it('returns null when no results table is in the POST response', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse('<html><body>No results found.</body></html>')));
    expect(await lookupMassachusettsEntity('Ghost Corp')).toBeNull();
  });
});

// ---- ASPX ViewState — Wyoming ------------------------------------------------

describe('lookupWyomingEntity — ASPX two-step', () => {
  it('parses results from the grdSearchResults table', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse(wyTable('Cowboy Holdings LLC', 'Active'))));

    const result = await lookupWyomingEntity('Cowboy Holdings LLC');
    expect(result!.canonical_name).toBe('Cowboy Holdings LLC');
    expect(result!.jurisdiction).toBe('US-WY');
    expect(result!.status).toBe('active');
  });
});

// ---- Dispatch — lookupPendingStateEntity ------------------------------------

describe('lookupPendingStateEntity', () => {
  it('returns null for an unsupported jurisdiction', async () => {
    expect(await lookupPendingStateEntity('Any Corp', 'US-ZZ')).toBeNull();
  });

  it('delegates to the correct state function and returns its result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(
      jsonResponse({ searchResultList: [{ entityName: 'Silver State LLC', status: 'Active' }] }),
    ));

    const result = await lookupPendingStateEntity('Silver State LLC', 'US-NV');
    expect(result!.jurisdiction).toBe('US-NV');
    expect(result!.canonical_name).toBe('Silver State LLC');
  });

  it('catches exceptions from state functions and returns null', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('fatal error')));
    expect(await lookupPendingStateEntity('Acme Corp', 'US-NV')).toBeNull();
  });
});
