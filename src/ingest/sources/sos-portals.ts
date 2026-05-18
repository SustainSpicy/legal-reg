// US State Secretary of State portal ingestion
// 42 states have official APIs or structured bulk data exports
// 8 states require nightly Playwright scraping (never per-request)

import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { lookupDelawareEntity } from './sos-delaware.js';
import { lookupCaliforniaEntity } from './sos-california.js';
import { lookupNewYorkEntity } from './sos-new-york.js';
import { lookupTexasEntity } from './sos-texas.js';
import { lookupFloridaEntity } from './sos-florida.js';
import { lookupColoradoEntity } from './sos-colorado.js';
import { lookupWashingtonEntity } from './sos-washington.js';
import { lookupIllinoisEntity } from './sos-illinois.js';
import { lookupGeorgiaEntity } from './sos-georgia.js';
import { lookupPendingStateEntity } from './sos-pending-states.js';
import { lookupViaOpenCorporates } from './opencorporates.js';

// States with open REST APIs or structured data exports — implemented and verified live
export const SOS_IMPLEMENTED: Record<string, string> = {
  'US-DE': 'delaware_sos',
  'US-CA': 'california_sos',
  'US-NY': 'new_york_dos',
  'US-TX': 'texas_sos',
  'US-FL': 'florida_sunbiz',
  'US-CO': 'colorado_sos',
  'US-WA': 'washington_sos',
  'US-IL': 'illinois_sos',
  'US-GA': 'georgia_sos',
};

// States with documented APIs — implementation pending (Weeks 8–10)
export const SOS_PENDING: Record<string, string> = {
  'US-NV': 'nevada_sos',
  'US-MA': 'massachusetts_sos',
  'US-WY': 'wyoming_sos',
  'US-OR': 'oregon_sos',
  'US-AZ': 'arizona_sos',
  'US-MN': 'minnesota_sos',
  'US-OH': 'ohio_sos',
  'US-PA': 'pennsylvania_dos',
  'US-NJ': 'new_jersey_sos',
  'US-VA': 'virginia_scc',
  'US-NC': 'north_carolina_sos',
  'US-TN': 'tennessee_sos',
  'US-MO': 'missouri_sos',
  'US-SC': 'south_carolina_sos',
  'US-IN': 'indiana_sos',
  'US-WI': 'wisconsin_dfi',
  'US-MD': 'maryland_sos',
  'US-CT': 'connecticut_sos',
  'US-KY': 'kentucky_sos',
  'US-OK': 'oklahoma_sos',
  'US-IA': 'iowa_sos',
  'US-LA': 'louisiana_sos',
  'US-KS': 'kansas_sos',
  'US-UT': 'utah_sos',
  'US-NM': 'new_mexico_sos',
  'US-NE': 'nebraska_sos',
  'US-ME': 'maine_sos',
  'US-RI': 'rhode_island_sos',
  'US-NH': 'new_hampshire_sos',
  'US-VT': 'vermont_sos',
  'US-SD': 'south_dakota_sos',
  'US-ID': 'idaho_sos',
};

// States requiring nightly Playwright scraping (no structured API)
// Handled by sos-scraper.ts — NEVER triggered per-request
export const SCRAPE_ONLY_STATES = [
  'US-AL', 'US-AK', 'US-AR', 'US-HI', 'US-MS', 'US-MT', 'US-ND', 'US-WV',
];

// All supported jurisdictions (for entity_lookup validation)
export const ALL_SOS_JURISDICTIONS = {
  ...SOS_IMPLEMENTED,
  ...SOS_PENDING,
};

export async function lookupSOSEntity(
  entityName: string,
  jurisdiction: string,
): Promise<EntityLookupOutputType | null> {
  if (SCRAPE_ONLY_STATES.includes(jurisdiction)) {
    // Only available via nightly scraper cache — try OpenCorporates as live fallback
    return lookupViaOpenCorporates(entityName, jurisdiction).catch(() => null);
  }

  let result: EntityLookupOutputType | null = null;

  switch (jurisdiction) {
    case 'US-DE': result = await lookupDelawareEntity(entityName); break;
    case 'US-CA': result = await lookupCaliforniaEntity(entityName); break;
    case 'US-NY': result = await lookupNewYorkEntity(entityName); break;
    case 'US-TX': result = await lookupTexasEntity(entityName); break;
    case 'US-FL': result = await lookupFloridaEntity(entityName); break;
    case 'US-CO': result = await lookupColoradoEntity(entityName); break;
    case 'US-WA': result = await lookupWashingtonEntity(entityName); break;
    case 'US-IL': result = await lookupIllinoisEntity(entityName); break;
    case 'US-GA': result = await lookupGeorgiaEntity(entityName); break;
    default: result = await lookupPendingStateEntity(entityName, jurisdiction); break;
  }

  // If primary SOS source fails (blocked, changed API, etc.), fall back to
  // OpenCorporates which indexes most official registries directly
  if (!result) {
    result = await lookupViaOpenCorporates(entityName, jurisdiction).catch(() => null);
  }

  return result;
}

// Placeholder for nightly-scraped state data format
export interface ScrapedSOSRecord {
  entity_name: string;
  jurisdiction: string;
  status: string;
  incorporated_at: string | null;
  registered_agent_name: string | null;
  registered_agent_address: string | null;
}

export function mapScrapedRecordToEntity(record: ScrapedSOSRecord): EntityLookupOutputType {
  return {
    entity_id: generateEntityId(record.jurisdiction, record.entity_name),
    canonical_name: record.entity_name,
    jurisdiction: record.jurisdiction,
    status: record.status === 'Active' ? 'active'
      : record.status === 'Dissolved' ? 'dissolved'
      : 'unknown',
    incorporated_at: record.incorporated_at,
    registered_agent: record.registered_agent_name
      ? { name: record.registered_agent_name, address: record.registered_agent_address ?? '' }
      : null,
    officers: [],
    source: `sos_scraper_${record.jurisdiction.toLowerCase().replace('-', '_')}`,
    source_url: null,
    freshness_secs: 0,
    confidence: 0.9,
    data_freshness: 'fresh',
  };
}
