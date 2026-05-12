// Companies House background sync — webhook + nightly full sync
// NEVER triggered by a live agent request

import cron from 'node-cron';
import {
  resolveUKEntity,
  fetchCompanyProfile,
  fetchCompanyOfficers,
} from './sources/companies-house.js';
import { setCache, entityCacheKey, addToUKWatchlist, getUKWatchlist } from '../cache/helpers.js';
import { generateEntityId } from '../resolvers/entity-resolver.js';
import type { EntityLookupOutputType } from '../schemas/entity.js';

const CH_TTL_SECS = 14400; // 4 hours

// Builds an entity record directly from a company number — used by the webhook handler
// so we skip the name-search step and go straight to the profile.
async function refreshEntityByCompanyNumber(
  companyNumber: string,
): Promise<EntityLookupOutputType | null> {
  const profile = await fetchCompanyProfile(companyNumber);
  const officers = await fetchCompanyOfficers(companyNumber);

  const address = [
    profile.registered_office_address.address_line_1,
    profile.registered_office_address.locality,
    profile.registered_office_address.postal_code,
    profile.registered_office_address.country,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    entity_id: generateEntityId('GB', profile.company_name),
    canonical_name: profile.company_name,
    jurisdiction: 'GB',
    status: profile.company_status === 'active' ? 'active' : 'dissolved',
    incorporated_at: profile.date_of_creation ?? null,
    registered_agent: address ? { name: 'Registered Office', address } : null,
    officers: officers.map((o) => ({
      name: o.name,
      role: o.officer_role,
      since: o.appointed_on ?? null,
    })),
    source: 'companies_house',
    source_url: `https://find-and-update.company-information.service.gov.uk/company/${companyNumber}`,
    freshness_secs: 0,
    confidence: 0.95,
    data_freshness: 'fresh',
  };
}

// Companies House streaming API event shape (company-profile resource kind)
interface CHStreamEvent {
  resource_kind?: string;
  resource_id?: string;
  data?: { company_name?: string };
  event?: { type?: string };
}

// Processes Companies House streaming API events.
// Only acts on company-profile change events — ignores all other resource kinds.
export async function handleCompaniesHouseWebhook(payload: unknown): Promise<void> {
  const event = payload as CHStreamEvent;

  if (event.resource_kind !== 'company-profile' || !event.resource_id) {
    return;
  }

  try {
    const entity = await refreshEntityByCompanyNumber(event.resource_id);
    if (!entity) return;

    const key = entityCacheKey('GB', entity.canonical_name);
    await setCache(key, entity, CH_TTL_SECS);
    await addToUKWatchlist(entity.canonical_name);
    console.log(`[ingest:ch] Webhook refreshed: ${entity.canonical_name} (${event.resource_id})`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest:ch] Webhook refresh failed for ${event.resource_id}: ${msg}`);
  }
}

export async function cacheUKEntity(entityName: string): Promise<void> {
  try {
    const result = await resolveUKEntity(entityName);
    if (result) {
      const key = entityCacheKey('GB', entityName);
      await setCache(key, result, CH_TTL_SECS);
      await addToUKWatchlist(entityName);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[ingest:ch] Failed to cache UK entity ${entityName}: ${msg}`);
  }
}

async function runNightlyUKSync(): Promise<void> {
  const watchlist = await getUKWatchlist();

  if (watchlist.length === 0) {
    console.log('[ingest:ch] Nightly sync: watchlist empty, skipping');
    return;
  }

  console.log(`[ingest:ch] Nightly sync: refreshing ${watchlist.length} UK entities`);
  let refreshed = 0;

  for (const entityName of watchlist) {
    try {
      await cacheUKEntity(entityName);
      refreshed++;
    } catch {
      // cacheUKEntity already logs errors; continue with the rest
    }
    // Respect Companies House rate limit (~600 req/5 min)
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`[ingest:ch] Nightly sync complete: ${refreshed}/${watchlist.length} refreshed`);
}

// Nightly at 3am UTC
export function startCompaniesHouseCron(): void {
  cron.schedule('0 3 * * *', () => {
    void runNightlyUKSync();
  });
  console.log('[ingest:ch] Cron scheduled: nightly 3am UTC');
}
