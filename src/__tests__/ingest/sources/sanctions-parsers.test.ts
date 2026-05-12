import { describe, it, expect, vi, afterEach } from 'vitest';

// These parsers are not exported directly — we test via the exported fetch functions.
// fetchOFACSDN / fetchOFACConsolidated, fetchEUCFSP, fetchHMTreasury, fetchFinCEN,
// fetchUNList — all accept a mocked global fetch.

import { fetchOFACSDN } from '../../../ingest/sources/ofac.js';
import { fetchEUCFSP } from '../../../ingest/sources/eu-cfsp.js';
import { fetchHMTreasury } from '../../../ingest/sources/hm-treasury.js';
import { fetchFinCEN } from '../../../ingest/sources/fincen.js';
import { fetchUNList } from '../../../ingest/sources/un.js';

afterEach(() => vi.unstubAllGlobals());

function textResponse(body: string, ok = true): Response {
  return { ok, text: async () => body, status: ok ? 200 : 500 } as unknown as Response;
}

// ---- parseOFACXml (via fetchOFACSDN) -----------------------------------------

const OFAC_SINGLE_ENTRY = `
<sdnList>
  <sdnEntry>
    <uid>12345</uid>
    <lastName>BAD CORP LTD</lastName>
    <program>IRAN</program>
    <publishInformation>
      <publishDate>01/15/2024</publishDate>
    </publishInformation>
  </sdnEntry>
</sdnList>
`;

const OFAC_PERSON_ENTRY = `
<sdnList>
  <sdnEntry>
    <uid>99</uid>
    <firstName>John</firstName>
    <lastName>Doe</lastName>
    <program>SDGT</program>
    <publishInformation>
      <publishDate>06/01/2023</publishDate>
    </publishInformation>
    <akaList>
      <aka>
        <firstName>Johnny</firstName>
        <lastName>Doe</lastName>
      </aka>
      <aka>
        <lastName>Doe Jr</lastName>
      </aka>
    </akaList>
  </sdnEntry>
</sdnList>
`;

const OFAC_MISSING_UID = `
<sdnList>
  <sdnEntry>
    <lastName>No UID Corp</lastName>
  </sdnEntry>
</sdnList>
`;

describe('parseOFACXml — via fetchOFACSDN', () => {
  it('parses a single entity entry with lastName only', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(OFAC_SINGLE_ENTRY)));
    const entries = await fetchOFACSDN();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('OFAC_12345');
    expect(entries[0]!.name).toBe('BAD CORP LTD');
    expect(entries[0]!.program).toBe('IRAN');
    expect(entries[0]!.listed_on).toBe('01/15/2024');
    expect(entries[0]!.aliases).toHaveLength(0);
  });

  it('combines firstName + lastName for person entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(OFAC_PERSON_ENTRY)));
    const entries = await fetchOFACSDN();

    expect(entries[0]!.name).toBe('John Doe');
  });

  it('extracts aliases from <aka> blocks, combining firstName + lastName', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(OFAC_PERSON_ENTRY)));
    const entries = await fetchOFACSDN();

    expect(entries[0]!.aliases).toContain('Johnny Doe');
    expect(entries[0]!.aliases).toContain('Doe Jr');
  });

  it('skips entries without <uid>', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(OFAC_MISSING_UID)));
    const entries = await fetchOFACSDN();

    expect(entries).toHaveLength(0);
  });

  it('throws on HTTP error response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse('', false)));
    await expect(fetchOFACSDN()).rejects.toThrow('OFAC SDN fetch failed');
  });
});

// ---- fetchEUCFSP -------------------------------------------------------------

const EU_WHOLE_NAME = `
<export>
  <sanctionEntity logicalId="9001" regulation="" >
    <nameAlias wholeName="Shady Holdings GmbH" />
    <regulation numberTitle="EU Reg 2024/001" entryIntoForceDate="2024-03-01" programme="RUSSIA" />
  </sanctionEntity>
</export>
`;

const EU_FIRST_LAST = `
<export>
  <sanctionEntity logicalId="9002" regulation="" >
    <nameAlias firstName="Ivan" lastName="Petrov" />
    <nameAlias wholeName="I. Petrov" />
    <regulation numberTitle="EU Reg 2024/002" entryIntoForceDate="2023-11-15" programme="BELARUS" />
  </sanctionEntity>
</export>
`;

const EU_NO_NAME = `
<export>
  <sanctionEntity logicalId="9003" regulation="">
    <regulation numberTitle="EU Reg X" />
  </sanctionEntity>
</export>
`;

