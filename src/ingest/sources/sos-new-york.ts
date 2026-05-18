// New York Department of State — Socrata Open Data API
// Dataset: https://data.ny.gov/resource/n9v6-gdp6.json  (Active Corporations: Beginning 1800)
// Replaces: ej5i-fucn (removed 2025)
// Free, no API key required. Includes registered agent, filing date, and jurisdiction.
// Both domestic NY corps and foreign corps registered in NY are in this dataset.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const NY_API_URL = 'https://data.ny.gov/resource/n9v6-gdp6.json';

interface NYEntityRecord {
  current_entity_name: string;
  dos_id: string;
  entity_type: string;
  initial_dos_filing_date: string | null;
  jurisdiction: string | null;
  county: string | null;
  registered_agent_name?: string;
  registered_agent_address_1?: string;
  registered_agent_city?: string;
  registered_agent_state?: string;
  registered_agent_zip?: string;
}

export async function lookupNewYorkEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  const normName = normaliseName(entityName);
  const params = new URLSearchParams({
    '$q': entityName,
    '$limit': '5',
  });

  const res = await fetch(`${NY_API_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'CorpSignal-MCP/1.0', Accept: 'application/json' },
  }).catch(() => null);

  if (!res?.ok) return null;

  const records = await res.json().catch(() => null) as NYEntityRecord[] | null;
  if (!records || records.length === 0) return null;

  const ranked = records
    .map((r) => ({
      r,
      score: normaliseName(r.current_entity_name) === normName ? 1 : 0.8,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const { r } = best;

  const agentAddr = [
    r.registered_agent_address_1,
    r.registered_agent_city,
    r.registered_agent_state,
    r.registered_agent_zip,
  ].filter(Boolean).join(', ');

  return {
    entity_id: generateEntityId('US-NY', r.current_entity_name),
    canonical_name: r.current_entity_name,
    jurisdiction: 'US-NY',
    status: 'active', // dataset only contains active/current entities
    incorporated_at: r.initial_dos_filing_date?.slice(0, 10) ?? null,
    registered_agent: r.registered_agent_name
      ? { name: r.registered_agent_name, address: agentAddr }
      : null,
    officers: [],
    source: 'new_york_dos',
    source_url: `https://apps.dos.ny.gov/publicInquiry/EntityDisplay?dosId=${r.dos_id}`,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
