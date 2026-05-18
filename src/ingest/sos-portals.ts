// Background SOS portal ingestion
// High-volume states (DE, CA, NY, TX, FL, CO) refreshed every 4 hours
// NEVER triggered by a live agent request

import cron from 'node-cron';
import { setCache, entityCacheKey, getEntityWatchlist } from '../cache/helpers.js';
import { lookupSOSEntity, SOS_IMPLEMENTED, SOS_PENDING } from './sources/sos-portals.js';
import { resolveUKEntity } from './sources/companies-house.js';
import { resolveEDGAREntity } from './sources/edgar.js';

const ENTITY_TTL_SECS = 14400; // 4 hours

// Static seeds — one well-known entity per implemented and pending jurisdiction.
// These ensure every state has at least one warm cache entry on startup.
// The dynamic watchlist (populated from live requests) supplements this list.
const WARM_ENTITIES: Array<{ name: string; jurisdiction: string }> = [
  // Core implemented states
  { name: 'Apple Inc', jurisdiction: 'US-DE' },
  { name: 'Microsoft Corporation', jurisdiction: 'US-WA' },
  { name: 'Amazon.com Inc', jurisdiction: 'US-DE' },
  { name: 'Google LLC', jurisdiction: 'US-DE' },
  { name: 'Tesla Inc', jurisdiction: 'US-DE' },
  { name: 'Meta Platforms Inc', jurisdiction: 'US-DE' },
  { name: 'Alphabet Inc', jurisdiction: 'US-DE' },
  { name: 'Salesforce Inc', jurisdiction: 'US-CA' },
  { name: 'Gap Inc', jurisdiction: 'US-CA' },
  { name: 'JPMorgan Chase Bank National Association', jurisdiction: 'US-NY' },
  { name: 'Citibank NA', jurisdiction: 'US-NY' },
  { name: 'AT&T Inc', jurisdiction: 'US-TX' },
  { name: 'Enterprise Products Partners LP', jurisdiction: 'US-TX' },
  { name: 'World Fuel Services Corporation', jurisdiction: 'US-FL' },
  { name: 'Publix Super Markets Inc', jurisdiction: 'US-FL' },
  { name: 'United Airlines Holdings Inc', jurisdiction: 'US-IL' },
  { name: 'Exelon Corporation', jurisdiction: 'US-IL' },
  { name: 'The Coca-Cola Company', jurisdiction: 'US-GA' },
  { name: 'Delta Air Lines Inc', jurisdiction: 'US-GA' },
  { name: 'Ball Corporation', jurisdiction: 'US-CO' },
  { name: 'Amazon Web Services Inc', jurisdiction: 'US-WA' },
  { name: 'Starbucks Corporation', jurisdiction: 'US-WA' },
  // UK
  { name: 'Barclays Bank PLC', jurisdiction: 'GB' },
  { name: 'HSBC Holdings PLC', jurisdiction: 'GB' },
  { name: 'Lloyds Banking Group PLC', jurisdiction: 'GB' },
  // Pending states — one seed each so the first request is fast
  { name: 'Wynn Resorts Ltd', jurisdiction: 'US-NV' },
  { name: 'Liberty Mutual Group Inc', jurisdiction: 'US-MA' },
  { name: 'Sinclair Oil Corporation', jurisdiction: 'US-WY' },
  { name: 'Nike Inc', jurisdiction: 'US-OR' },
  { name: 'Freeport-McMoRan Inc', jurisdiction: 'US-AZ' },
  { name: 'Target Corporation', jurisdiction: 'US-MN' },
  { name: 'Progressive Corporation', jurisdiction: 'US-OH' },
  { name: 'Comcast Corporation', jurisdiction: 'US-PA' },
  { name: 'Johnson and Johnson', jurisdiction: 'US-NJ' },
  { name: 'Capital One Financial Corporation', jurisdiction: 'US-VA' },
  { name: 'Duke Energy Corporation', jurisdiction: 'US-NC' },
  { name: 'FedEx Corporation', jurisdiction: 'US-TN' },
  { name: 'Emerson Electric Co', jurisdiction: 'US-MO' },
  { name: 'Sonoco Products Company', jurisdiction: 'US-SC' },
  { name: 'Eli Lilly and Company', jurisdiction: 'US-IN' },
  { name: 'Epic Systems Corporation', jurisdiction: 'US-WI' },
  { name: 'Lockheed Martin Corporation', jurisdiction: 'US-MD' },
  { name: 'Cigna Group', jurisdiction: 'US-CT' },
  { name: 'Humana Inc', jurisdiction: 'US-KY' },
  { name: 'Devon Energy Corporation', jurisdiction: 'US-OK' },
  { name: 'Principal Financial Group Inc', jurisdiction: 'US-IA' },
  { name: 'Entergy Louisiana LLC', jurisdiction: 'US-LA' },
  { name: 'Spirit AeroSystems Inc', jurisdiction: 'US-KS' },
  { name: 'Zions Bancorporation NA', jurisdiction: 'US-UT' },
  { name: 'PNM Resources Inc', jurisdiction: 'US-NM' },
  { name: 'Berkshire Hathaway Inc', jurisdiction: 'US-NE' },
  { name: 'WEX Inc', jurisdiction: 'US-ME' },
  { name: 'CVS Health Corporation', jurisdiction: 'US-RI' },
  { name: 'PC Connection Inc', jurisdiction: 'US-NH' },
  { name: 'GlobalFoundries US Inc', jurisdiction: 'US-VT' },
  { name: 'Sanford USD Medical Center', jurisdiction: 'US-SD' },
  { name: 'Micron Technology Inc', jurisdiction: 'US-ID' },
];

