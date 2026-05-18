import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../resolvers/entity-resolver.js', () => ({
  generateEntityId: (_jur: string, name: string) =>
    `corpsig_test_${name.toLowerCase().replace(/\s+/g, '_')}`,
}));

import { lookupSOSEntity, mapScrapedRecordToEntity, SCRAPE_ONLY_STATES } from '../../../ingest/sources/sos-portals.js';
import { lookupDelawareEntity } from '../../../ingest/sources/sos-delaware.js';
import { lookupCaliforniaEntity } from '../../../ingest/sources/sos-california.js';
import { lookupNewYorkEntity } from '../../../ingest/sources/sos-new-york.js';
import { lookupTexasEntity } from '../../../ingest/sources/sos-texas.js';
import { lookupFloridaEntity } from '../../../ingest/sources/sos-florida.js';
import { lookupColoradoEntity } from '../../../ingest/sources/sos-colorado.js';
import { lookupWashingtonEntity } from '../../../ingest/sources/sos-washington.js';
import { lookupIllinoisEntity } from '../../../ingest/sources/sos-illinois.js';
import { lookupGeorgiaEntity } from '../../../ingest/sources/sos-georgia.js';

afterEach(() => vi.unstubAllGlobals());

function jsonResponse(data: unknown, ok = true): Response {
  return {
    ok,
    json: async () => data,
    text: async () => JSON.stringify(data),
    headers: { get: () => 'application/json' },
    status: ok ? 200 : 500,
  } as unknown as Response;
}

function htmlResponse(html: string, ok = true): Response {
  return {
    ok,
    text: async () => html,
    json: async () => ({}),
    headers: { get: () => 'text/html' },
    status: ok ? 200 : 500,
  } as unknown as Response;
}

function viewstateHtml(): string {
  // Must use name= (not id=) — collectHiddens() reads the name attribute
  return `<html><body>
    <input type="hidden" name="__VIEWSTATE" value="vs_test" />
    <input type="hidden" name="__EVENTVALIDATION" value="ev_test" />
  </body></html>`;
}

// ---- lookupSOSEntity dispatch -----------------------------------------------

describe('lookupSOSEntity — dispatch', () => {
  it('returns null (without calling any API) for scrape-only states', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    for (const jur of SCRAPE_ONLY_STATES) {
      const result = await lookupSOSEntity('Any Corp', jur);
      expect(result).toBeNull();
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('routes US-TX to Texas Socrata API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse([
      { taxpayer_name: 'Texas Corp LLC', right_to_transact_business: 'Active' },
    ])));

    const result = await lookupSOSEntity('Texas Corp LLC', 'US-TX');
    expect(result?.jurisdiction).toBe('US-TX');
  });

  it('delegates unknown pending jurisdiction via lookupPendingStateEntity', async () => {
    // US-NV is in SOS_PENDING — handled by lookupPendingStateEntity (Nevada JSON)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({
      searchResultList: [{ entityName: 'Silver Corp', status: 'Active' }],
    })));

    const result = await lookupSOSEntity('Silver Corp', 'US-NV');
    expect(result?.jurisdiction).toBe('US-NV');
  });
});

// ---- mapScrapedRecordToEntity -----------------------------------------------

describe('mapScrapedRecordToEntity', () => {
  it('maps Active → active status', () => {
    const entity = mapScrapedRecordToEntity({
      entity_name: 'Test Corp',
      jurisdiction: 'US-WV',
      status: 'Active',
      incorporated_at: '2005-01-01',
      registered_agent_name: 'CT Corp',
      registered_agent_address: '100 Main St, Charleston, WV',
    });

    expect(entity.status).toBe('active');
    expect(entity.canonical_name).toBe('Test Corp');
    expect(entity.jurisdiction).toBe('US-WV');
    expect(entity.registered_agent?.name).toBe('CT Corp');
    expect(entity.confidence).toBe(0.9);
    expect(entity.source).toContain('sos_scraper');
  });

  it('maps Dissolved → dissolved status', () => {
    const entity = mapScrapedRecordToEntity({
      entity_name: 'Old Corp',
      jurisdiction: 'US-AL',
      status: 'Dissolved',
      incorporated_at: null,
      registered_agent_name: null,
      registered_agent_address: null,
    });

    expect(entity.status).toBe('dissolved');
    expect(entity.registered_agent).toBeNull();
  });

  it('maps unknown status strings → unknown', () => {
    const entity = mapScrapedRecordToEntity({
      entity_name: 'Mystery Corp',
      jurisdiction: 'US-MT',
      status: 'Pending Review',
      incorporated_at: null,
      registered_agent_name: null,
      registered_agent_address: null,
    });

    expect(entity.status).toBe('unknown');
  });
});