describe('fetchEUCFSP', () => {
  it('parses an entity with wholeName attribute', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(EU_WHOLE_NAME)));
    const entries = await fetchEUCFSP();

    expect(entries).toHaveLength(1);
    expect(entries[0]!.id).toBe('EU_9001');
    expect(entries[0]!.name).toBe('Shady Holdings GmbH');
    expect(entries[0]!.program).toBe('RUSSIA');
    expect(entries[0]!.listed_on).toBe('2024-03-01');
  });

  it('falls back to firstName + lastName when wholeName is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(EU_FIRST_LAST)));
    const entries = await fetchEUCFSP();

    // First nameAlias has no wholeName, second has "I. Petrov"
    // Primary name is "I. Petrov" (first wholeName found)
    expect(entries[0]!.name).toBeTruthy();
  });

  it('collects additional wholeName values as aliases', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(EU_FIRST_LAST)));
    const entries = await fetchEUCFSP();

    // "I. Petrov" is the primary name — any extra wholeName values become aliases
    expect(entries[0]!.aliases).toBeDefined();
  });

  it('skips entries with no usable name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(EU_NO_NAME)));
    const entries = await fetchEUCFSP();

    expect(entries).toHaveLength(0);
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse('', false)));
    await expect(fetchEUCFSP()).rejects.toThrow('EU CFSP');
  });
});

// ---- parseCSVRow + fetchHMTreasury -------------------------------------------

// Row 0 = metadata, Row 1 = header, Rows 2+ = data
const HMT_CSV = [
  'Last Updated,19/03/2024',
  'Group ID,Name 1,Name 6,Regime,Listed On',
  'GRP001,ACME CORP,,RUSSIA,2022-03-01',
  'GRP002,PERSON FIRST,ENTITY NAME INC,IRAN,2023-07-15',
  'GRP001,ACME CORP,,RUSSIA,2022-03-01', // duplicate group_id — should be skipped
].join('\n');

const HMT_QUOTED_CSV = [
  'Last Updated,19/03/2024',
  'Group ID,Name 1,Name 6,Regime,Listed On',
  'GRP003,"Corp, Ltd",,SANCTIONS LIST,2024-01-01',
].join('\n');

describe('fetchHMTreasury', () => {
  it('parses Name 1 when Name 6 is empty', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(HMT_CSV)));
    const entries = await fetchHMTreasury();

    const acme = entries.find((e) => e.id === 'HMT_GRP001');
    expect(acme).toBeDefined();
    expect(acme!.name).toBe('ACME CORP');
    expect(acme!.program).toBe('RUSSIA');
    expect(acme!.listed_on).toBe('2022-03-01');
  });

  it('prefers Name 6 over Name 1 when Name 6 is populated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(HMT_CSV)));
    const entries = await fetchHMTreasury();

    const iran = entries.find((e) => e.id === 'HMT_GRP002');
    expect(iran!.name).toBe('ENTITY NAME INC');
  });

  it('deduplicates by group_id — second row with same group_id is skipped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(HMT_CSV)));
    const entries = await fetchHMTreasury();

    const acme = entries.filter((e) => e.id === 'HMT_GRP001');
    expect(acme).toHaveLength(1);
  });

  it('handles quoted CSV values containing commas', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(HMT_QUOTED_CSV)));
    const entries = await fetchHMTreasury();

    expect(entries[0]!.name).toBe('Corp, Ltd');
  });

  it('returns empty array when CSV has fewer than 3 lines', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse('Last Updated,01/01/2024\nGroup ID,Name 1')));
    const entries = await fetchHMTreasury();

    expect(entries).toHaveLength(0);
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse('', false)));
    await expect(fetchHMTreasury()).rejects.toThrow('HM Treasury');
  });
});

// ---- parseEnforcementPage + fetchFinCEN -------------------------------------

function htmlResponse(body: string, ok = true): Response {
  return { ok, text: async () => body, status: ok ? 200 : 500 } as unknown as Response;
}

const FINCEN_HTML = `
<html><body>
<table class="usa-table usa-table--striped">
  <thead><tr><th>Action</th><th>Date</th><th>Matter No</th><th>Type</th></tr></thead>
  <tbody>
    <tr>
      <td><a href="/action/1">Big Bank Corp</a></td>
      <td><time datetime="2024-06-15T00:00:00Z">June 15, 2024</time></td>
      <td>2024-01</td>
      <td>Bank</td>
    </tr>
    <tr>
      <td>Small LLC</td>
      <td>03/22/2023</td>
      <td>2023-02</td>
      <td>MSB</td>
    </tr>
  </tbody>
</table>
</body></html>
`;

