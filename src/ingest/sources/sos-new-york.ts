// New York Department of State — Socrata Open Data API
// Dataset: https://data.ny.gov/Economic-Development/Active-Corporations-Beginning-1800s/ej5i-fucn
// Free, no API key required. Returns JSON with entity records.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const NY_API_URL = 'https://data.ny.gov/resource/ej5i-fucn.json';

interface NYEntityRecord {
  current_entity_name: string;
  dos_id: string;
  entity_type: string;
  date_of_initial_dos_filing: string | null;
  county: string | null;
  // Active corporations dataset — status is implicitly active
}

function mapNYStatus(_record: NYEntityRecord): EntityLookupOutputType['status'] {
  // The NY dataset only contains active/current corporations
  return 'active';
}

export async function lookupNewYorkEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  // Socrata SoQL query — $q for full-text, $where for field filter
  const normName = normaliseName(entityName);
  const params = new URLSearchParams({
    '$q': entityName,
    '$limit': '5',
    '$order': ':relevance',
  });

  const res = await fetch(`${NY_API_URL}?${params.toString()}`, {
    headers: { 'User-Agent': 'CorpSignal-MCP/1.0' },
  });

  if (!res.ok) throw new Error(`NY SOS API failed: ${res.status}`);

  const records = await res.json() as NYEntityRecord[];
  if (records.length === 0) return null;

  // Rank by name similarity
  const ranked = records
    .map((r) => ({
      r,
      score: normaliseName(r.current_entity_name) === normName ? 1 : 0.8,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;

  const { r } = best;

  return {
    entity_id: generateEntityId('US-NY', r.current_entity_name),
    canonical_name: r.current_entity_name,
    jurisdiction: 'US-NY',
    status: mapNYStatus(r),
    incorporated_at: r.date_of_initial_dos_filing ?? null,
    registered_agent: null, // Not in the public dataset
    officers: [],
    source: 'new_york_dos',
    source_url: `https://apps.dos.ny.gov/publicInquiry/EntityDisplay?dosId=${r.dos_id}`,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
