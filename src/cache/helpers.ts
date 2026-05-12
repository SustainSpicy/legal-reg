import { redis, isRedisConnected } from './client.js';

export async function getCached<T>(key: string): Promise<T | null> {
  if (!isRedisConnected()) return null;
  try {
    const val = await redis.get(key);
    return val ? (JSON.parse(val) as T) : null;
  } catch {
    return null;
  }
}

export async function setCache(
  key: string,
  value: unknown,
  ttlSecs = 3600,
): Promise<void> {
  if (!isRedisConnected()) return;
  try {
    await redis.set(key, JSON.stringify(value), { EX: ttlSecs });
  } catch {
    // Cache writes are best-effort — never fail a tool call due to a cache write error
  }
}

export async function deleteCache(key: string): Promise<void> {
  if (!isRedisConnected()) return;
  try {
    await redis.del(key);
  } catch {
    // Ignore
  }
}

export function entityCacheKey(jurisdiction: string, name: string): string {
  return `entity:${jurisdiction.toLowerCase()}:${name.toLowerCase()}`;
}

export function sanctionsCacheKey(listName: string): string {
  return `sanctions:list:${listName}`;
}

export function sanctionsScreenCacheKey(name: string): string {
  return `sanctions:screen:${name.toLowerCase()}`;
}

export function filingsCacheKey(entityId: string): string {
  return `filings:${entityId}`;
}

export function complianceCacheKey(entityId: string): string {
  return `compliance:${entityId}`;
}

export function beneficialOwnersCacheKey(entityId: string): string {
  return `bowners:${entityId}`;
}

// ---- Entity access watchlists -----------------------------------------------
// Sorted sets scored by timestamp; newest-first; capped at WATCHLIST_MAX per jurisdiction.
// Used by background cron jobs to know which entities to proactively refresh.

const WATCHLIST_MAX = 200;

function watchlistKey(jurisdiction: string): string {
  return `watchlist:${jurisdiction.toLowerCase().replace(/-/g, '_')}`;
}

export async function addToEntityWatchlist(entityName: string, jurisdiction: string): Promise<void> {
  if (!isRedisConnected()) return;
  try {
    await redis.zAdd(watchlistKey(jurisdiction), { score: Date.now(), value: entityName.toLowerCase() });
    await redis.zRemRangeByRank(watchlistKey(jurisdiction), 0, -(WATCHLIST_MAX + 1));
  } catch {
    // Best-effort
  }
}

export async function getEntityWatchlist(jurisdiction: string): Promise<string[]> {
  if (!isRedisConnected()) return [];
  try {
    return await redis.zRange(watchlistKey(jurisdiction), 0, -1, { REV: true });
  } catch {
    return [];
  }
}

// Backward-compat aliases used by ingest/companies-house.ts
export const addToUKWatchlist = (name: string): Promise<void> => addToEntityWatchlist(name, 'GB');
export const getUKWatchlist = (): Promise<string[]> => getEntityWatchlist('GB');

// ---- Scraper health tracking ------------------------------------------------
// Persisted in Redis (no TTL) so health survives restarts.
// Used to downgrade confidence on entities from jurisdictions with stale scrapers.

export interface ScraperHealth {
  lastRunAt: number;
  lastSuccessAt: number | null;
  lastCount: number;
  consecutiveFailures: number;
}

function scraperHealthKey(jurisdiction: string): string {
  return `scraper:health:${jurisdiction.toLowerCase().replace(/-/g, '_')}`;
}

export async function setScraperHealth(
  jurisdiction: string,
  success: boolean,
  count: number,
): Promise<void> {
  if (!isRedisConnected()) return;
  const existing = await getScraperHealth(jurisdiction);
  const health: ScraperHealth = {
    lastRunAt: Date.now(),
    lastSuccessAt: success ? Date.now() : (existing?.lastSuccessAt ?? null),
    lastCount: count,
    consecutiveFailures: success ? 0 : (existing?.consecutiveFailures ?? 0) + 1,
  };
  try {
    await redis.set(scraperHealthKey(jurisdiction), JSON.stringify(health));
  } catch {
    // Best-effort
  }
}

export async function getScraperHealth(jurisdiction: string): Promise<ScraperHealth | null> {
  if (!isRedisConnected()) return null;
  try {
    const val = await redis.get(scraperHealthKey(jurisdiction));
    return val ? (JSON.parse(val) as ScraperHealth) : null;
  } catch {
    return null;
  }
}
