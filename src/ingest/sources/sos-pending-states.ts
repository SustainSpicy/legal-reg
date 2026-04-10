// Implements entity lookups for the 32 SOS_PENDING states.
// Grouped by portal technology: JSON REST, ASPX ViewState, HTML form GET.
// Every function returns null on failure — EDGAR fallback activates automatically.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

// ---- Shared helpers ---------------------------------------------------------

function mapStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s.includes('active') || s.includes('good standing') || s.includes('current')) return 'active';
  if (
    s.includes('dissolv') || s.includes('cancel') || s.includes('terminat') ||
    s.includes('revok') || s.includes('forfeit') || s.includes('void') || s.includes('expired')
  ) return 'dissolved';
  if (s.includes('suspend') || s.includes('delinq') || s.includes('inactive')) return 'suspended';
  return 'unknown';
}

function buildEntity(
  jurisdiction: string,
  source: string,
  sourceUrl: string,
  name: string,
  rawStatus: string,
  incorporatedAt: string | null = null,
  agentName: string | null = null,
  agentAddr: string | null = null,
  confidence = 0.85,
): EntityLookupOutputType {
  return {
    entity_id: generateEntityId(jurisdiction, name),
    canonical_name: name,
    jurisdiction,
    status: mapStatus(rawStatus),
    incorporated_at: incorporatedAt,
    registered_agent: agentName ? { name: agentName, address: agentAddr ?? '' } : null,
    officers: [],
    source,
    source_url: sourceUrl,
    freshness_secs: 0,
    confidence,
    data_freshness: 'fresh',
  };
}

// Two-step ASPX helper: GET ViewState then POST search form.
async function aspxSearch(
  url: string,
  searchField: string,
  searchValue: string,
  submitField: string,
  extraFields: Record<string, string> = {},
): Promise<string | null> {
  const initRes = await fetch(url, {
    headers: { 'User-Agent': 'CorpSignal-MCP/1.0' },
  }).catch(() => null);
  if (!initRes?.ok) return null;

  const initHtml = await initRes.text();
  const vs  = /id="__VIEWSTATE"\s+value="([^"]*)"/.exec(initHtml)?.[1] ?? '';
  const ev  = /id="__EVENTVALIDATION"\s+value="([^"]*)"/.exec(initHtml)?.[1] ?? '';
  const vsg = /id="__VIEWSTATEGENERATOR"\s+value="([^"]*)"/.exec(initHtml)?.[1] ?? '';

  const body = new URLSearchParams({
    __VIEWSTATE: vs,
    __EVENTVALIDATION: ev,
    __VIEWSTATEGENERATOR: vsg,
    [searchField]: searchValue,
    [submitField]: 'Search',
    ...extraFields,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CorpSignal-MCP/1.0',
      Referer: url,
      Cookie: initRes.headers.get('set-cookie') ?? '',
    },
    body: body.toString(),
  }).catch(() => null);

  if (!res?.ok) return null;
  return res.text();
}

// Extract rows from the first matching HTML table, skipping the header row.
function extractTableRows(html: string, tableRe: RegExp): string[][] {
  const tableMatch = tableRe.exec(html);
  if (!tableMatch) return [];

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[][] = [];
  let m: RegExpExecArray | null;
  let isHeader = true;
  while ((m = rowRe.exec(tableMatch[0]!)) !== null) {
    if (isHeader) { isHeader = false; continue; }
    const cells = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((c) => c[1]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

function bestRow(rows: string[][], query: string): string[] {
  const norm = normaliseName(query);
  return rows.find((r) => normaliseName(r[0] ?? '') === norm) ?? rows[0]!;
}

// ---- JSON REST states -------------------------------------------------------

// Nevada — ESOS public entity search
export async function lookupNevadaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch('https://esos.nv.gov/EntitySearch/OnlineEntitySearch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CorpSignal-MCP/1.0', Accept: 'application/json' },
    body: new URLSearchParams({ Search_In_Name: name, Search_In_SearchType: 'A', Search_In_FilterType: '' }).toString(),
  }).catch(() => null);
  if (!res?.ok) return null;

  interface NVResult { entityName?: string; status?: string; formationDate?: string; }
  const data = await res.json().catch(() => null) as { searchResultList?: NVResult[] } | null;
  const results = data?.searchResultList ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.entityName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-NV', 'nevada_sos', 'https://esos.nv.gov/EntitySearch/OnlineEntitySearch',
    best.entityName ?? name, best.status ?? '', best.formationDate ?? null);
}