// ---- lookupDelawareEntity (ICIS ASPX two-step) ------------------------------

const DE_GRID_HTML = `<html><body>
<table id="tblResults">
  <tr><th>File No</th><th>Name</th><th>Status</th></tr>
  <tr>
    <td><span id="ctl00_ContentPlaceHolder1_GridView1_ctl02_lblFileNumber">1234567</span></td>
    <td><a id="ctl00_ContentPlaceHolder1_GridView1_ctl02_lnkbtnEntityName" data-ca="False">First State Holdings LLC</a></td>
    <td>Good Standing</td>
  </tr>
</table>
</body></html>`;

const DE_DETAIL_HTML = `<html><body>
  <span id="ctl00_ContentPlaceHolder1_lblAgentName">National Corporate Research</span>
  <span id="ctl00_ContentPlaceHolder1_lblAgentAddress1">850 New Burton Rd</span>
  <span id="ctl00_ContentPlaceHolder1_lblAgentCity">Dover</span>
  <span id="ctl00_ContentPlaceHolder1_lblAgentState">DE</span>
  <span id="ctl00_ContentPlaceHolder1_lblAgentPostalCode">19904</span>
  <span id="ctl00_ContentPlaceHolder1_lblIncDate">2002-03-14</span>
  <p>GOOD STANDING</p>
</body></html>`;

describe('lookupDelawareEntity — ICIS ASPX', () => {
  it('performs GET (ViewState) then POST (search) then POST (detail) — 3 fetch calls', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))   // GET ViewState
      .mockResolvedValueOnce(htmlResponse(DE_GRID_HTML))      // POST search
      .mockResolvedValueOnce(htmlResponse(DE_DETAIL_HTML));   // POST detail
    vi.stubGlobal('fetch', mockFetch);

    const result = await lookupDelawareEntity('First State Holdings LLC');
    expect(mockFetch).toHaveBeenCalledTimes(3);
    expect(result).not.toBeNull();
    expect(result!.canonical_name).toBe('First State Holdings LLC');
    expect(result!.jurisdiction).toBe('US-DE');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('delaware_sos');
  });

  it('source_url is the direct ICIS entity permalink (SearchDetailsPage.aspx?i=fileNumber)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse(DE_GRID_HTML))
      .mockResolvedValueOnce(htmlResponse(DE_DETAIL_HTML)));

    const result = await lookupDelawareEntity('First State Holdings LLC');
    expect(result!.source_url).toContain('SearchDetailsPage.aspx');
    expect(result!.source_url).toContain('i=1234567');
  });

  it('includes ViewState values in the POST body', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse(DE_GRID_HTML))
      .mockResolvedValueOnce(htmlResponse(DE_DETAIL_HTML));
    vi.stubGlobal('fetch', mockFetch);

    await lookupDelawareEntity('First State Holdings LLC');
    const postBody = mockFetch.mock.calls[1]![1]?.body as string;
    expect(postBody).toContain('__VIEWSTATE=vs_test');
  });

  it('returns null when search returns no grid rows', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse('<html><body>No results</body></html>')));

    const result = await lookupDelawareEntity('Ghost Corp LLC');
    expect(result).toBeNull();
  });

  it('returns null when initial GET fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse('', false)));

    const result = await lookupDelawareEntity('Any Corp');
    expect(result).toBeNull();
  });

  it('parses registered agent and address from detail page using real ICIS span IDs', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse(DE_GRID_HTML))
      .mockResolvedValueOnce(htmlResponse(DE_DETAIL_HTML)));

    const result = await lookupDelawareEntity('First State Holdings LLC');
    expect(result!.registered_agent?.name).toBe('National Corporate Research');
    expect(result!.registered_agent?.address).toContain('Dover');
  });

  it('parses incorporation date from lblIncDate span', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse(DE_GRID_HTML))
      .mockResolvedValueOnce(htmlResponse(DE_DETAIL_HTML)));

    const result = await lookupDelawareEntity('First State Holdings LLC');
    expect(result!.incorporated_at).toBe('2002-03-14');
  });

  it('officers is always empty — ICIS does not expose officer data publicly', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(htmlResponse(viewstateHtml()))
      .mockResolvedValueOnce(htmlResponse(DE_GRID_HTML))
      .mockResolvedValueOnce(htmlResponse(DE_DETAIL_HTML)));

    const result = await lookupDelawareEntity('First State Holdings LLC');
    expect(result!.officers).toEqual([]);
  });
});

