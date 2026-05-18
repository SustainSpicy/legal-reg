import { normaliseName, similarityScore, soundex } from './name-normaliser.js';
import { getCached, setCache, entityCacheKey, addToEntityWatchlist } from '../cache/helpers.js';
import type { EntityLookupOutputType } from '../schemas/entity.js';
import { lookupSOSEntity, SCRAPE_ONLY_STATES } from '../ingest/sources/sos-portals.js';
import { resolveUKEntity } from '../ingest/sources/companies-house.js';
import { resolveEDGAREntity } from '../ingest/sources/edgar.js';
import { scrapeEntityOnDemand } from '../ingest/sos-scraper.js';
import { resolveCanadianEntity } from '../ingest/sources/canada.js';

// Supported jurisdictions — drawn from SOS sources + UK/Canada
// Implemented = live SOS lookup; Pending = EDGAR fallback until SOS wired
export const SUPPORTED_JURISDICTIONS: Record<string, string> = {
  // Implemented SOS portals
  'US-DE': 'delaware_sos',
  'US-CA': 'california_sos',
  'US-NY': 'new_york_dos',
  'US-TX': 'texas_sos',
  'US-FL': 'florida_sunbiz',
  'US-CO': 'colorado_sos',
  'US-WA': 'washington_sos',
  'US-IL': 'illinois_sos',
  'US-GA': 'georgia_sos',
  // Pending SOS portals (EDGAR fallback active)
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
  // Scrape-only states (nightly Playwright — cache-served only)
  'US-AL': 'alabama_sos',
  'US-AK': 'alaska_sos',
  'US-AR': 'arkansas_sos',
  'US-HI': 'hawaii_sos',
  'US-MS': 'mississippi_sos',
  'US-MT': 'montana_sos',
  'US-ND': 'north_dakota_sos',
  'US-WV': 'west_virginia_sos',
  // UK
  'GB': 'companies_house',
  // Canada — federal + major provinces
  'CA':    'corporations_canada',
  'CA-BC': 'bc_corporate_registry',
  'CA-ON': 'ontario_business_registry',
  'CA-AB': 'alberta_corporate_registry',
  'CA-QC': 'req_quebec',
};

// Jurisdictions that require nightly scraping (no public API)
export const SCRAPE_ONLY_JURISDICTIONS = new Set([
  'US-AL', 'US-AK', 'US-AR', 'US-HI', 'US-MS', 'US-MT', 'US-ND', 'US-WV',
]);

export function generateEntityId(jurisdiction: string, name: string): string {
  const normJurisdiction = jurisdiction.toLowerCase().replace(/-/g, '_');
  const normName = normaliseName(name).replace(/\s+/g, '_').slice(0, 40);
  return `corpsig_${normJurisdiction}_${normName}`;
}

export async function resolveEntityFromCache(
  entityName: string,
  jurisdiction: string,
): Promise<EntityLookupOutputType | null> {
  // Try exact cache key first
  const key = entityCacheKey(jurisdiction, entityName);
  const cached = await getCached<EntityLookupOutputType>(key);
  if (cached) return cached;

  // Try canonical ID lookup
  const canonicalId = generateEntityId(jurisdiction, entityName);
  const byId = await getCached<EntityLookupOutputType>(`entity:id:${canonicalId}`);
  if (byId) return byId;

  return null;
}

// Fan-out to upstream sources on cache miss (parallel where possible)
export async function resolveEntityUpstream(
  entityName: string,
  jurisdiction: string,
): Promise<EntityLookupOutputType> {
  const entityId = generateEntityId(jurisdiction, entityName);
  const key = entityCacheKey(jurisdiction, entityName);

  let live: EntityLookupOutputType | null = null;

  try {
    if (jurisdiction === 'GB') {
      live = await resolveUKEntity(entityName);
    } else if (jurisdiction === 'CA' || jurisdiction.startsWith('CA-')) {
      live = await resolveCanadianEntity(entityName, jurisdiction);
    } else if (jurisdiction.startsWith('US')) {
      if (SCRAPE_ONLY_STATES.includes(jurisdiction)) {
        // Scrape-only states: check nightly cache first, then on-demand scrape
        live = await scrapeEntityOnDemand(entityName, jurisdiction);
      } else {
        // API states: SOS portal first, EDGAR fallback
        live = await lookupSOSEntity(entityName, jurisdiction);
        if (!live) {
          const edgar = await resolveEDGAREntity(entityName);
          // Only accept EDGAR result when its jurisdiction matches the query.
          // EDGAR encodes the state-of-incorporation, so a Microsoft query for
          // US-DE would return US-WA — reject that rather than silently lying.
          if (edgar && edgar.jurisdiction === jurisdiction) {
            live = edgar;
          }
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[resolver] Upstream lookup failed for ${entityName} (${jurisdiction}): ${msg}`);
  }

  if (live) {
    // Write-through: cache live result for 4 hours
    await setCache(key, live, 14400);
    // Track for background cache warming across all jurisdictions
    await addToEntityWatchlist(entityName, jurisdiction);
    return live;
  }

  // Could not resolve — return stub with stale flag so agent is informed
  const stub: EntityLookupOutputType = {
    entity_id: entityId,
    canonical_name: entityName,
    jurisdiction,
    status: 'unknown',
    incorporated_at: null,
    registered_agent: null,
    officers: [],
    source: SUPPORTED_JURISDICTIONS[jurisdiction] ?? 'unknown',
    source_url: null,
    freshness_secs: 0,
    confidence: 0,
    data_freshness: 'stale',
  };

  // Short TTL so the next request retries upstream
  await setCache(key, stub, 300);
  return stub;
}

export function disambiguateEntities(
  candidates: EntityLookupOutputType[],
  queryName: string,
  queryJurisdiction: string,
): EntityLookupOutputType | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  // Score each candidate: name similarity + jurisdiction match bonus
  const scored = candidates.map((c) => {
    const nameSim = similarityScore(c.canonical_name, queryName);
    const jurisdictionBonus = c.jurisdiction === queryJurisdiction ? 0.1 : 0;
    const soundexBonus =
      soundex(c.canonical_name) === soundex(queryName) ? 0.05 : 0;
    return { candidate: c, score: nameSim + jurisdictionBonus + soundexBonus };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0]!.candidate;
}
