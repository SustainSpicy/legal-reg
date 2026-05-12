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
    SEARCH_FILTER_TYPE_ID: '0',
    SEARCH_TYPE_ID: '1',
    sortColumn: 'score',
    sortOrder: 'desc',
    numberOfRows: 5,
    startRow: 0,
  });

  const res = await fetch(CA_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; CorpSignal/1.0; +https://corpsignal.com)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Origin': 'https://bizfileonline.sos.ca.gov',
      'Referer': 'https://bizfileonline.sos.ca.gov/search/business',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
    body,
  }).catch(() => null);

  if (!res?.ok) return null;

  const data = await res.json().catch(() => null) as CASearchResponse | null;
  const hits = data?.hits?.hits ?? [];
  if (hits.length === 0) return null;

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
    source_url: 'https://bizfileonline.sos.ca.gov/search/business',
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
