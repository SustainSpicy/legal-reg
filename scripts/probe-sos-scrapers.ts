// Probe SOS scrapers against Fortune 500 entities — proves live lookup + cache write.
//
// Run:   npx ts-node --esm scripts/probe-sos-scrapers.ts
// Scope: npx ts-node --esm scripts/probe-sos-scrapers.ts --state DE
//
// Each probe entry is (a) fetched from the live SOS source / OC fallback,
// (b) written to Redis under both the name key AND entity:id reverse-index key,
// (c) read back from Redis to confirm the write succeeded.
//
// Results are durable — the warm cache is a useful side-effect of running this.

import { connectRedis, isRedisConnected } from '../src/cache/client.js';
import { getCached, entityCacheKey } from '../src/cache/helpers.js';
// resolveEntityUpstream: SOS portal → EDGAR fallback (when state-of-incorporation matches)
// This is the full resolution chain used by entity_lookup at runtime.
import { resolveEntityUpstream } from '../src/resolvers/entity-resolver.js';

// resolveEntityUpstream writes to cache internally and calls addToEntityWatchlist

// ── Entity lists ──────────────────────────────────────────────────────────────
// For DE: most Fortune 500 incorporate in Delaware regardless of HQ state.
// For CA/NY/TX: domestic corps OR large companies registered to do biz there.