// ---- lookupCaliforniaEntity (BizFile JSON POST) -----------------------------

const CA_RESPONSE = {
  hits: {
    hits: [{
      _source: {
        CORP_NUM: 'C12345',
        NAME: 'Golden State Corp',
        STATUS: 'ACTIVE',
        ENTITY_TYPE: 'DOMESTIC STOCK CORPORATION',
        FILING_DATE: '2000-06-15',
        AGENT_NAME: 'CT Corporation System',
        AGENT_ADDRESS: '818 West Seventh Street, Los Angeles, CA 90017',
      },
    }],
  },
};

describe('lookupCaliforniaEntity — BizFile JSON POST', () => {
  it('returns an active entity from BizFile search', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(CA_RESPONSE)));

    const result = await lookupCaliforniaEntity('Golden State Corp');
    expect(result!.canonical_name).toBe('Golden State Corp');
    expect(result!.jurisdiction).toBe('US-CA');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('california_sos');
  });

  it('maps registered agent from AGENT_NAME field', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(CA_RESPONSE)));

    const result = await lookupCaliforniaEntity('Golden State Corp');
    expect(result!.registered_agent?.name).toBe('CT Corporation System');
    expect(result!.registered_agent?.address).toContain('Los Angeles');
  });

  it('sends request as POST method', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(jsonResponse(CA_RESPONSE));
    vi.stubGlobal('fetch', mockFetch);

    await lookupCaliforniaEntity('Golden State Corp');
    expect(mockFetch.mock.calls[0]![1]?.method).toBe('POST');
  });

  it('returns null when hits are empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ hits: { hits: [] } })));

    const result = await lookupCaliforniaEntity('Ghost Corp');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const result = await lookupCaliforniaEntity('Any Corp');
    expect(result).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new Error('network')));

    const result = await lookupCaliforniaEntity('Any Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupNewYorkEntity (Socrata JSON GET) ----------------------------------

const NY_RECORDS = [
  {
    current_entity_name: 'Empire State Ventures Inc',
    dos_id: 'DOS123456',
    entity_type: 'DOMESTIC BUSINESS CORPORATION',
    date_of_initial_dos_filing: '1995-04-10',
    county: 'NEW YORK',
  },
];

describe('lookupNewYorkEntity — Socrata GET', () => {
  it('returns an active entity (NY dataset is implicitly active)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => NY_RECORDS } as unknown as Response));

    const result = await lookupNewYorkEntity('Empire State Ventures Inc');
    expect(result!.canonical_name).toBe('Empire State Ventures Inc');
    expect(result!.jurisdiction).toBe('US-NY');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('new_york_dos');
    expect(result!.source_url).toContain('DOS123456');
  });

  it('returns null for empty results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => [] } as unknown as Response));

    const result = await lookupNewYorkEntity('Ghost Corp');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response));

    const result = await lookupNewYorkEntity('Any Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupTexasEntity (Socrata JSON GET) -----------------------------------

const TX_RECORDS = [
  {
    taxpayer_name: 'LONE STAR HOLDINGS LLC',
    taxpayer_number: 'TX-11111',
    right_to_transact_business: 'Active',
    city: 'Houston',
    state: 'TX',
    zip: '77001',
  },
];

describe('lookupTexasEntity — Socrata GET', () => {
  it('returns an active entity from the Comptroller dataset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(TX_RECORDS)));

    const result = await lookupTexasEntity('Lone Star Holdings LLC');
    expect(result!.canonical_name).toBe('LONE STAR HOLDINGS LLC');
    expect(result!.jurisdiction).toBe('US-TX');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('texas_sos');
  });

  it('includes city/state/zip as registered agent address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(TX_RECORDS)));

    const result = await lookupTexasEntity('Lone Star Holdings LLC');
    expect(result!.registered_agent?.address).toContain('Houston');
    expect(result!.registered_agent?.name).toBe('Principal Office');
  });

  it('returns null for empty Socrata results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse([])));

    const result = await lookupTexasEntity('Ghost Corp');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({}, false)));

    const result = await lookupTexasEntity('Any Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupFloridaEntity (JSON + HTML fallback) -----------------------------

const FL_JSON_RESPONSE = {
  Items: [{
    EntityName: 'Sunshine State Corp',
    DocumentNumber: 'P22000012345',
    Status: 'ACTIVE',
    FiledDate: '2022-01-15',
  }],
};

const FL_HTML = `<html><body>
<table>
  <tr><th>Entity Name</th><th>Document #</th><th>Status</th><th>Filed</th></tr>
  <tr><td>Sunshine State Corp</td><td>P99000099</td><td>ACTIVE</td><td>2020-06-01</td></tr>
</table>
</body></html>`;

describe('lookupFloridaEntity — JSON path', () => {
  it('returns an active entity from the JSON response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => FL_JSON_RESPONSE,
    } as unknown as Response));

    const result = await lookupFloridaEntity('Sunshine State Corp');
    expect(result!.canonical_name).toBe('Sunshine State Corp');
    expect(result!.jurisdiction).toBe('US-FL');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('florida_sunbiz');
    expect(result!.source_url).toContain('P22000012345');
  });

  it('returns null when Items is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ Items: [] }),
    } as unknown as Response));

    const result = await lookupFloridaEntity('Ghost Corp');
    expect(result).toBeNull();
  });
});

