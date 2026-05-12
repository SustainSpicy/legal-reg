import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { BeneficialOwnersInput, BeneficialOwnersSuccessSchema } from '../schemas/beneficial-owners.js';
import { getCached, setCache, beneficialOwnersCacheKey } from '../cache/helpers.js';
import { generateEntityId } from '../resolvers/entity-resolver.js';
import { structuredError } from '../errors/codes.js';
import { resolveCompanyNumber } from '../ingest/sources/companies-house-filings.js';
import type { BeneficialOwnersOutputType } from '../schemas/beneficial-owners.js';

// ---------------------------------------------------------------------------
// GLEIF LEI Registry — free, no auth required
// https://api.gleif.org/api/v1
// Covers ~2.5M entities globally; returns structural parent relationships.
// Note: ownership % is not published in GLEIF — disclosure_status is 'partial'.
// ---------------------------------------------------------------------------

interface GLEIFRecord {
  id: string;
  attributes: {
    entity: {
      legalName: { name: string };
      registeredAddress?: { country?: string };
    };
    registration: { registrationStatus: string };
  };
}

interface GLEIFResponse {
  data?: GLEIFRecord[];
}

async function fetchGLEIFOwners(
  entityName: string,
): Promise<{ owners: BeneficialOwnersOutputType['owners']; disclosureStatus: BeneficialOwnersOutputType['disclosure_status'] }> {
  const searchUrl =
    `https://api.gleif.org/api/v1/lei-records` +
    `?filter[entity.legalName]=${encodeURIComponent(entityName)}&page[size]=5`;

  const res = await fetch(searchUrl, {
    headers: { Accept: 'application/vnd.api+json' },
  }).catch(() => null);

  if (!res?.ok) return { owners: [], disclosureStatus: 'unavailable' };

  const data = await res.json() as GLEIFResponse;
  const records = data.data ?? [];
  if (records.length === 0) return { owners: [], disclosureStatus: 'unavailable' };

  const normQuery = entityName.toLowerCase().trim();
  const match =
    records.find(
      (r) =>
        r.attributes.entity.legalName.name.toLowerCase().includes(normQuery) ||
        normQuery.includes(r.attributes.entity.legalName.name.toLowerCase()),
    ) ?? records[0]!;

  const lei = match.id;

  // Fetch direct parents and ultimate parents in parallel
  const [directRes, ultimateRes] = await Promise.all([
    fetch(`https://api.gleif.org/api/v1/lei-records/${lei}/direct-parents`, {
      headers: { Accept: 'application/vnd.api+json' },
    }).catch(() => null),
    fetch(`https://api.gleif.org/api/v1/lei-records/${lei}/ultimate-parents`, {
      headers: { Accept: 'application/vnd.api+json' },
    }).catch(() => null),
  ]);

  const directParents: GLEIFRecord[] = directRes?.ok
    ? ((await directRes.json() as GLEIFResponse).data ?? [])
    : [];

  const ultimateParents: GLEIFRecord[] = ultimateRes?.ok
    ? ((await ultimateRes.json() as GLEIFResponse).data ?? [])
    : [];

  if (directParents.length === 0 && ultimateParents.length === 0) {
    return { owners: [], disclosureStatus: 'unavailable' };
  }

  const directLeis = new Set(directParents.map((p) => p.id));

  const allOwners = [
    ...directParents.map((p) => ({ record: p, indirect: false })),
    ...ultimateParents
      .filter((u) => !directLeis.has(u.id))
      .map((u) => ({ record: u, indirect: true })),
  ];

  const owners: BeneficialOwnersOutputType['owners'] = allOwners.map(({ record, indirect }) => ({
    owner_id: record.id, // LEI code as stable identifier
    name: record.attributes.entity.legalName.name,
    ownership_pct: null, // GLEIF exposes structure, not % stakes
    control_type: 'ownership' as const,
    indirect,
    nationality: record.attributes.entity.registeredAddress?.country ?? null,
    source: 'GLEIF_LEI' as const,
    notified_on: null,
  }));

  return { owners, disclosureStatus: 'partial' };
}

