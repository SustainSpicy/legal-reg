// Companies House background sync — webhook + nightly full sync
// NEVER triggered by a live agent request

import cron from 'node-cron';
import { resolveUKEntity } from './sources/companies-house.js';
import { setCache, entityCacheKey } from '../cache/helpers.js';

const CH_TTL_SECS = 14400; // 4 hours

// Companies House provides a streaming API for real-time updates:
// https://developer.company-information.service.gov.uk/streaming-api
// In production, this webhook handler processes company profile change events.
// Full webhook implementation: Week 7.

export async function handleCompaniesHouseWebhook(payload: unknown): Promise<void> {
  // Week 7: parse Companies House streaming API event
  // and invalidate/refresh affected entity cache entries
  console.log('[ingest:ch] Webhook received (full implementation: Week 7)', payload);
}

async function runNightlyUKSync(): Promise<void> {
  // Nightly full sync of most-accessed UK entities
  // In production: iterate through a watchlist of high-access entities
  // and refresh their cache entries via Companies House API
  console.log('[ingest:ch] Nightly UK entity sync tick (full implementation: Week 7)');
}

export async function cacheUKEntity(entityName: string): Promise<void> {
  try {
    const result = await resolveUKEntity(entityName);
    if (result) {
      const key = entityCacheKey('GB', entityName);
      await setCache(key, result, CH_TTL_SECS);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest:ch] Failed to cache UK entity ${entityName}: ${msg}`);
  }
}

// Every 4 hours + nightly full sync
export function startCompaniesHouseCron(): void {
  cron.schedule('0 3 * * *', () => {
    void runNightlyUKSync();
  });
  console.log('[ingest:ch] Cron scheduled: nightly 3am UTC');
}