describe('lookupFloridaEntity — HTML fallback path', () => {
  it('falls back to HTML table parsing when response is HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/html' },
      text: async () => FL_HTML,
    } as unknown as Response));

    const result = await lookupFloridaEntity('Sunshine State Corp');
    expect(result!.canonical_name).toBe('Sunshine State Corp');
    expect(result!.status).toBe('active');
    expect(result!.source_url).toContain('P99000099');
  });

  it('returns null when no table found in HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      headers: { get: () => 'text/html' },
      text: async () => '<html><body>No results</body></html>',
    } as unknown as Response));

    const result = await lookupFloridaEntity('Ghost Corp');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, headers: { get: () => null } } as unknown as Response));

    const result = await lookupFloridaEntity('Any Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupColoradoEntity (Socrata + SOS form fallback) --------------------

const CO_SOCRATA_RECORDS = [
  {
    entityname: 'Mountain West Holdings Inc',
    entityid: 'CO-20050123',
    entitystatus: 'Good Standing',
    entitytype: 'CORPORATION',
    registeredagentname: 'CT Corp System',
    registeredagentaddress1: '1700 Lincoln St',
    registeredagentcity: 'Denver',
    formationdate: '2005-07-22',
  },
];

const CO_HTML = `<html><body>
<table>
  <tr><th>Name</th><th>Entity ID</th><th>Status</th><th>Type</th><th>Formation Date</th></tr>
  <tr><td>Mountain Corp LLC</td><td>CO-99999</td><td>Good Standing</td><td>LLC</td><td>2010-04-01</td></tr>
</table>
</body></html>`;

describe('lookupColoradoEntity — Socrata path', () => {
  it('returns an active entity from Socrata', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(CO_SOCRATA_RECORDS)));

    const result = await lookupColoradoEntity('Mountain West Holdings Inc');
    expect(result!.canonical_name).toBe('Mountain West Holdings Inc');
    expect(result!.jurisdiction).toBe('US-CO');
    expect(result!.status).toBe('active');
    expect(result!.registered_agent?.name).toBe('CT Corp System');
    expect(result!.source).toBe('colorado_sos');
  });

  it('tries the second Socrata candidate when first returns no results', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse([]))              // first Socrata — no results
      .mockResolvedValueOnce(jsonResponse(CO_SOCRATA_RECORDS))); // second Socrata — success

    const result = await lookupColoradoEntity('Mountain West Holdings Inc');
    expect(result!.canonical_name).toBe('Mountain West Holdings Inc');
  });
});

