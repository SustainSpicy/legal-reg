// Georgia Secretary of State — eCorp Business Search
// Endpoint: GET https://ecorp.sos.ga.gov/BusinessSearch/api/BusinessSearch
// Returns JSON — no API key required

import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { generateEntityId } from '../../resolvers/entity-resolver.js';

const GA_API_BASE = 'https://ecorp.sos.ga.gov/BusinessSearch/api';

interface GASearchResult {
  businessName?: string;
  controlNumber?: string;
  businessType?: string;
  businessStatus?: string;
  dateOfFormation?: string;
  stateOfFormation?: string;
  registeredAgent?: string;
  registeredOffice?: string;
}

interface GASearchResponse {
  results?: GASearchResult[];
  totalCount?: number;
}

export async function lookupGeorgiaEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const url =
    `${GA_API_BASE}/BusinessSearch?` +
    new URLSearchParams({
      entityName,
      searchType: 'EntityName',
      pageNumber: '1',
      pageSize: '5',
    }).toString();

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) return null;

  const data = await res.json() as GASearchResponse;
  const results = data.results ?? [];
  if (results.length === 0) return null;

  const best =
    results.find(
      (r) => r.businessName?.toLowerCase() === entityName.toLowerCase(),
    ) ?? results[0]!;

  const rawStatus = (best.businessStatus ?? '').toLowerCase();
  const status: EntityLookupOutputType['status'] =
    rawStatus === 'active' || rawStatus === 'good standing'
      ? 'active'
      : rawStatus.includes('dissolv') || rawStatus.includes('withdrawn')
        ? 'dissolved'
        : rawStatus.includes('suspend') || rawStatus.includes('revok')
          ? 'suspended'
          : 'unknown';

  return {
    entity_id: generateEntityId('US-GA', best.businessName ?? entityName),
    canonical_name: best.businessName ?? entityName,
    jurisdiction: 'US-GA',
    status,
    incorporated_at: best.dateOfFormation ?? null,
    registered_agent: best.registeredAgent
      ? { name: best.registeredAgent, address: best.registeredOffice ?? '' }
      : null,
    officers: [],
    source: 'georgia_sos',
    source_url: best.controlNumber
      ? `https://ecorp.sos.ga.gov/BusinessSearch/BusinessInformation?businessID=${best.controlNumber}`
      : 'https://ecorp.sos.ga.gov/BusinessSearch',
    freshness_secs: 0,
    confidence: 0.85,
    data_freshness: 'fresh',
  };
}
