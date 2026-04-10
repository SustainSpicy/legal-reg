import { createClient } from 'redis';

const redisUrl = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

export const redis = createClient({ url: redisUrl });

redis.on('error', (err: Error) => {
  console.error('[cache] Redis connection error:', err.message);
});

let connected = false;

export async function connectRedis(): Promise<void> {
  if (connected) return;
  try {
    await redis.connect();
    connected = true;
    console.log('[cache] Redis connected');
  } catch (err) {
    console.error('[cache] Redis failed to connect — cache disabled, live fallback active:', err);
  }
}

export function isRedisConnected(): boolean {
  return connected && redis.isReady;
}