// Ohio — businesssearch.ohiosos.gov JSON API
export async function lookupOhioEntity(name: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch('https://businesssearch.ohiosos.gov/businesssearch/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0', Accept: 'application/json' },
    body: JSON.stringify({ searchValue: name, searchType: 'N', resultPage: 1, numberOfResults: 5 }),
  }).catch(() => null);
  if (!res?.ok) return null;

  interface OHResult { name?: string; status?: string; formDate?: string; agentName?: string; agentAddress?: string; }
  const data = await res.json().catch(() => null) as { data?: OHResult[] } | null;
  const results = data?.data ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.name?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-OH', 'ohio_sos', 'https://businesssearch.ohiosos.gov',
    best.name ?? name, best.status ?? '', best.formDate ?? null, best.agentName ?? null, best.agentAddress ?? null);
}

// Maryland — SDAT Express JSON
export async function lookupMarylandEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://egov.maryland.gov/BusinessExpress/EntitySearch/Search?' +
    new URLSearchParams({ searchType: 'N', searchName: name, searchStatus: '', sortField: 'BUSINESSNAME' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface MDResult { businessName?: string; status?: string; departmentId?: string; dateOfFormation?: string; residentAgentName?: string; }
  const data = await res.json().catch(() => null) as { searchResults?: MDResult[] } | null;
  const results = data?.searchResults ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.businessName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  const sourceUrl = best.departmentId
    ? `https://egov.maryland.gov/BusinessExpress/EntitySearch/BusinessInformation/${best.departmentId}`
    : 'https://egov.maryland.gov/BusinessExpress/EntitySearch';
  return buildEntity('US-MD', 'maryland_sos', sourceUrl,
    best.businessName ?? name, best.status ?? '', best.dateOfFormation ?? null, best.residentAgentName ?? null);
}

// New Jersey — DOR Business Name Search JSON
export async function lookupNewJerseyEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://www.njportal.com/DOR/BusinessNameSearch/api/BusinessName/GetBusinesses?' +
    new URLSearchParams({ businessName: name, nameType: 'B', pageSize: '5', page: '1' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface NJResult { businessName?: string; status?: string; entityId?: string; }
  const data = await res.json().catch(() => null) as { data?: NJResult[] } | null;
  const results = data?.data ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.businessName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  const sourceUrl = best.entityId
    ? `https://www.njportal.com/DOR/BusinessNameSearch/Search?businessId=${best.entityId}`
    : 'https://www.njportal.com/DOR/BusinessNameSearch';
  return buildEntity('US-NJ', 'new_jersey_sos', sourceUrl, best.businessName ?? name, best.status ?? '');
}

// South Carolina — businessfilings.sc.gov JSON
export async function lookupSouthCarolinaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch('https://businessfilings.sc.gov/BusinessFiling/Entity/Search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' },
    body: JSON.stringify({ fillingName: name, fillingType: '', status: '', pageNumber: 1, pageSize: 5 }),
  }).catch(() => null);
  if (!res?.ok) return null;

  interface SCResult { entityName?: string; status?: string; filingNumber?: string; }
  const data = await res.json().catch(() => null) as { entityList?: SCResult[] } | null;
  const results = data?.entityList ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.entityName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  const sourceUrl = best.filingNumber
    ? `https://businessfilings.sc.gov/BusinessFiling/Entity/Details/${best.filingNumber}`
    : 'https://businessfilings.sc.gov';
  return buildEntity('US-SC', 'south_carolina_sos', sourceUrl, best.entityName ?? name, best.status ?? '');
}

