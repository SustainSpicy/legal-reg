// Canada entity lookup and filings
//
// Entity sources (in priority order per jurisdiction):
//   CA        — Corporations Canada (federal, ISED) — free REST API, no key
//   CA-BC     — BC Corporate Registry public search — free, no key
//   CA-ON     — Ontario Business Registry public search — free, no key
//   CA-AB     — Alberta Corporate Registry — free, no key
//   CA-QC     — Registraire des entreprises (REQ) — free, no key
//
// Filings source:
//   SEDAR+    — Canadian Securities Administrators public API, no key
//   Falls back to empty list for private companies (SEDAR is public-cos only).

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';
import type { FilingItemType } from '../../schemas/filings.js';

// ---- Shared helpers --------------------------------------------------------

function mapStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s.includes('active') || s.includes('good standing') || s.includes('en règle')) return 'active';
  if (
    s.includes('dissolv') || s.includes('cancel') || s.includes('wind') ||
    s.includes('annul') || s.includes('radié') || s.includes('dissous')
  ) return 'dissolved';
  if (s.includes('suspend') || s.includes('inactiv') || s.includes('défaut')) return 'suspended';
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

// ---- Corporations Canada (federal) -----------------------------------------
// ISED REST API — returns JSON, no auth required.
// Docs: https://www.ic.gc.ca/app/scr/cc/CorporationsCanada/

interface CorpsCaResult {
  corpNm?: string;
  corpTypCd?: string;
  corpSt?: string;           // corporation status
  incorporationDt?: string;
  corporationNumber?: string;
  registeredOffice?: {
    streetAddress?: string;
    city?: string;
    province?: string;
    postalCode?: string;
  };
}

interface CorpsCaResponse {
  corpList?: CorpsCaResult[];
}

export async function lookupFederalCanadaEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const url =
    'https://ised-isde.canada.ca/cc/lgcy/fdrlCrptn/rqstCrptn?' +
    new URLSearchParams({
      V_TOKEN: 'null',
      searchField: 'CorpName',
      searchValue: entityName,
      action: 'search',
    }).toString();

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' },
  }).catch(() => null);
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null) as CorpsCaResponse | null;
  const results = data?.corpList ?? [];
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best =
    results.find((r) => normaliseName(r.corpNm ?? '') === normQuery) ?? results[0]!;

  const office = best.registeredOffice;
  const agentAddr = office
    ? [office.streetAddress, office.city, office.province, office.postalCode]
        .filter(Boolean)
        .join(', ')
    : null;

  const sourceUrl = best.corporationNumber
    ? `https://www.ic.gc.ca/app/scr/cc/CorporationsCanada/fdrlCrptn/dtls.html?corpId=${best.corporationNumber}`
    : 'https://www.ic.gc.ca/app/scr/cc/CorporationsCanada/fdrlCrptn/srch/dflt.html';

  return buildEntity(
    'CA',
    'corporations_canada',
    sourceUrl,
    best.corpNm ?? entityName,
    best.corpSt ?? '',
    best.incorporationDt ?? null,
    agentAddr ? 'Registered Office' : null,
    agentAddr,
  );
}

// ---- BC Corporate Registry -------------------------------------------------
// BCRegistry public name search — no key required
// https://www.bcregistry.gov.bc.ca/business/

interface BCSearchResult {
  name?: string;
  identifier?: string;
  status?: string;
  incorporationDate?: string;
  legalType?: string;
}

interface BCSearchResponse {
  businesses?: BCSearchResult[];
}

export async function lookupBCEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const url =
    'https://api.connect.gov.bc.ca/registry-search/api/v2/businesses/search?' +
    new URLSearchParams({ query: entityName, start: '0', rows: '5' }).toString();

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' },
  }).catch(() => null);
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null) as BCSearchResponse | null;
  const results = data?.businesses ?? [];
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best =
    results.find((r) => normaliseName(r.name ?? '') === normQuery) ?? results[0]!;

  const sourceUrl = best.identifier
    ? `https://www.bcregistry.gov.bc.ca/business/${best.identifier}`
    : 'https://www.bcregistry.gov.bc.ca/business/';

  return buildEntity(
    'CA-BC',
    'bc_corporate_registry',
    sourceUrl,
    best.name ?? entityName,
    best.status ?? '',
    best.incorporationDate ?? null,
  );
}

// ---- Ontario Business Registry --------------------------------------------
// OBR public search — no key required for name search
// https://www.ontario.ca/page/ontario-business-registry

interface ONSearchResult {
  entityName?: string;
  entityStatus?: string;
  entityIdentifier?: string;
  incorporationDate?: string;
  registeredOfficeAddress?: string;
}

interface ONSearchResponse {
  searchResults?: ONSearchResult[];
}

export async function lookupOntarioEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const url =
    'https://www.appmybizaccount.gov.on.ca/onbis/api/search/entities?' +
    new URLSearchParams({
      searchType: 'BEGINS',
      entityName,
      pageSize: '5',
      pageNumber: '1',
    }).toString();

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' },
  }).catch(() => null);
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null) as ONSearchResponse | null;
  const results = data?.searchResults ?? [];
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best =
    results.find((r) => normaliseName(r.entityName ?? '') === normQuery) ?? results[0]!;

  const sourceUrl = best.entityIdentifier
    ? `https://www.appmybizaccount.gov.on.ca/onbis/entity/${best.entityIdentifier}`
    : 'https://www.ontario.ca/page/ontario-business-registry';

  return buildEntity(
    'CA-ON',
    'ontario_business_registry',
    sourceUrl,
    best.entityName ?? entityName,
    best.entityStatus ?? '',
    best.incorporationDate ?? null,
    best.registeredOfficeAddress ? 'Registered Office' : null,
    best.registeredOfficeAddress ?? null,
  );
}

