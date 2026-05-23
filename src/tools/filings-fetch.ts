import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FilingsFetchInput, FilingsFetchSuccessSchema } from '../schemas/filings.js';
import { getCached, setCache, filingsCacheKey } from '../cache/helpers.js';
import { generateEntityId, resolveEntityFromCache, resolveEntityUpstream, MIN_ENTITY_CONFIDENCE, SOS_PORTAL_LIVE } from '../resolvers/entity-resolver.js';
import { fetchEDGARSubmissions, resolveEDGAREntity } from '../ingest/sources/edgar.js';
import { fetchCHFilings, resolveCompanyNumber } from '../ingest/sources/companies-house-filings.js';
import { fetchSEDARFilings } from '../ingest/sources/canada.js';
import { structuredError } from '../errors/codes.js';
import type { FilingsFetchOutputType, FilingItemType } from '../schemas/filings.js';

// Parse key financial metrics from an EDGAR 10-K filing index page
async function parseEDGARFinancials(
  cik: string,
  accessionNumber: string,
): Promise<FilingsFetchOutputType['financials']> {
  // Fetch the filing index to find the XBRL data document
  const cleanAccession = accessionNumber.replace(/-/g, '');
  const indexUrl = `https://data.sec.gov/Archives/edgar/data/${cik}/${cleanAccession}/index.json`;
  const contact = process.env['EDGAR_CONTACT_EMAIL'] ?? 'compliance@corpsignal.io';
  const headers = { 'User-Agent': `CorpSignal-MCP/1.0 (${contact})`, Accept: 'application/json' };

  const indexRes = await fetch(indexUrl, { headers });
  if (!indexRes.ok) return null;

  const index = await indexRes.json() as {
    directory?: { item?: Array<{ name: string; type: string }> };
  };
  const items = index.directory?.item ?? [];

  // Find the primary XBRL instance document (R*.htm or *_htm.xml)
  const xbrlDoc = items.find(
    (i) => i.type === '10-K' || i.name.endsWith('_htm.xml') || i.name.match(/^R\d+\.htm$/),
  );
  if (!xbrlDoc) return null;

  // Fetch the company facts JSON — contains all GAAP financial data in structured form
  // This is the fastest path: data.sec.gov/api/xbrl/companyfacts/CIK{}.json
  const factsUrl = `https://data.sec.gov/api/xbrl/companyfacts/CIK${cik.padStart(10, '0')}.json`;
  const factsRes = await fetch(factsUrl, { headers });
  if (!factsRes.ok) return null;

  interface XBRLFact {
    units?: {
      USD?: Array<{ end: string; val: number; form: string; accn: string }>;
    };
  }

  const facts = await factsRes.json() as {
    facts?: {
      'us-gaap'?: {
        Revenues?: XBRLFact;
        RevenueFromContractWithCustomerExcludingAssessedTax?: XBRLFact;
        NetIncomeLoss?: XBRLFact;
        Assets?: XBRLFact;
      };
    };
  };

  const gaap = facts.facts?.['us-gaap'];
  if (!gaap) return null;

  // Pick the most recent annual filing values
  function latestAnnual(fact: XBRLFact | undefined): number | null {
    if (!fact?.units?.USD) return null;
    const annual = fact.units.USD
      .filter((e) => e.form === '10-K' && e.accn === accessionNumber.replace(/-/g, ''))
      .sort((a, b) => b.end.localeCompare(a.end));
    return annual[0]?.val ?? null;
  }

  const revenue =
    latestAnnual(gaap.Revenues) ??
    latestAnnual(gaap.RevenueFromContractWithCustomerExcludingAssessedTax);
  const netIncome = latestAnnual(gaap.NetIncomeLoss);
  const totalAssets = latestAnnual(gaap.Assets);

  if (revenue === null && netIncome === null && totalAssets === null) return null;

  return {
    period: accessionNumber.slice(0, 4) + '-12-31', // approximate from accession year
    revenue_usd: revenue,
    net_income_usd: netIncome,
    total_assets_usd: totalAssets,
    currency_original: 'USD',
  };
}