/**
 * Refresh a single entity in the cache.
 * Resolution order: SOS portal → Companies House (UK) → EDGAR (fallback for US)
 */
export async function refreshEntityCache(
  entityName: string,
  jurisdiction: string,
): Promise<import('../schemas/entity.js').EntityLookupOutputType | null> {
  try {
    let result = null;

    if (jurisdiction === 'GB') {
      result = await resolveUKEntity(entityName);
    } else if (jurisdiction.startsWith('US')) {
      result = await lookupSOSEntity(entityName, jurisdiction);
      if (!result) {
        result = await resolveEDGAREntity(entityName);
        if (result && result.jurisdiction !== jurisdiction) {
          // EDGAR returned an entity registered in a different state — don't override
          // the jurisdiction field, as that would give misleading data (e.g. Microsoft
          // returning US-WA data when queried for US-DE).
          result = null;
        }
      }
    }

    if (result) {
      const key = entityCacheKey(jurisdiction, entityName);
      result = { ...result, freshness_secs: 0 };
      await setCache(key, result, ENTITY_TTL_SECS);
      // Also write the reverse-index so entity_id-only calls to downstream tools
      // (compliance_risk_score, filings_fetch, beneficial_owners) can verify the entity
      await setCache(`entity:id:${result.entity_id}`, result, ENTITY_TTL_SECS);
      return result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest:sos] Cache refresh failed for ${entityName} (${jurisdiction}): ${msg}`);
  }
  return null;
}

export async function ingestHighVolumeStates(): Promise<void> {
  // Build the full warming list: static seeds + top-5 from each jurisdiction's watchlist
  const entities = new Map<string, string>(); // key `jur:name` → dedup

  for (const { name, jurisdiction } of WARM_ENTITIES) {
    entities.set(`${jurisdiction}:${name.toLowerCase()}`, JSON.stringify({ name, jurisdiction }));
  }

  const allJurisdictions = Object.keys({ ...SOS_IMPLEMENTED, ...SOS_PENDING });
  await Promise.all(
    allJurisdictions.map(async (jur) => {
      const watchlist = await getEntityWatchlist(jur);
      for (const name of watchlist.slice(0, 5)) {
        entities.set(`${jur}:${name}`, JSON.stringify({ name, jurisdiction: jur }));
      }
    }),
  );

  const list = [...entities.values()].map(
    (v) => JSON.parse(v) as { name: string; jurisdiction: string },
  );

  console.log(`[ingest:sos] Warming entity cache for ${list.length} entities...`);

  const results = await Promise.allSettled(
    list.map(async ({ name, jurisdiction }) => {
      const result = await refreshEntityCache(name, jurisdiction);
      if (result) {
        console.log(`[ingest:sos] Warmed: ${name} (${jurisdiction})`);
      }
    }),
  );

  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(`[ingest:sos] Cache warm: ${failed}/${list.length} entities failed`);
  }
}

// Every 4 hours
export function startSOSIngestCron(): void {
  cron.schedule('0 */4 * * *', () => {
    void ingestHighVolumeStates();
  });
  console.log('[ingest:sos] Cron scheduled: every 4 hours');
}
