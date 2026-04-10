// Florida Division of Corporations — SunBiz
// Public search API: https://search.sunbiz.org
// Returns JSON for entity name searches. No API key required.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const FL_SEARCH_URL = 'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults';

interface FLSearchResult {
  EntityName: string;
  DocumentNumber: string;
  Status: string;
  FiledDate: string | null;
  PrincipalAddress?: {
    AddressLine1?: string;
    City?: string;
    State?: string;
    PostalCode?: string;
  };
  RegisteredAgent?: {
    Name?: string;
    AddressLine1?: string;
    City?: string;
    State?: string;
  };
}

interface FLSearchResponse {
  Items?: FLSearchResult[];
}

function mapFLStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s === 'active') return 'active';
  if (s.includes('dissol') || s.includes('inactiv') || s.includes('revok')) return 'dissolved';
  if (s.includes('delinq')) return 'suspended';
  return 'unknown';
}

export async function lookupFloridaEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  const params = new URLSearchParams({
    SearchTerm: entityName,
    SearchType: 'EntityName',
    SearchNameOrder: 'BEGINS',
  });

  const res = await fetch(`${FL_SEARCH_URL}?${params.toString()}`, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'CorpSignal-MCP/1.0',
    },
  });

  if (!res.ok) throw new Error(`FL SunBiz search failed: ${res.status}`);

  const data = await res.json() as FLSearchResponse;
  const results = data.Items ?? [];
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const ranked = results
    .map((r) => ({
      r,
      score: normaliseName(r.EntityName) === normQuery ? 1 : 0.8,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const { r } = best;

  const agentName = r.RegisteredAgent?.Name ?? null;
  const agentAddr = r.RegisteredAgent
    ? [r.RegisteredAgent.AddressLine1, r.RegisteredAgent.City, r.RegisteredAgent.State]
        .filter(Boolean)
        .join(', ')
    : null;

  return {
    entity_id: generateEntityId('US-FL', r.EntityName),
    canonical_name: r.EntityName,
    jurisdiction: 'US-FL',
    status: mapFLStatus(r.Status),
    incorporated_at: r.FiledDate ?? null,
    registered_agent: agentName ? { name: agentName, address: agentAddr ?? '' } : null,
    officers: [],
    source: 'florida_sunbiz',
    source_url: `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?documentId=${r.DocumentNumber}`,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
