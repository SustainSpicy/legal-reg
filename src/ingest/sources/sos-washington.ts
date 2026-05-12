// Washington Secretary of State — Corporations & Charities Filing System (CCFS)
// Endpoint: GET https://ccfs.sos.wa.gov/api/Search/EntitySearch
// No API key required — public open data portal

import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { generateEntityId } from '../../resolvers/entity-resolver.js';

// CCFS API paths to try in order (base has shifted across portal versions)
const WA_API_CANDIDATES = [
  'https://ccfs.sos.wa.gov/api/Search/EntitySearch',
  'https://ccfs.sos.wa.gov/api/v1/Search/EntitySearch',
  'https://ccfs.sos.wa.gov/api/v2/Search/EntitySearch',
];

interface WASearchResult {
  entityId?: string;
  entityName?: string;
  entityType?: string;
  entityStatus?: string;
  formationDate?: string;
  expirationDate?: string;
  registeredAgent?: {
    name?: string;
    address?: {
      addressLine1?: string;
      city?: string;
      state?: string;
      postalCode?: string;
    };
  };
}

interface WASearchResponse {
  data?: WASearchResult[];
  totalCount?: number;
}

export async function lookupWashingtonEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const qs = new URLSearchParams({ name: entityName, take: '5', skip: '0' }).toString();

  let data: WASearchResponse | null = null;
  for (const base of WA_API_CANDIDATES) {
    const res = await fetch(`${base}?${qs}`, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; CorpSignal/1.0; +https://corpsignal.com)',
        'Referer': 'https://ccfs.sos.wa.gov/',
      },
    }).catch(() => null);
    if (!res?.ok) continue;
    data = await res.json().catch(() => null) as WASearchResponse | null;
    if (data) break;
  }

  if (!data) return null;
  const results = data.data ?? [];
  if (results.length === 0) return null;

  const best =
    results.find((r) => r.entityName?.toLowerCase() === entityName.toLowerCase()) ?? results[0]!;

  const rawStatus = (best.entityStatus ?? '').toLowerCase();
  const status: EntityLookupOutputType['status'] =
    rawStatus === 'active' || rawStatus === 'good standing'
      ? 'active'
      : rawStatus.includes('dissolv') || rawStatus.includes('expired')
        ? 'dissolved'
        : rawStatus.includes('suspend') || rawStatus.includes('revok')
          ? 'suspended'
          : 'unknown';

  const agent = best.registeredAgent;
  const agentAddress = agent?.address
    ? [
        agent.address.addressLine1,
        agent.address.city,
        agent.address.state,
        agent.address.postalCode,
      ]
        .filter(Boolean)
        .join(', ')
    : null;

  return {
    entity_id: generateEntityId('US-WA', best.entityName ?? entityName),
    canonical_name: best.entityName ?? entityName,
    jurisdiction: 'US-WA',
    status,
    incorporated_at: best.formationDate ?? null,
    registered_agent: agent?.name
      ? { name: agent.name, address: agentAddress ?? '' }
      : null,
    officers: [],
    source: 'washington_sos',
    source_url: best.entityId
      ? `https://ccfs.sos.wa.gov/#/BusinessSearch/BusinessInformation?businessID=${best.entityId}`
      : 'https://ccfs.sos.wa.gov/#/BusinessSearch',
    freshness_secs: 0,
    confidence: 0.85,
    data_freshness: 'fresh',
  };
}
