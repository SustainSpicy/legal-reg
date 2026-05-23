/**
 * Flush stale pre-fix filings + beneficial-owners cache entries.
 * Run on the VPS: node scripts/flush-stale-cache.mjs
 */
import { createClient } from 'redis';

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const client = createClient({ url: redisUrl });

client.on('error', (err) => console.error('[redis] error:', err.message));

await client.connect();
console.log('[redis] connected to', redisUrl);

const KEYS = [
  // filings keys — normaliseName strips 'Inc'/'Corp', so IDs are suffix-free
  'filings:corpsig_us_de_apple',
  'filings:corpsig_us_de_apple:fin',
  'filings:corpsig_us_de_tesla',
  'filings:corpsig_us_de_tesla:fin',
  // beneficial-owners keys
  'bowners:corpsig_us_de_apple',
  'bowners:corpsig_us_de_tesla',
];

let deleted = 0;
for (const key of KEYS) {
  const n = await client.del(key);
  if (n > 0) {
    console.log(`  deleted: ${key}`);
    deleted++;
  } else {
    console.log(`  not found (already gone or never cached): ${key}`);
  }
}

console.log(`\nDone — ${deleted} key(s) flushed.`);
await client.quit();
