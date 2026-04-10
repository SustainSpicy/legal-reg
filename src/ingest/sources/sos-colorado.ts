// Colorado Secretary of State — Open Data (Socrata)
// Dataset: https://data.colorado.gov/resource/2bgs-cdmr.json
// Free Socrata API, no key required.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const CO_API_URL = 'https://data.colorado.gov/resource/2bgs-cdmr.json';

interface COEntityRecord {
  entityname: string;
  entityid: string;
  entitystatus: string;
  entitytype: string;
  principaladdress1?: string;
  principalcity?: string;
  principalstate?: string;
  principalzipcode?: string;
  registeredagentname?: string;
  registeredagentaddress1?: string;
  registeredagentcity?: string;
  formationdate?: string;
}

function mapCOStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s === 'good standing' || s.includes('active') || s.includes('good')) return 'active';
  if (s.includes('dissolv') || s.includes('withdraw') || s.includes('revok')) return 'dissolved';
  if (s.includes('delinquent') || s.includes('suspend')) return 'suspended';
  return 'unknown';
}

export async function lookupColoradoEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  // Socrata LIKE query for begins-with match
  const params = new URLSearchParams({
    '$where': `upper(entityname) like '${entityName.toUpperCase().replace(/'/g, "''")}%'`,
    '$limit': '5',
    '$order': 'entityname ASC',
  });

  const res = await fetch(`${CO_API_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'CorpSignal-MCP/1.0' },
  });

  if (!res.ok) throw new Error(`CO SOS API failed: ${res.status}`);

  const records = await res.json() as COEntityRecord[];
  if (records.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const ranked = records
    .map((r) => ({
      r,
      score: normaliseName(r.entityname) === normQuery ? 1 : 0.8,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const { r } = best;

  const agentAddr = [r.registeredagentaddress1, r.registeredagentcity, 'CO']
    .filter(Boolean)
    .join(', ');

  return {
    entity_id: generateEntityId('US-CO', r.entityname),
    canonical_name: r.entityname,
    jurisdiction: 'US-CO',
    status: mapCOStatus(r.entitystatus),
    incorporated_at: r.formationdate ?? null,
    registered_agent: r.registeredagentname
      ? { name: r.registeredagentname, address: agentAddr }
      : null,
    officers: [],
    source: 'colorado_sos',
    source_url: `https://www.sos.state.co.us/biz/BusinessEntityDetail.do?quitButtonDestination=BusinessEntityResults&nameTyp=ENT&masterFileId=${r.entityid}`,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
