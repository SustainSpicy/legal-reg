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