// Virginia — SCC Electronic Search JSON
export async function lookupVirginiaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://cis.scc.virginia.gov/EntitySearch/GetSearchResults?' +
    new URLSearchParams({ searchTerm: name, searchType: '0', pageNumber: '1', pageSize: '5' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface VAResult { entityName?: string; status?: string; entityId?: string; dateOfFormation?: string; registeredAgent?: string; }
  const data = await res.json().catch(() => null) as { results?: VAResult[] } | null;
  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.entityName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  const sourceUrl = best.entityId
    ? `https://cis.scc.virginia.gov/EntitySearch/BusinessInformation?businessId=${best.entityId}`
    : 'https://cis.scc.virginia.gov/EntitySearch/';
  return buildEntity('US-VA', 'virginia_scc', sourceUrl,
    best.entityName ?? name, best.status ?? '', best.dateOfFormation ?? null, best.registeredAgent ?? null);
}

// Connecticut — CT Business Search JSON
export async function lookupConnecticutEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://service.ct.gov/business/s/onlinebusinesssearch?' +
    new URLSearchParams({ name, type: '', status: '', page: '1' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface CTResult { businessName?: string; status?: string; dateOfOrganization?: string; }
  const data = await res.json().catch(() => null) as { businesses?: CTResult[] } | null;
  const results = data?.businesses ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.businessName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-CT', 'connecticut_sos', 'https://service.ct.gov/business/s/onlinebusinesssearch',
    best.businessName ?? name, best.status ?? '', best.dateOfOrganization ?? null);
}

// Arizona — ACC Electronic Business Search JSON
export async function lookupArizonaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://ecorp.azcc.gov/BusinessSearch/BusinessSearch?' +
    new URLSearchParams({ entityName: name, entityType: '', entityStatus: '', page: '1', rows: '5' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface AZResult { EntityName?: string; EntityStatus?: string; EntityId?: string; FormationDate?: string; AgentName?: string; }
  const data = await res.json().catch(() => null) as { BusinessSearchResults?: AZResult[] } | null;
  const results = data?.BusinessSearchResults ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.EntityName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  const sourceUrl = best.EntityId
    ? `https://ecorp.azcc.gov/BusinessSearch/BusinessInformation?businessId=${best.EntityId}`
    : 'https://ecorp.azcc.gov/BusinessSearch';
  return buildEntity('US-AZ', 'arizona_sos', sourceUrl,
    best.EntityName ?? name, best.EntityStatus ?? '', best.FormationDate ?? null, best.AgentName ?? null);
}

// Indiana — INBiz public search JSON
export async function lookupIndianaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://inbiz.in.gov/BOS/api/entities?' +
    new URLSearchParams({ name, pageSize: '5', pageNumber: '1' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface INResult { entityName?: string; entityStatus?: string; formationDate?: string; }
  const data = await res.json().catch(() => null) as { data?: INResult[] } | null;
  const results = data?.data ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.entityName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-IN', 'indiana_sos', 'https://inbiz.in.gov',
    best.entityName ?? name, best.entityStatus ?? '', best.formationDate ?? null);
}

// Wisconsin — WI DFI business search JSON
export async function lookupWisconsinEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://www.wdfi.org/apps/CorpSearch/api/search?' +
    new URLSearchParams({ q: name, type: 'Simple', status: '', rows: '5', start: '0' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface WIResult { name?: string; status?: string; entityId?: string; dateFormed?: string; registeredAgent?: string; }
  const data = await res.json().catch(() => null) as { results?: WIResult[] } | null;
  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.name?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  const sourceUrl = best.entityId
    ? `https://www.wdfi.org/apps/CorpSearch/Details.aspx?entityId=${best.entityId}`
    : 'https://www.wdfi.org/apps/CorpSearch/';
  return buildEntity('US-WI', 'wisconsin_dfi', sourceUrl,
    best.name ?? name, best.status ?? '', best.dateFormed ?? null, best.registeredAgent ?? null);
}

// New Mexico — NM SOS business filing JSON
export async function lookupNewMexicoEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://portal.sos.state.nm.us/BFS/online/CorporationBusinessSearch/SearchByCorporationName?' +
    new URLSearchParams({ CorporationName: name, SearchType: 'StartWith' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface NMResult { CorporationName?: string; Status?: string; FormationDate?: string; }
  const data = await res.json().catch(() => null) as { ResultList?: NMResult[] } | null;
  const results = data?.ResultList ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.CorporationName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-NM', 'new_mexico_sos', 'https://portal.sos.state.nm.us/BFS/online/',
    best.CorporationName ?? name, best.Status ?? '', best.FormationDate ?? null);
}

// New Hampshire — NH SOS QuickStart JSON
export async function lookupNewHampshireEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://quickstart.sos.nh.gov/online/BusinessInquire/BusinessSearch?' +
    new URLSearchParams({ businessName: name, searchType: 'B' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface NHResult { businessName?: string; status?: string; effectiveDate?: string; }
  const data = await res.json().catch(() => null) as { results?: NHResult[] } | null;
  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.businessName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-NH', 'new_hampshire_sos', 'https://quickstart.sos.nh.gov/',
    best.businessName ?? name, best.status ?? '', best.effectiveDate ?? null);
}

// Idaho — Idaho SOS business search JSON
export async function lookupIdahoEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://sosbiz.idaho.gov/api/business/search?' +
    new URLSearchParams({ name, type: '', status: '', page: '1', pageSize: '5' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface IDResult { businessName?: string; status?: string; formationDate?: string; }
  const data = await res.json().catch(() => null) as { results?: IDResult[] } | null;
  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.businessName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-ID', 'idaho_sos', 'https://sosbiz.idaho.gov/search/business',
    best.businessName ?? name, best.status ?? '', best.formationDate ?? null);
}

// Utah — Utah SOS business entity search JSON
export async function lookupUtahEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://secure.utah.gov/bes/index.html?' +
    new URLSearchParams({ q: name, searchType: 'name' }).toString();
  const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  interface UTResult { name?: string; status?: string; registrationDate?: string; }
  const data = await res.json().catch(() => null) as { results?: UTResult[] } | null;
  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.name?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-UT', 'utah_sos', 'https://secure.utah.gov/bes/',
    best.name ?? name, best.status ?? '', best.registrationDate ?? null);
}

// ---- HTML form GET states ---------------------------------------------------

// Oregon — Oregon SOS BR public name search
export async function lookupOregonEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://egov.sos.state.or.us/br/pkg_web_name_srch_inq.do_name_srch?' +
    new URLSearchParams({ p_srch: 'BEGINS', p_entity_name: name, p_bus_org_id: '' }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*class="[^"]*results[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-OR', 'oregon_sos', 'https://egov.sos.state.or.us/br/',
    row[0] ?? name, row[2] ?? 'unknown', row[4] ?? null);
}