// ---------------------------------------------------------------------------
// EDGAR Schedule 13G / 13D — >5% beneficial owner disclosures (US public cos)
// Free, no auth. Filers ARE the beneficial owners declaring their stake.
// ---------------------------------------------------------------------------

interface EDGARHit {
  _source?: { entity_name?: string; period_of_report?: string };
  _id?: string;
}

async function fetchEDGARSchedule13Owners(
  entityName: string,
): Promise<BeneficialOwnersOutputType['owners']> {
  const contact = process.env['EDGAR_CONTACT_EMAIL'] ?? 'compliance@corpsignal.io';
  const headers = { 'User-Agent': `CorpSignal-MCP/1.0 (${contact})`, Accept: 'application/json' };

  // Search for SC 13G / SC 13D filings that reference this entity name.
  // The filer (issuer field in the filing) is the >5% owner; the subject company
  // appears in the full-text. We extract distinct filer names as beneficial owners.
  const year = new Date().getFullYear() - 2;
  const searchUrl =
    `https://efts.sec.gov/LATEST/search-index` +
    `?q="${encodeURIComponent(entityName)}"` +
    `&forms=SC+13G,SC+13D` +
    `&dateRange=custom&startdt=${year}-01-01` +
    `&hits.hits._source=entity_name,period_of_report,file_date` +
    `&hits.hits.total=true`;

  const res = await fetch(searchUrl, { headers }).catch(() => null);
  if (!res?.ok) return [];

  interface SearchResult {
    hits?: { hits?: EDGARHit[] };
  }
  const data = await res.json() as SearchResult;
  const hits = data.hits?.hits ?? [];
  if (hits.length === 0) return [];

  // Deduplicate by entity_name — each unique filer is a distinct beneficial owner
  const seen = new Set<string>();
  const owners: BeneficialOwnersOutputType['owners'] = [];

  for (const hit of hits) {
    const filerName = hit._source?.entity_name;
    if (!filerName || seen.has(filerName)) continue;
    // Skip hits where the filer name matches the subject company (self-filings)
    if (filerName.toLowerCase().includes(entityName.toLowerCase().slice(0, 10))) continue;
    seen.add(filerName);
    owners.push({
      owner_id: null,
      name: filerName,
      ownership_pct: null, // % is in the filing body; not parsed here
      control_type: 'ownership' as const,
      indirect: false,
      nationality: null,
      source: 'EDGAR_PROXY' as const,
      notified_on: hit._source?.period_of_report ?? null,
    });
  }

  return owners;
}

// ---------------------------------------------------------------------------
// UK Companies House — Persons with Significant Control (PSC)
// ---------------------------------------------------------------------------

