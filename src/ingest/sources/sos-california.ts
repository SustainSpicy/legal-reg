// California Secretary of State — BizFile Online API
// Base: https://bizfileonline.sos.ca.gov
// The public search endpoint accepts JSON queries and returns structured results.
// No API key required.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const CA_SEARCH_URL = 'https://bizfileonline.sos.ca.gov/api/Records/businesssearch';

interface CASearchResult {
  CORP_NUM: string;
  NAME: string;
  STATUS: string;
  ENTITY_TYPE: string;
  FILING_DATE: string | null;
  AGENT_NAME: string | null;
  AGENT_ADDRESS: string | null;
}

interface CASearchResponse {
  hits?: {
    hits?: Array<{
      _source?: CASearchResult;
    }>;
  };
}

function mapCAStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s === 'active' || s.includes('good')) return 'active';
  if (s.includes('dissol') || s.includes('cancel') || s.includes('void')) return 'dissolved';
  if (s.includes('suspend')) return 'suspended';
  return 'unknown';
}

export async function lookupCaliforniaEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  const body = JSON.stringify({
    SEARCH_VALUE: entityName,
    SEARCH_FILTER_TYPE_ID: '0', // 0 = all entity types
    SEARCH_TYPE_ID: '1',        // 1 = begins with
    sortColumn: 'score',
    sortOrder: 'desc',
    numberOfRows: 5,
    startRow: 0,
  });

  const res = await fetch(CA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'CorpSignal-MCP/1.0',
    },
    body,
  });

  if (!res.ok) throw new Error(`CA SOS search failed: ${res.status}`);

  const data = await res.json() as CASearchResponse;
  const hits = data.hits?.hits ?? [];
  if (hits.length === 0) return null;

  // Find best name match
  const normQuery = normaliseName(entityName);
  const ranked = hits
    .map((h) => h._source)
    .filter((s): s is CASearchResult => !!s)
    .map((s) => ({
      s,
      score: normaliseName(s.NAME) === normQuery ? 1 : 0.8,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const { s } = best;

  return {
    entity_id: generateEntityId('US-CA', s.NAME),
    canonical_name: s.NAME,
    jurisdiction: 'US-CA',
    status: mapCAStatus(s.STATUS),
    incorporated_at: s.FILING_DATE ?? null,
    registered_agent: s.AGENT_NAME
      ? { name: s.AGENT_NAME, address: s.AGENT_ADDRESS ?? '' }
      : null,
    officers: [],
    source: 'california_sos',
    source_url: `https://bizfileonline.sos.ca.gov/search/business`,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