const PROBE_LIST: Array<{ name: string; jurisdiction: string }> = [
  // ── Delaware (~70% of Fortune 500 incorporate here) ──────────────────────
  { name: 'Amazon.com Inc',                         jurisdiction: 'US-DE' },
  { name: 'Alphabet Inc',                           jurisdiction: 'US-DE' },
  { name: 'Meta Platforms Inc',                     jurisdiction: 'US-DE' },
  { name: 'Tesla Inc',                              jurisdiction: 'US-DE' },
  { name: 'JPMorgan Chase & Co',                    jurisdiction: 'US-DE' },
  { name: 'Pfizer Inc',                             jurisdiction: 'US-DE' },
  { name: 'Visa Inc',                               jurisdiction: 'US-DE' },
  { name: 'Oracle Corporation',                     jurisdiction: 'US-DE' },
  { name: 'Uber Technologies Inc',                  jurisdiction: 'US-DE' },
  { name: 'Airbnb Inc',                             jurisdiction: 'US-DE' },
  { name: 'Stripe Inc',                             jurisdiction: 'US-DE' },
  { name: 'PayPal Holdings Inc',                    jurisdiction: 'US-DE' },
  { name: 'Walmart Inc',                            jurisdiction: 'US-DE' },
  { name: 'Home Depot Inc',                         jurisdiction: 'US-DE' },
  { name: 'Costco Wholesale Corporation',           jurisdiction: 'US-DE' },

  // ── California ─────────────────────────────────────────────────────────────
  // Companies whose EDGAR stateOfIncorporation = CA (confirmed).
  // CA BizFile is Incapsula-protected — these resolve via EDGAR fallback.
  { name: 'Apple Inc',                              jurisdiction: 'US-CA' },
  { name: 'PG&E Corp',                              jurisdiction: 'US-CA' },
  { name: 'PG&E Corporation',                       jurisdiction: 'US-CA' },
  { name: 'Edison International',                   jurisdiction: 'US-CA' },
  { name: 'Southern California Edison Company',     jurisdiction: 'US-CA' },

  // ── New York ──────────────────────────────────────────────────────────────
  // NY DOS dataset (n9v6-gdp6) covers domestic NY corps and foreign corps registered in NY.
  { name: 'Corning Incorporated',                   jurisdiction: 'US-NY' },
  { name: 'New York Life Insurance Company',        jurisdiction: 'US-NY' },
  { name: 'Consolidated Edison Company of New York', jurisdiction: 'US-NY' },
  { name: 'Regeneron Pharmaceuticals Inc',          jurisdiction: 'US-NY' },
  { name: 'Loews Corporation',                      jurisdiction: 'US-NY' },

  // ── Texas ─────────────────────────────────────────────────────────────────
  { name: 'AT&T Inc',                               jurisdiction: 'US-TX' },
  { name: 'ConocoPhillips Company',                 jurisdiction: 'US-TX' },
  { name: 'Sysco Corporation',                      jurisdiction: 'US-TX' },
  { name: 'Texas Instruments Incorporated',         jurisdiction: 'US-TX' },
  { name: 'Enterprise Products Company',             jurisdiction: 'US-TX' },
  { name: 'Halliburton Company',                    jurisdiction: 'US-TX' },
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(s: string, n: number): string {
  return s.padEnd(n).slice(0, n);
}

interface ProbeResult {
  name: string;
  jurisdiction: string;
  found: boolean;
  source: string;
  status: string;
  confidence: number;
  incorporated_at: string | null;
  cached: boolean;
  error: string | null;
}

async function probeOne(name: string, jurisdiction: string): Promise<ProbeResult> {
  let errorMsg: string | null = null;
  let cached = false;

  // resolveEntityUpstream covers: SOS portal → EDGAR (when state-of-incorporation matches)
  // It also writes to cache internally (name key + entity:id reverse-index)
  const result = await resolveEntityUpstream(name, jurisdiction).catch((err: unknown) => {
    errorMsg = err instanceof Error ? err.message : String(err);
    return null;
  });

  const realResult = result && result.confidence > 0 ? result : null;

  if (realResult) {
    // Verify that resolveEntityUpstream wrote to cache
    try {
      const readback = await getCached(entityCacheKey(jurisdiction, name));
      cached = readback !== null;
    } catch {
      // Best-effort verification
    }
  }

  return {
    name,
    jurisdiction,
    found: !!realResult,
    source: realResult?.source ?? (result ? `stub(conf=0)` : '—'),
    status: realResult?.status ?? '—',
    confidence: realResult?.confidence ?? 0,
    incorporated_at: realResult?.incorporated_at ?? null,
    cached,
    error: errorMsg,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

await connectRedis();

const stateArg = process.argv
  .find((a) => a.startsWith('--state='))
  ?.split('=')[1]
  ?.toUpperCase();

const entities = stateArg
  ? PROBE_LIST.filter((e) => e.jurisdiction === `US-${stateArg}`)
  : PROBE_LIST;

if (entities.length === 0) {
  console.error(`No probe entries for --state=${stateArg}. Valid: DE CA NY TX`);
  process.exit(1);
}

console.log(`\n${'═'.repeat(90)}`);
console.log('  CorpSignal SOS Scraper Probe');
console.log(`  ${entities.length} entities across ${[...new Set(entities.map((e) => e.jurisdiction))].join(', ')}`);
console.log(`  Redis: ${isRedisConnected() ? 'connected (cache writes active)' : 'not connected (fetch-only mode)'}`);
console.log(`${'═'.repeat(90)}\n`);

// Run in small batches to respect per-source rate limits
const BATCH = 3;
const allResults: ProbeResult[] = [];

for (let i = 0; i < entities.length; i += BATCH) {
  const batch = entities.slice(i, i + BATCH);
  const batchResults = await Promise.all(batch.map((e) => probeOne(e.name, e.jurisdiction)));
  allResults.push(...batchResults);
  process.stdout.write(
    batchResults
      .map((r) => `  ${r.found ? '✓' : '✗'} ${r.name} (${r.jurisdiction}) → ${r.source}`)
      .join('\n') + '\n',
  );
  if (i + BATCH < entities.length) await new Promise((r) => setTimeout(r, 600));
}

// ── Summary table ─────────────────────────────────────────────────────────────

const C = { name: 38, jur: 6, src: 30, conf: 5, inc: 12, cache: 6 };
const SEP = '─'.repeat(C.name + C.jur + C.src + C.conf + C.inc + C.cache + 14);

console.log(`\n${SEP}`);
console.log(
  `  ${pad('Entity', C.name)}  ${pad('State', C.jur)}  ${pad('Source', C.src)}  ${pad('Conf', C.conf)}  ${pad('Incorp', C.inc)}  Cache`,
);
console.log(SEP);

// Group by state
const grouped = new Map<string, ProbeResult[]>();
for (const r of allResults) {
  const g = grouped.get(r.jurisdiction) ?? [];
  g.push(r);
  grouped.set(r.jurisdiction, g);
}

let totalHits = 0;
let totalCached = 0;

for (const [jur, rows] of [...grouped.entries()].sort()) {
  for (const r of rows) {
    const mark = r.found ? '✓' : '✗';
    const cacheCell = r.cached ? ' ✓' : r.found ? ' ?' : '  ';
    const incorp = r.incorporated_at?.slice(0, 10) ?? '—';
    const errNote = r.error ? ` [${r.error.slice(0, 30)}]` : '';
    console.log(
      `${mark} ${pad(r.name, C.name)}  ${pad(jur, C.jur)}  ${pad(r.source + errNote, C.src)}  ${r.confidence.toFixed(2).padEnd(C.conf)}  ${pad(incorp, C.inc)}  ${cacheCell}`,
    );
    if (r.found) totalHits++;
    if (r.cached) totalCached++;
  }
}

console.log(SEP);

// Per-state totals
const stateTotals: Record<string, { hits: number; total: number }> = {};
for (const r of allResults) {
  if (!stateTotals[r.jurisdiction]) stateTotals[r.jurisdiction] = { hits: 0, total: 0 };
  stateTotals[r.jurisdiction]!.total++;
  if (r.found) stateTotals[r.jurisdiction]!.hits++;
}

console.log('\nPer-state results:');
for (const [state, { hits, total }] of Object.entries(stateTotals).sort()) {
  const bar = '█'.repeat(hits) + '░'.repeat(total - hits);
  console.log(`  ${state}  ${bar}  ${hits}/${total}`);
}

console.log(`\nTotal: ${totalHits}/${allResults.length} found   ${totalCached}/${totalHits} cache writes confirmed`);

if (!isRedisConnected()) {
  console.log('\nNote: Redis not connected — entities were fetched successfully but not persisted.');
  console.log('      Set REDIS_URL and re-run to populate the cache.');
}

process.exit(totalHits > 0 ? 0 : 1);
