// Texas Secretary of State — SOSDirect / Comptroller open data
// The TX SOS public search is at https://mycpa.cpa.state.tx.us/coa/
// The Comptroller publishes a taxable entity dataset via open data.
// For entity lookup we use the TX SOS name search endpoint (JSON response).

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

// TX SOS provides a public search via their EFILE portal
const TX_SEARCH_URL = 'https://mycpa.cpa.state.tx.us/coa/coaSearchCriteria.do';
const TX_API_URL = 'https://mycpa.cpa.state.tx.us/coa/coaSearch.do';

interface TXEntityResult {
  taxpayerName: string;
  taxpayerNumber: string;
  taxPayerStatus: string;
  rightToTransactBusiness: string;
  mbrCount?: string;
  principalAddress?: string;
  registeredAgentName?: string;
  registeredAgentAddress?: string;
}

interface TXSearchResponse {
  taxPayerView?: TXEntityResult[];
  taxPayerCount?: number;
}

function mapTXStatus(raw: string): EntityLookloadOutputType['status'] {
  const s = raw.toLowerCase();
  if (s.includes('active') || s.includes('good')) return 'active';
  if (s.includes('forfeit') || s.includes('dissol') || s.includes('terminat')) return 'dissolved';
  if (s.includes('suspend')) return 'suspended';
  return 'unknown';
}

// TypeScript fix — local alias
type EntityLookloadOutputType = EntityLookupOutputType;

export async function lookupTexasEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  // TX Comptroller search accepts form POST with JSON response
  const body = new URLSearchParams({
    searchCriteria: entityName,
    searchType: 'NAME',
    orderByColumn: 'TAXPAYER_NAME',
    maxResults: '5',
  });

  const res = await fetch(TX_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'CorpSignal-MCP/1.0',
    },
    body: body.toString(),
  });

  if (!res.ok) throw new Error(`TX SOS search failed: ${res.status}`);

  const data = await res.json() as TXSearchResponse;
  const results = data.taxPayerView ?? [];
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const ranked = results
    .map((r) => ({
      r,
      score: normaliseName(r.taxpayerName) === normQuery ? 1 : 0.8,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const { r } = best;

  return {
    entity_id: generateEntityId('US-TX', r.taxpayerName),
    canonical_name: r.taxpayerName,
    jurisdiction: 'US-TX',
    status: mapTXStatus(r.rightToTransactBusiness ?? r.taxPayerStatus),
    incorporated_at: null, // Not in the Comptroller dataset
    registered_agent: r.registeredAgentName
      ? { name: r.registeredAgentName, address: r.registeredAgentAddress ?? '' }
      : null,
    officers: [],
    source: 'texas_sos',
    source_url: `https://mycpa.cpa.state.tx.us/coa/coaSearchCriteria.do`,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