export function registerFilingsFetch(server: McpServer): void {
  server.registerTool(
    'filings_fetch',
    {
      description:
        'Retrieve recent corporate filings for any US public company (via SEC EDGAR), UK company (via Companies House), or Canadian public company (via SEDAR+). Optionally parse key financial metrics from the latest 10-K annual filing. Use this when the user wants to see a company recent regulatory filings, check when they last filed, retrieve annual reports, or verify SEC or Companies House registration history.',
      inputSchema: FilingsFetchInput,
      outputSchema: FilingsFetchSuccessSchema,
      _meta: {
        surface: 'both',
        queryEligible: true,
        latencyClass: 'fast',
        pricing: { executeUsd: '0.002' },
        rateLimit: {
          maxRequestsPerMinute: 150,
          cooldownMs: 400,
          maxConcurrency: 20,
        },
        dataBroker: {
          deterministic: true,
          auditFields: ['source', 'freshness_secs', 'data_freshness'],
        },
      },
    },
    async (args) => {
      const {
        entity_name,
        jurisdiction,
        entity_id,
        filing_types,
        limit = 10,
        parse_financials = false,
      } = args;

      if (!entity_id && !entity_name) {
        return structuredError('ENTITY_NOT_FOUND', 'Provide either entity_id or entity_name to fetch filings');
      }

      const resolvedJurisdiction = jurisdiction ?? 'US-DE';
      const canonicalId = entity_id ?? generateEntityId(resolvedJurisdiction, entity_name!);

      // When entity_id is provided without entity_name, verify the entity was actually
      // resolved by entity_lookup before fetching filings. A confidence-0 stub means
      // entity_lookup found nothing; we must refuse rather than return Apple/Amazon filings.
      // resolvedById is kept alive so downstream code can use canonical_name for EDGAR lookup
      // instead of falling back to an empty entity_name (which returns no filings).
      let resolvedById: import('../schemas/entity.js').EntityLookupOutputType | null = null;
      if (entity_id && !entity_name) {
        resolvedById = await getCached<import('../schemas/entity.js').EntityLookupOutputType>(
          `entity:id:${canonicalId}`,
        );
        if (!resolvedById || resolvedById.confidence < MIN_ENTITY_CONFIDENCE || resolvedById.status === 'unknown') {
          return structuredError(
            'ENTITY_NOT_RESOLVED',
            `Entity '${canonicalId}' is not resolved — ` +
            `run entity_lookup first to verify the entity exists before fetching filings.`,
          );
        }
      }

      // Separate cache keys for with/without financials to avoid serving
      // cached null-financials when parse_financials=true
      const cacheKey = filingsCacheKey(canonicalId) + (parse_financials ? ':fin' : '');
      const cached = await getCached<FilingsFetchOutputType>(cacheKey);
      if (cached) {
        const filings = filing_types
          ? cached.filings.filter((f) => filing_types.includes(f.type)).slice(0, limit)
          : cached.filings.slice(0, limit);
        return {
          content: [{ type: 'text', text: JSON.stringify({ ...cached, filings }) }],
          structuredContent: { ...cached, filings },
        };
      }

      let entityData = entity_name
        ? await resolveEntityFromCache(entity_name, resolvedJurisdiction)
        : resolvedById;

      let filings: FilingItemType[] = [];
      let source = 'unknown';
      let totalAvailable = 0;
      let financials: FilingsFetchOutputType['financials'] = null;

      if (resolvedJurisdiction === 'GB') {
        if (!entity_name) {
          return structuredError('ENTITY_NOT_FOUND', 'entity_name is required for UK filings lookup');
        }
        // Companies House filings
        const companyNumber = await resolveCompanyNumber(entity_name);
        if (!companyNumber) {
          return structuredError('ENTITY_NOT_FOUND', `No UK company found for '${entity_name}'`);
        }
        const { filings: chFilings, totalAvailable: chTotal } =
          await fetchCHFilings(companyNumber, limit, filing_types);
        filings = chFilings;
        totalAvailable = chTotal;
        source = 'companies_house';
      } else if (resolvedJurisdiction === 'CA' || resolvedJurisdiction.startsWith('CA-')) {
        if (!entity_name) {
          return structuredError('ENTITY_NOT_FOUND', 'entity_name is required for SEDAR+ filings lookup');
        }
        // SEDAR+ for Canadian public companies
        const { filings: sedarFilings, totalAvailable: sedarTotal } =
          await fetchSEDARFilings(entity_name, limit, filing_types);
        if (sedarFilings.length === 0) {
          return structuredError('ENTITY_NOT_FOUND', `No SEDAR+ filings found for '${entity_name}'. Private Canadian companies do not file on SEDAR+.`);
        }
        filings = sedarFilings;
        totalAvailable = sedarTotal;
        source = 'sedar';
      } else {
        // SOS_PORTAL_LIVE gate: for states with a live SOS portal, entity_name must be
        // confirmed by the SOS before EDGAR filings are returned. Without this gate,
        // filings_fetch mints a US-DE entity_id on EDGAR data for companies like Apple
        // that entity_lookup correctly denies exist in Delaware.
        if (entity_name && !entity_id && SOS_PORTAL_LIVE.has(resolvedJurisdiction)) {
          const sosCheck = entityData ?? await resolveEntityUpstream(entity_name, resolvedJurisdiction);
          if (sosCheck.confidence < MIN_ENTITY_CONFIDENCE) {
            return structuredError(
              'ENTITY_NOT_FOUND',
              `No entity found for '${entity_name}' in ${resolvedJurisdiction}. ` +
              `This entity may be registered in a different jurisdiction.`,
            );
          }
          entityData = sosCheck;
        }

        // EDGAR for US public companies — use entity_name if provided, otherwise fall back
        // to the canonical_name resolved from the entity_id cache (populated by entity_lookup).
        const lookupName = entity_name ?? resolvedById?.canonical_name;
        const edgarEntity = lookupName ? await resolveEDGAREntity(lookupName) : null;
        if (edgarEntity) {
          const cikMatch = edgarEntity.source_url?.match(/CIK=(\d+)/);
          const cik = cikMatch?.[1];
          if (cik) {
            const profile = await fetchEDGARSubmissions(cik);
            if (profile) {
              const recent = profile.filings.recent;
              totalAvailable = recent.form.length;

              filings = recent.form
                .map((form, i): FilingItemType => ({
                  filing_id: `EDGAR_${recent.accessionNumber[i] ?? i}`,
                  type: form,
                  date: recent.filingDate[i] ?? '',
                  description: null,
                  url: recent.accessionNumber[i]
                    ? `https://www.sec.gov/Archives/edgar/data/${cik}/${recent.accessionNumber[i]!.replace(/-/g, '')}/`
                    : null,
                  source: 'EDGAR',
                }))
                .filter((f) => !filing_types || filing_types.includes(f.type))
                .slice(0, limit);
              source = 'edgar';

              // parse_financials: find the most recent 10-K and extract XBRL facts
              if (parse_financials) {
                const latestAnnual = recent.form
                  .map((form, i) => ({ form, accn: recent.accessionNumber[i] ?? '' }))
                  .find((f) => f.form === '10-K');
                if (latestAnnual?.accn) {
                  financials = await parseEDGARFinancials(cik, latestAnnual.accn).catch(() => null);
                }
              }
            }
          }
        }
      }

      if (filings.length === 0) {
        return structuredError('ENTITY_NOT_FOUND', `No filings found for '${entity_name ?? canonicalId}' in ${resolvedJurisdiction}`);
      }

      const result: FilingsFetchOutputType = {
        entity_id: canonicalId,
        canonical_name: entityData?.canonical_name ?? entity_name ?? canonicalId,
        jurisdiction: resolvedJurisdiction,
        filings,
        financials,
        total_available: totalAvailable,
        source,
        freshness_secs: 0,
        data_freshness: 'fresh',
      };

      // Cache financials for 12h (slower to recompute), plain filings for 2h
      await setCache(cacheKey, result, parse_financials ? 43200 : 7200);

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