describe('lookupColoradoEntity — SOS form HTML fallback', () => {
  it('falls back to SOS form HTML when both Socrata candidates fail', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse([], false))   // first Socrata — error
      .mockResolvedValueOnce(jsonResponse([], false))   // second Socrata — error
      .mockResolvedValueOnce(htmlResponse(CO_HTML)));   // SOS form HTML

    const result = await lookupColoradoEntity('Mountain Corp LLC');
    expect(result!.canonical_name).toBe('Mountain Corp LLC');
    expect(result!.status).toBe('active');
    expect(result!.source_url).toContain('CO-99999');
  });

  it('returns null when both Socrata fail and HTML table has no rows', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse([], false))
      .mockResolvedValueOnce(jsonResponse([], false))
      .mockResolvedValueOnce(htmlResponse('<html><body>No results</body></html>')));

    const result = await lookupColoradoEntity('Ghost Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupWashingtonEntity (CCFS multi-path GET) ---------------------------

const WA_RESPONSE = {
  data: [{
    entityId: 'WA-999',
    entityName: 'Cascade Ventures LLC',
    entityStatus: 'Active',
    formationDate: '2008-11-20',
    registeredAgent: {
      name: 'Northwest Registered Agent',
      address: { addressLine1: '300 Deschutes Way', city: 'Tumwater', state: 'WA', postalCode: '98501' },
    },
  }],
  totalCount: 1,
};

describe('lookupWashingtonEntity — CCFS multi-path GET', () => {
  it('returns an active entity from the first responsive API endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(WA_RESPONSE)));

    const result = await lookupWashingtonEntity('Cascade Ventures LLC');
    expect(result!.canonical_name).toBe('Cascade Ventures LLC');
    expect(result!.jurisdiction).toBe('US-WA');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('washington_sos');
    expect(result!.source_url).toContain('WA-999');
  });

  it('maps registered agent name and address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse(WA_RESPONSE)));

    const result = await lookupWashingtonEntity('Cascade Ventures LLC');
    expect(result!.registered_agent?.name).toBe('Northwest Registered Agent');
    expect(result!.registered_agent?.address).toContain('Tumwater');
  });

  it('tries subsequent API candidates when the first fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, false))   // first candidate fails
      .mockResolvedValueOnce(jsonResponse(WA_RESPONSE))); // second candidate succeeds

    const result = await lookupWashingtonEntity('Cascade Ventures LLC');
    expect(result!.canonical_name).toBe('Cascade Ventures LLC');
  });

  it('returns null when all API candidates fail', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(jsonResponse({}, false)));

    const result = await lookupWashingtonEntity('Any Corp');
    expect(result).toBeNull();
  });

  it('returns null on empty data array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(jsonResponse({ data: [], totalCount: 0 })));

    const result = await lookupWashingtonEntity('Ghost Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupIllinoisEntity (JSON POST) ---------------------------------------

const IL_RESPONSE = {
  rows: [{
    entityName: 'Prairie State Holdings Inc',
    fileNumber: 'IL-12345',
    entityType: 'Corporation',
    status: 'Good Standing',
    dateOfFormation: '2001-04-15',
    agentName: 'Illinois Registered Agent LLC',
    agentAddress: '100 W Randolph St, Chicago, IL 60601',
  }],
  total: 1,
};

describe('lookupIllinoisEntity — JSON POST', () => {
  it('returns an active entity from the Illinois SOS', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => IL_RESPONSE,
    } as unknown as Response));

    const result = await lookupIllinoisEntity('Prairie State Holdings Inc');
    expect(result!.canonical_name).toBe('Prairie State Holdings Inc');
    expect(result!.jurisdiction).toBe('US-IL');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('illinois_sos');
    expect(result!.source_url).toContain('IL-12345');
  });

  it('sends request as POST with form-encoded body', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => IL_RESPONSE } as unknown as Response);
    vi.stubGlobal('fetch', mockFetch);

    await lookupIllinoisEntity('Prairie State Holdings Inc');
    expect(mockFetch.mock.calls[0]![1]?.method).toBe('POST');
    expect(mockFetch.mock.calls[0]![1]?.headers?.['Content-Type']).toContain('application/x-www-form-urlencoded');
  });

  it('maps registered agent name and address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => IL_RESPONSE } as unknown as Response));

    const result = await lookupIllinoisEntity('Prairie State Holdings Inc');
    expect(result!.registered_agent?.name).toBe('Illinois Registered Agent LLC');
    expect(result!.registered_agent?.address).toContain('Chicago');
  });

  it('returns null on empty rows array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ rows: [] }) } as unknown as Response));

    const result = await lookupIllinoisEntity('Ghost Corp');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 500 } as unknown as Response));

    const result = await lookupIllinoisEntity('Any Corp');
    expect(result).toBeNull();
  });
});

