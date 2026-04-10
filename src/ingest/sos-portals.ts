// Background SOS portal ingestion
// High-volume states (DE, CA, NY, TX, FL, CO) refreshed every 4 hours
// NEVER triggered by a live agent request

import cron from 'node-cron';
import { setCache, entityCacheKey } from '../cache/helpers.js';
import { lookupSOSEntity, SOS_IMPLEMENTED } from './sources/sos-portals.js';
import { resolveUKEntity } from './sources/companies-house.js';
import { resolveEDGAREntity } from './sources/edgar.js';

const ENTITY_TTL_SECS = 14400; // 4 hours

// Popular entity names to warm the cache on startup / cron tick.
// In production this list grows from access-log analytics.
const WARM_ENTITIES: Array<{ name: string; jurisdiction: string }> = [
  { name: 'Apple Inc', jurisdiction: 'US-DE' },
  { name: 'Microsoft Corporation', jurisdiction: 'US-DE' },
  { name: 'Amazon.com Inc', jurisdiction: 'US-DE' },
  { name: 'Google LLC', jurisdiction: 'US-DE' },
  { name: 'Tesla Inc', jurisdiction: 'US-DE' },
  { name: 'Meta Platforms Inc', jurisdiction: 'US-DE' },
  { name: 'Alphabet Inc', jurisdiction: 'US-DE' },
  { name: 'Barclays Bank PLC', jurisdiction: 'GB' },
  { name: 'HSBC Holdings PLC', jurisdiction: 'GB' },
  { name: 'Lloyds Banking Group PLC', jurisdiction: 'GB' },
];

async function warmEntityCache(): Promise<void> {
  console.log('[ingest:sos] Warming entity cache for popular entities...');
  const results = await Promise.allSettled(
    WARM_ENTITIES.map(async ({ name, jurisdiction }) => {
      const result = await refreshEntityCache(name, jurisdiction);
      if (result) {
        console.log(`[ingest:sos] Warmed: ${name} (${jurisdiction})`);
      }
    }),
  );
  const failed = results.filter((r) => r.status === 'rejected').length;
  if (failed > 0) {
    console.warn(`[ingest:sos] Cache warm: ${failed}/${WARM_ENTITIES.length} entities failed`);
  }
}

async function ingestHighVolumeStates(): Promise<void> {
  console.log(`[ingest:sos] Refreshing ${Object.keys(SOS_IMPLEMENTED).length} implemented SOS jurisdictions`);
  await warmEntityCache();
}

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
      // Try jurisdiction-specific SOS portal first
      result = await lookupSOSEntity(entityName, jurisdiction);
      // Fall back to EDGAR for states not yet implemented or public companies
      if (!result) {
        result = await resolveEDGAREntity(entityName);
        // Correct jurisdiction from EDGAR if our target is more specific
        if (result && result.jurisdiction !== jurisdiction) {
          result = { ...result, jurisdiction };
        }
      }
    }

    if (result) {
      const key = entityCacheKey(jurisdiction, entityName);
      result = { ...result, freshness_secs: 0 };
      await setCache(key, result, ENTITY_TTL_SECS);
      return result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest:sos] Cache refresh failed for ${entityName} (${jurisdiction}): ${msg}`);
  }
  return null;
}

// Every 4 hours
export function startSOSIngestCron(): void {
  cron.schedule('0 */4 * * *', () => {
    void ingestHighVolumeStates();
  });
  console.log('[ingest:sos] Cron scheduled: every 4 hours');
}