// Minnesota — MBLS portal HTML search
export async function lookupMinnesotaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://mblsportal.sos.state.mn.us/Business/Search?' +
    new URLSearchParams({ SearchType: 'BusinessName', SearchValue: name, IncludeDBA: 'true' }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-MN', 'minnesota_sos', 'https://mblsportal.sos.state.mn.us/Business/Search',
    row[0] ?? name, row[1] ?? 'unknown');
}

// Kentucky — KY SOS full-text search HTML
export async function lookupKentuckyEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = `https://web.sos.ky.gov/ftsearch/?SEARCH_TYPE=O&ORG_NAME=${encodeURIComponent(name)}&ORG_NUMBER=&RECORD_TYPE=&status=A`;
  const res = await fetch(url, { headers: { 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-KY', 'kentucky_sos', 'https://web.sos.ky.gov/ftsearch/',
    row[0] ?? name, row[2] ?? 'unknown');
}

// Louisiana — LA SOS commercial recordings search HTML
export async function lookupLouisianaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://coraweb.sos.la.gov/commercialrecordingsearch/results?' +
    new URLSearchParams({ type: 'ENT', search: name, SearchTypeID: '1' }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*class="[^"]*searchResults[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-LA', 'louisiana_sos', 'https://coraweb.sos.la.gov/commercialrecordingsearch/',
    row[0] ?? name, row[2] ?? 'unknown');
}

// Kansas — KS SOS BESS flow POST
export async function lookupKansasEntity(name: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch('https://www.kansas.gov/bess/flow/main?execution=e1s2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CorpSignal-MCP/1.0' },
    body: new URLSearchParams({ 'searchCriteria.businessName': name, '_eventId_search': 'Search' }).toString(),
  }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*id="[^"]*resultsTable[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-KS', 'kansas_sos', 'https://www.kansas.gov/bess/',
    row[0] ?? name, row[2] ?? 'unknown');
}

// Nebraska — NE SOS corporate search CGI
export async function lookupNebraskaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://www.nebraska.gov/sos/corp/corpsearch.cgi?' +
    new URLSearchParams({ action: 'search', 'corp:name': name, typelist: '', statuslist: 'all' }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-NE', 'nebraska_sos', 'https://www.nebraska.gov/sos/corp/corpsearch.cgi',
    row[0] ?? name, row[2] ?? 'unknown');
}

