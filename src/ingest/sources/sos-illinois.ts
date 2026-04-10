// Illinois Secretary of State — Business Entity Search
// Endpoint: POST https://apps.ilsos.gov/businessentitysearch/businessentitysearch
// Returns JSON — no API key required

import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { generateEntityId } from '../../resolvers/entity-resolver.js';

const IL_SEARCH_URL =
  'https://apps.ilsos.gov/businessentitysearch/businessentitysearch';

interface ILSearchResult {
  entityName?: string;
  fileNumber?: string;
  entityType?: string;
  status?: string;
  dateOfFormation?: string;
  state?: string;
  agentName?: string;
  agentAddress?: string;
}

interface ILSearchResponse {
  rows?: ILSearchResult[];
  total?: number;
}

export async function lookupIllinoisEntity(
  entityName: string,
): Promise<EntityLookupOutputType | null> {
  const body = new URLSearchParams({
    entityName,
    entityType: '',
    status: '',
    searchType: 'begins',
  });

  const res = await fetch(IL_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: body.toString(),
  });
  if (!res.ok) return null;

  const data = await res.json() as ILSearchResponse;
  const rows = data.rows ?? [];
  if (rows.length === 0) return null;

  const best =
    rows.find(
      (r) => r.entityName?.toLowerCase() === entityName.toLowerCase(),
    ) ?? rows[0]!;

  const rawStatus = (best.status ?? '').toLowerCase();
  const status: EntityLookupOutputType['status'] =
    rawStatus === 'good standing' || rawStatus === 'active'
      ? 'active'
      : rawStatus.includes('dissolv')
        ? 'dissolved'
        : rawStatus.includes('revok') || rawStatus.includes('suspend')
          ? 'suspended'
          : 'unknown';

  return {
    entity_id: generateEntityId('US-IL', best.entityName ?? entityName),
    canonical_name: best.entityName ?? entityName,
    jurisdiction: 'US-IL',
    status,
    incorporated_at: best.dateOfFormation ?? null,
    registered_agent: best.agentName
      ? { name: best.agentName, address: best.agentAddress ?? '' }
      : null,
    officers: [],
    source: 'illinois_sos',
    source_url: best.fileNumber
      ? `https://apps.ilsos.gov/corporatellc/corporatellccontroller?searchType=entityNumber&entityNumber=${best.fileNumber}`
      : 'https://apps.ilsos.gov/businessentitysearch/',
    freshness_secs: 0,
    confidence: 0.85,
    data_freshness: 'fresh',
  };
}