// ---- Alberta Corporate Registry -------------------------------------------
// CPRS public search — no key required
// https://www.alberta.ca/find-Alberta-company.aspx

interface ABSearchResult {
  legalName?: string;
  corpStatus?: string;
  incorporationDate?: string;
  registeredOffice?: string;
  corporationNumber?: string;
}

interface ABSearchResponse {
  results?: ABSearchResult[];
}

export async function lookupAlbertaEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const url =
    'https://efiling.registries.alberta.ca/publicqueries/api/v1/searchCorporation?' +
    new URLSearchParams({ corporationName: entityName, pageSize: '5', pageNo: '1' }).toString();

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' },
  }).catch(() => null);
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null) as ABSearchResponse | null;
  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best =
    results.find((r) => normaliseName(r.legalName ?? '') === normQuery) ?? results[0]!;

  const sourceUrl = best.corporationNumber
    ? `https://efiling.registries.alberta.ca/corporation/${best.corporationNumber}`
    : 'https://www.alberta.ca/find-Alberta-company.aspx';

  return buildEntity(
    'CA-AB',
    'alberta_corporate_registry',
    sourceUrl,
    best.legalName ?? entityName,
    best.corpStatus ?? '',
    best.incorporationDate ?? null,
    best.registeredOffice ? 'Registered Office' : null,
    best.registeredOffice ?? null,
  );
}

// ---- Registraire des entreprises (Quebec) ----------------------------------
// REQ public search — no key required
// https://www.registreentreprises.gouv.qc.ca/

interface QCSearchResult {
  nomEntreprise?: string;
  etatEntreprise?: string;
  dateImmatriculation?: string;
  numeroEntreprise?: string;
  adresseEtablissement?: string;
}

interface QCSearchResponse {
  listeEntreprises?: QCSearchResult[];
}

export async function lookupQuebecEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const url =
    'https://www.registreentreprises.gouv.qc.ca/RQAnonymeGR/GR/GR03/GR03A2_19A_PIU_RechSimple_PC/PageRecherche.aspx?' +
    new URLSearchParams({ critereNom: entityName, typeRecherche: 'D' }).toString();

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' },
  }).catch(() => null);
  if (!res?.ok) return null;

  const data = await res.json().catch(() => null) as QCSearchResponse | null;
  const results = data?.listeEntreprises ?? [];
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best =
    results.find((r) => normaliseName(r.nomEntreprise ?? '') === normQuery) ?? results[0]!;

  const sourceUrl = best.numeroEntreprise
    ? `https://www.registreentreprises.gouv.qc.ca/RQAnonymeGR/GR/GR03/GR03A4_19A_PIU_InfoEntrep_PC/PageInfoEntreprise.aspx?codeEntreprise=${best.numeroEntreprise}`
    : 'https://www.registreentreprises.gouv.qc.ca/';

  return buildEntity(
    'CA-QC',
    'req_quebec',
    sourceUrl,
    best.nomEntreprise ?? entityName,
    best.etatEntreprise ?? '',
    best.dateImmatriculation ?? null,
    best.adresseEtablissement ? 'Établissement principal' : null,
    best.adresseEtablissement ?? null,
  );
}

// ---- Main entity resolver for all CA jurisdictions -------------------------

export async function resolveCanadianEntity(
  entityName: string,
  jurisdiction: string,
): Promise<EntityLookupOutputType | null> {
  switch (jurisdiction) {
    case 'CA-BC': return lookupBCEntity(entityName);
    case 'CA-ON': return lookupOntarioEntity(entityName);
    case 'CA-AB': return lookupAlbertaEntity(entityName);
    case 'CA-QC': return lookupQuebecEntity(entityName);
    default:
      // For 'CA' (federal) or any other CA-* province, try Corporations Canada first,
      // then fall through to BC (most likely to have cross-listed entities)
      return (await lookupFederalCanadaEntity(entityName))
        ?? (await lookupBCEntity(entityName).catch(() => null));
  }
}

// ---- SEDAR+ filings --------------------------------------------------------
// Canadian Securities Administrators — public company filings
// https://www.sedarplus.ca/
// No auth required for public filings search.

interface SEDARSearchResult {
  id?: string;
  issuerName?: string;
  formType?: string;
  filedDate?: string;
  periodDate?: string;
  documentUrl?: string;
}

interface SEDARSearchResponse {
  filings?: SEDARSearchResult[];
  totalCount?: number;
}

export async function fetchSEDARFilings(
  entityName: string,
  limit = 10,
  filingTypes?: string[],
): Promise<{ filings: FilingItemType[]; totalAvailable: number }> {
  const url =
    'https://www.sedarplus.ca/csa-party/records/search.html?' +
    new URLSearchParams({
      search: entityName,
      pageNumber: '1',
      pageSize: String(Math.min(limit * 2, 40)),
      ...(filingTypes?.length ? { docType: filingTypes[0]! } : {}),
    }).toString();

  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'CorpSignal-MCP/1.0' },
  }).catch(() => null);

  if (!res?.ok) return { filings: [], totalAvailable: 0 };

  const data = await res.json().catch(() => null) as SEDARSearchResponse | null;
  const items = data?.filings ?? [];

  const filings: FilingItemType[] = items
    .filter((item) => !filingTypes || filingTypes.includes(item.formType ?? ''))
    .slice(0, limit)
    .map((item) => ({
      filing_id: `SEDAR_${item.id ?? Math.random().toString(36).slice(2)}`,
      type: item.formType ?? 'UNKNOWN',
      date: item.filedDate ?? item.periodDate ?? '',
      description: null,
      url: item.documentUrl ?? null,
      source: 'SEDAR' as const,
    }));

  return { filings, totalAvailable: data?.totalCount ?? filings.length };
}