// ---- lookupGeorgiaEntity (JSON GET) -----------------------------------------

const GA_RESPONSE = {
  results: [{
    businessName: 'Peach State Corp',
    controlNumber: 'GA-77777',
    businessType: 'Domestic Corporation',
    businessStatus: 'Active',
    dateOfFormation: '2012-07-04',
    registeredAgent: 'CT Corporation System',
    registeredOffice: '289 S Culver St, Lawrenceville, GA 30046',
  }],
  totalCount: 1,
};

describe('lookupGeorgiaEntity — JSON GET', () => {
  it('returns an active entity from the Georgia eCorp API', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => GA_RESPONSE } as unknown as Response));

    const result = await lookupGeorgiaEntity('Peach State Corp');
    expect(result!.canonical_name).toBe('Peach State Corp');
    expect(result!.jurisdiction).toBe('US-GA');
    expect(result!.status).toBe('active');
    expect(result!.source).toBe('georgia_sos');
    expect(result!.source_url).toContain('GA-77777');
  });

  it('maps registered agent and office address', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => GA_RESPONSE } as unknown as Response));

    const result = await lookupGeorgiaEntity('Peach State Corp');
    expect(result!.registered_agent?.name).toBe('CT Corporation System');
    expect(result!.registered_agent?.address).toContain('Lawrenceville');
  });

  it('maps dissolved status correctly', async () => {
    const dissolved = { results: [{ businessName: 'Old Corp', businessStatus: 'Withdrawn', controlNumber: 'GA-1' }] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => dissolved } as unknown as Response));

    const result = await lookupGeorgiaEntity('Old Corp');
    expect(result!.status).toBe('dissolved');
  });

  it('returns null on empty results', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ results: [] }) } as unknown as Response));

    const result = await lookupGeorgiaEntity('Ghost Corp');
    expect(result).toBeNull();
  });

  it('returns null on HTTP error (no throw)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response));

    const result = await lookupGeorgiaEntity('Any Corp');
    expect(result).toBeNull();
  });
});