// Maine — ME SOS ICRS search HTML
export async function lookupMaineEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://icrs.informe.org/nei-sos-icrs/ICRS?' +
    new URLSearchParams({ nametype: 'CN', namefind: name, maine: 'true', foreign: 'true' }).toString();
  const res = await fetch(url, { headers: { 'User-Agent': 'CorpSignal-MCP/1.0' } }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-ME', 'maine_sos', 'https://icrs.informe.org/nei-sos-icrs/ICRS',
    row[0] ?? name, row[2] ?? 'unknown');
}

// Iowa — IA SOS session-based HTML form
export async function lookupIowaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch('https://sos.iowa.gov/search/business/search.aspx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CorpSignal-MCP/1.0' },
    body: new URLSearchParams({ SearchName: name, SearchType: 'BEGINS', btnSearch: 'Search' }).toString(),
  }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*class="[^"]*searchTable[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-IA', 'iowa_sos', 'https://sos.iowa.gov/search/business',
    row[0] ?? name, row[2] ?? 'unknown');
}

// Rhode Island — RI SOS CorpSearch form POST
export async function lookupRhodeIslandEntity(name: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch('https://business.sos.ri.gov/corprealtimeweb/CorpSearch.aspx', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CorpSignal-MCP/1.0' },
    body: new URLSearchParams({ txtCorpName: name, btnSearch: 'Search' }).toString(),
  }).catch(() => null);
  if (!res?.ok) return null;

  const html = await res.text();
  const rows = extractTableRows(html, /<table[^>]*id="[^"]*SearchResults[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-RI', 'rhode_island_sos', 'https://business.sos.ri.gov/corprealtimeweb/',
    row[0] ?? name, row[1] ?? 'unknown');
}

// North Carolina — SOSNC business registration JSON
export async function lookupNorthCarolinaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const res = await fetch('https://www.sosnc.gov/online_services/search/by_title/_Business_Registration', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'CorpSignal-MCP/1.0', Accept: 'application/json' },
    body: new URLSearchParams({ searchStr: name, searchType: 'BEGINNING_OF', category: '' }).toString(),
  }).catch(() => null);
  if (!res?.ok) return null;

  interface NCResult { EntityName?: string; Status?: string; FormationDate?: string; }
  const data = await res.json().catch(() => null) as { SearchResultList?: NCResult[] } | null;
  const results = data?.SearchResultList ?? [];
  if (results.length === 0) return null;

  const best = results.find((r) => r.EntityName?.toLowerCase() === name.toLowerCase()) ?? results[0]!;
  return buildEntity('US-NC', 'north_carolina_sos',
    'https://www.sosnc.gov/online_services/search/by_title/_Business_Registration',
    best.EntityName ?? name, best.Status ?? '', best.FormationDate ?? null);
}

// ---- ASPX ViewState states --------------------------------------------------

// Massachusetts — MA SOS CorpSearch ASPX
export async function lookupMassachusettsEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://corp.sec.state.ma.us/CorpWeb/CorpSearch/CorpSearch.aspx';
  const html = await aspxSearch(url,
    'ctl00$MainContent$txtEntityName', name,
    'ctl00$MainContent$btnSearch',
    { 'ctl00$MainContent$ddSearchType': 'B' });
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*searchResults[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-MA', 'massachusetts_sos', url, row[0] ?? name, row[2] ?? 'unknown', row[3] ?? null);
}

// Wyoming — WyoBiz ASPX
export async function lookupWyomingEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://wyobiz.wyo.gov/Business/FilingSearch.aspx';
  const html = await aspxSearch(url, 'ctl00$cphContent$txtName', name, 'ctl00$cphContent$btnSearch');
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*grdSearchResults[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-WY', 'wyoming_sos', url, row[0] ?? name, row[2] ?? 'unknown', row[3] ?? null);
}

// Pennsylvania — PA DOS corpsearch ASPX
export async function lookupPennsylvaniaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://www.corporations.pa.gov/search/corpsearch';
  const html = await aspxSearch(url,
    'ctl00$MainContent$txtEntityName', name,
    'ctl00$MainContent$btnSearch');
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*SearchResultGrid[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-PA', 'pennsylvania_dos', url, row[0] ?? name, row[2] ?? 'unknown', row[3] ?? null);
}

// Tennessee — TN BEAR ASPX
export async function lookupTennesseeEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://tnbear.tn.gov/ECommerce/FilingSearch.aspx';
  const html = await aspxSearch(url,
    'ctl00$ContentPlaceHolder1$SearchName', name,
    'ctl00$ContentPlaceHolder1$SearchButton');
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*GridViewResults[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-TN', 'tennessee_sos', url, row[0] ?? name, row[2] ?? 'unknown', row[3] ?? null);
}

