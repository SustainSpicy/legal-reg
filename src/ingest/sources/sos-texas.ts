// Texas Secretary of State — Comptroller of Public Accounts open data
// The Comptroller publishes the Taxable Entity Data Set via Socrata open data.
// Endpoint: https://data.texas.gov/resource/9cir-efmm.json
// No API key required.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const TX_SOCRATA_URL = 'https://data.texas.gov/resource/9cir-efmm.json';

interface TXSocrataResult {
  taxpayer_name: string;
  taxpayer_number?: string;
  taxpayer_state?: string;
  right_to_transact_business?: string;
  city?: string;
  state?: string;
  zip?: string;
}

function mapTXStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s.includes('active') || s.includes('good') || s === 'a') return 'active';
  if (s.includes('forfeit') || s.includes('dissol') || s.includes('terminat')) return 'dissolved';
  if (s.includes('suspend')) return 'suspended';
  return 'unknown';
}

export async function lookupTexasEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  // Socrata SoQL: begins-with match on taxpayer_name, case-insensitive
  const escaped = entityName.toUpperCase().replace(/'/g, "''");
  const params = new URLSearchParams({
    '$where': `upper(taxpayer_name) like '${escaped}%'`,
    '$limit': '5',
    '$order': 'taxpayer_name ASC',
  });

  const res = await fetch(`${TX_SOCRATA_URL}?${params.toString()}`, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'CorpSignal-MCP/1.0',
    },
  }).catch(() => null);

  if (!res?.ok) return null;

  const results = await res.json().catch(() => null) as TXSocrataResult[] | null;
  if (!results || results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const ranked = results
    .map((r) => ({ r, score: normaliseName(r.taxpayer_name) === normQuery ? 1 : 0.8 }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const { r } = best;
  const rawStatus = r.right_to_transact_business ?? r.taxpayer_state ?? '';

  const agentAddr = [r.city, r.state, r.zip].filter(Boolean).join(', ');

  return {
    entity_id: generateEntityId('US-TX', r.taxpayer_name),
    canonical_name: r.taxpayer_name,
    jurisdiction: 'US-TX',
    status: mapTXStatus(rawStatus),
    incorporated_at: null, // Not in the Comptroller dataset
    registered_agent: agentAddr ? { name: 'Principal Office', address: agentAddr } : null,
    officers: [],
    source: 'texas_sos',
    source_url: 'https://mycpa.cpa.state.tx.us/coa/coaSearchCriteria.do',
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