async function fetchUKPSC(companyNumber: string): Promise<BeneficialOwnersOutputType['owners']> {
  const apiKey = process.env['COMPANIES_HOUSE_API_KEY'];
  if (!apiKey) return [];

  const encoded = Buffer.from(`${apiKey}:`).toString('base64');
  const url = `https://api.companieshouse.gov.uk/company/${companyNumber}/persons-with-significant-control`;
  const res = await fetch(url, { headers: { Authorization: `Basic ${encoded}` } });
  if (!res.ok) return [];

  interface PSCItem {
    name: string;
    nationality?: string;
    notified_on?: string;
    natures_of_control?: string[];
  }

  const data = await res.json() as { items?: PSCItem[] };
  return (data.items ?? []).map((psc) => ({
    owner_id: null,
    name: psc.name ?? 'Unknown',
    ownership_pct: null,
    control_type: 'ownership' as const,
    indirect: (psc.natures_of_control ?? []).some((n) => n.includes('indirect')),
    nationality: psc.nationality ?? null,
    source: 'UK_PSC' as const,
    notified_on: psc.notified_on ?? null,
  }));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export function registerBeneficialOwners(server: McpServer): void {
  server.registerTool(
    'beneficial_owners',
    {
      description:
        'Retrieve beneficial ownership (UBO) data. For UK entities: Companies House PSC register. ' +
        'For US and global entities: GLEIF LEI registry (structural parent relationships) with ' +
        'EDGAR Schedule 13G/D fallback for US public companies (>5% holders). ' +
        'Note: FinCEN BOI is a restricted government API unavailable to commercial callers; ' +
        'GLEIF + EDGAR provide equivalent coverage for public and large private entities.',
      inputSchema: BeneficialOwnersInput,
      outputSchema: BeneficialOwnersSuccessSchema,
      _meta: {
        surface: 'both',
        queryEligible: true,
        latencyClass: 'fast',
        pricing: { executeUsd: '0.003' },
        rateLimit: {
          maxRequestsPerMinute: 100,
          cooldownMs: 600,
          maxConcurrency: 20,
        },
        dataBroker: {
          deterministic: true,
          auditFields: ['source', 'freshness_secs', 'disclosure_status', 'data_freshness'],
        },
      },
    },
    async (args) => {
      const { entity_name = 'Acme Holdings LLC', jurisdiction = 'US-DE', entity_id } = args;

      const canonicalId = entity_id ?? generateEntityId(jurisdiction, entity_name);
      const cacheKey = beneficialOwnersCacheKey(canonicalId);
      const cached = await getCached<BeneficialOwnersOutputType>(cacheKey);
      if (cached) {
        return {
          content: [{ type: 'text', text: JSON.stringify(cached) }],
          structuredContent: cached,
        };
      }

      let owners: BeneficialOwnersOutputType['owners'] = [];
      let disclosureStatus: BeneficialOwnersOutputType['disclosure_status'] = 'unavailable';
      let source = 'unknown';

      if (jurisdiction === 'GB') {
        // Resolve real company number via Companies House search (not canonical ID)
        const companyNumber = await resolveCompanyNumber(entity_name);
        if (!companyNumber) {
          return structuredError('ENTITY_NOT_FOUND', `No UK company found for '${entity_name}'`);
        }
        owners = await fetchUKPSC(companyNumber);
        source = 'UK_PSC';
        disclosureStatus = owners.length > 0 ? 'full' : 'unavailable';
      } else if (jurisdiction.startsWith('US') || jurisdiction === 'CA' || jurisdiction.startsWith('CA-') || jurisdiction === 'global') {
        // Primary: GLEIF LEI (structural parent relationships, global coverage)
        const gleif = await fetchGLEIFOwners(entity_name);
        if (gleif.owners.length > 0) {
          owners = gleif.owners;
          disclosureStatus = gleif.disclosureStatus;
          source = 'GLEIF_LEI';
        } else {
          // Fallback: EDGAR Schedule 13G/D for US public companies
          const edgarOwners = await fetchEDGARSchedule13Owners(entity_name);
          if (edgarOwners.length > 0) {
            owners = edgarOwners;
            disclosureStatus = 'partial';
            source = 'EDGAR_PROXY';
          } else {
            // CTA-exempt small private businesses, or entity not in GLEIF/EDGAR
            console.log(
              `[bowners] No ownership data found for '${entity_name}' (${canonicalId}). ` +
              `Entity may be a small private company not registered with GLEIF or EDGAR. ` +
              `FinCEN BOI is restricted to government/BSA-regulated callers.`,
            );
            disclosureStatus = 'unavailable';
            source = 'none';
          }
        }
      } else {
        return structuredError(
          'BENEFICIAL_OWNERSHIP_UNAVAILABLE',
          `Beneficial ownership data not available for jurisdiction '${jurisdiction}'. Supported: US (all states), GB, CA (all provinces).`,
        );
      }

      const result: BeneficialOwnersOutputType = {
        entity_id: canonicalId,
        canonical_name: entity_name,
        jurisdiction,
        owners,
        disclosure_status: disclosureStatus,
        source,
        freshness_secs: 0,
        data_freshness: 'fresh',
      };

      await setCache(cacheKey, result, 7200);

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