// Missouri — MO SOS BESearch ASPX
export async function lookupMissouriEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://bsd.sos.mo.gov/BusinessEntity/BESearch.aspx';
  const html = await aspxSearch(url,
    'ctl00$MainContent$SearchNameTxt', name,
    'ctl00$MainContent$SearchButton',
    { 'ctl00$MainContent$SearchTypeDropDown': 'Contains' });
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*SearchResultsGrid[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-MO', 'missouri_sos', url, row[0] ?? name, row[2] ?? 'unknown');
}

// Oklahoma — OK SOS corpsearch ASPX
export async function lookupOklahomaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://www.sos.ok.gov/corp/corpsearch.aspx';
  const html = await aspxSearch(url,
    'ctl00$Content$SearchName', name,
    'ctl00$Content$SearchButton');
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*GridView[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-OK', 'oklahoma_sos', url, row[0] ?? name, row[1] ?? 'unknown');
}

// Vermont — VT BizFilings ASPX
export async function lookupVermontEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://bizfilings.vermont.gov/online/BusinessInquire/BusinessSearch';
  const html = await aspxSearch(url, 'txtBusinessName', name, 'btnSearch');
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*SearchResults[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-VT', 'vermont_sos', url, row[0] ?? name, row[1] ?? 'unknown');
}

// South Dakota — SD SOS enterprise ASPX
export async function lookupSouthDakotaEntity(name: string): Promise<EntityLookupOutputType | null> {
  const url = 'https://sosenterprise.sd.gov/BusinessServices/Business/FilingSearch.aspx';
  const html = await aspxSearch(url,
    'ctl00$MainContent$SearchName', name,
    'ctl00$MainContent$SearchButton');
  if (!html) return null;

  const rows = extractTableRows(html, /<table[^>]*id="[^"]*GridViewResults[^"]*"[^>]*>[\s\S]*?<\/table>/i);
  if (rows.length === 0) return null;

  const row = bestRow(rows, name);
  return buildEntity('US-SD', 'south_dakota_sos', url, row[0] ?? name, row[2] ?? 'unknown', row[3] ?? null);
}

// ---- Main dispatch ----------------------------------------------------------

const STATE_LOOKUP: Readonly<Record<string, (name: string) => Promise<EntityLookupOutputType | null>>> = {
  'US-NV': lookupNevadaEntity,
  'US-OR': lookupOregonEntity,
  'US-AZ': lookupArizonaEntity,
  'US-MN': lookupMinnesotaEntity,
  'US-OH': lookupOhioEntity,
  'US-PA': lookupPennsylvaniaEntity,
  'US-NJ': lookupNewJerseyEntity,
  'US-VA': lookupVirginiaEntity,
  'US-NC': lookupNorthCarolinaEntity,
  'US-TN': lookupTennesseeEntity,
  'US-MO': lookupMissouriEntity,
  'US-SC': lookupSouthCarolinaEntity,
  'US-IN': lookupIndianaEntity,
  'US-WI': lookupWisconsinEntity,
  'US-MD': lookupMarylandEntity,
  'US-CT': lookupConnecticutEntity,
  'US-KY': lookupKentuckyEntity,
  'US-OK': lookupOklahomaEntity,
  'US-IA': lookupIowaEntity,
  'US-LA': lookupLouisianaEntity,
  'US-KS': lookupKansasEntity,
  'US-UT': lookupUtahEntity,
  'US-NM': lookupNewMexicoEntity,
  'US-NE': lookupNebraskaEntity,
  'US-ME': lookupMaineEntity,
  'US-RI': lookupRhodeIslandEntity,
  'US-NH': lookupNewHampshireEntity,
  'US-VT': lookupVermontEntity,
  'US-SD': lookupSouthDakotaEntity,
  'US-ID': lookupIdahoEntity,
  'US-MA': lookupMassachusettsEntity,
  'US-WY': lookupWyomingEntity,
};

export async function lookupPendingStateEntity(
  entityName: string,
  jurisdiction: string,
): Promise<EntityLookupOutputType | null> {
  const fn = STATE_LOOKUP[jurisdiction];
  if (!fn) return null;
  try {
    return await fn(entityName);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[sos-pending] ${jurisdiction} lookup failed: ${msg}`);
    return null;
  }
}