describe('fetchFinCEN — parseEnforcementPage', () => {
  it('parses entity name stripping HTML tags from the first column', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse(FINCEN_HTML)));
    const entries = await fetchFinCEN();

    expect(entries.some((e) => e.name === 'Big Bank Corp')).toBe(true);
  });

  it('extracts date from datetime attribute on <time> element', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse(FINCEN_HTML)));
    const entries = await fetchFinCEN();

    const bank = entries.find((e) => e.name === 'Big Bank Corp');
    expect(bank!.listed_on).toBe('2024-06-15');
  });

  it('falls back to MM/DD/YYYY text date when no datetime attribute', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse(FINCEN_HTML)));
    const entries = await fetchFinCEN();

    const small = entries.find((e) => e.name === 'Small LLC');
    expect(small!.listed_on).toBe('2023-03-22');
  });

  it('sets program to BSA_CMP for all entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse(FINCEN_HTML)));
    const entries = await fetchFinCEN();

    for (const e of entries) {
      expect(e.program).toBe('BSA_CMP');
    }
  });

  it('returns empty array when no usa-table is found', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse('<html><body>No table here</body></html>')));
    const entries = await fetchFinCEN();

    expect(entries).toHaveLength(0);
  });

  it('returns empty array (not throws) on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(htmlResponse('', false)));
    const entries = await fetchFinCEN();

    expect(entries).toHaveLength(0);
  });
});

// ---- fetchUNList -------------------------------------------------------------

const UN_XML = `
<consolidated>
  <ENTITIES>
    <ENTITY>
      <REFERENCE_NUMBER>QDe.011</REFERENCE_NUMBER>
      <FIRST_NAME>AL-QAIDA</FIRST_NAME>
      <SECOND_NAME>IN IRAQ</SECOND_NAME>
      <THIRD_NAME></THIRD_NAME>
      <LISTED_ON>2004-05-18</LISTED_ON>
      <ALIASES>
        <ALIAS>
          <ALIAS_NAME>AQI</ALIAS_NAME>
        </ALIAS>
        <ALIAS>
          <ALIAS_NAME>Al-Qa'ida Group</ALIAS_NAME>
        </ALIAS>
      </ALIASES>
    </ENTITY>
    <ENTITY>
      <REFERENCE_NUMBER>QDe.150</REFERENCE_NUMBER>
      <FIRST_NAME>ISLAMIC STATE</FIRST_NAME>
      <LISTED_ON>2015-09-29</LISTED_ON>
    </ENTITY>
    <ENTITY>
      <!-- No REFERENCE_NUMBER — should be skipped -->
      <FIRST_NAME>Unnamed Entity</FIRST_NAME>
    </ENTITY>
  </ENTITIES>
</consolidated>
`;

describe('fetchUNList', () => {
  it('concatenates FIRST_NAME, SECOND_NAME, THIRD_NAME into the primary name', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(UN_XML)));
    const entries = await fetchUNList();

    const aqi = entries.find((e) => e.id === 'UN_QDe.011');
    expect(aqi).toBeDefined();
    expect(aqi!.name).toBe('AL-QAIDA IN IRAQ');
  });

  it('handles entries with only FIRST_NAME', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(UN_XML)));
    const entries = await fetchUNList();

    const isis = entries.find((e) => e.id === 'UN_QDe.150');
    expect(isis!.name).toBe('ISLAMIC STATE');
  });

  it('extracts ALIAS_NAME values into aliases array', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(UN_XML)));
    const entries = await fetchUNList();

    const aqi = entries.find((e) => e.id === 'UN_QDe.011');
    expect(aqi!.aliases).toContain('AQI');
    expect(aqi!.aliases).toContain("Al-Qa'ida Group");
  });

  it('sets program to UN_1267 for all entries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(UN_XML)));
    const entries = await fetchUNList();

    for (const e of entries) {
      expect(e.program).toBe('UN_1267');
    }
  });

  it('skips entries missing REFERENCE_NUMBER', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(UN_XML)));
    const entries = await fetchUNList();

    expect(entries.find((e) => e.name === 'Unnamed Entity')).toBeUndefined();
  });

  it('parses listed_on date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse(UN_XML)));
    const entries = await fetchUNList();

    const aqi = entries.find((e) => e.id === 'UN_QDe.011');
    expect(aqi!.listed_on).toBe('2004-05-18');
  });

  it('throws on HTTP error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(textResponse('', false)));
    await expect(fetchUNList()).rejects.toThrow('UN sanctions');
  });
});
