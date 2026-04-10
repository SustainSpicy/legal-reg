// Background sanctions ingestion — runs every 6 hours
// NEVER triggered by a live agent request

import cron from 'node-cron';
import { fetchOFACSDN, fetchOFACConsolidated } from './sources/ofac.js';
import { fetchUNList } from './sources/un.js';
import { fetchEUCFSP } from './sources/eu-cfsp.js';
import { fetchHMTreasury } from './sources/hm-treasury.js';
import { fetchFinCEN } from './sources/fincen.js';
import { setCache, sanctionsCacheKey } from '../cache/helpers.js';

const LIST_TTL_SECS = 21600; // 6 hours
const MAX_RETRIES = 4;
const RETRY_BASE_MS = 2000; // 2s, 4s, 8s, 16s

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ingestList<T>(
  name: string,
  fetcher: () => Promise<T[]>,
  cacheKey: string,
  attempt = 1,
): Promise<void> {
  try {
    console.log(`[ingest:sanctions] Refreshing ${name}${attempt > 1 ? ` (attempt ${attempt})` : ''}...`);
    const data = await fetcher();
    await setCache(cacheKey, data, LIST_TTL_SECS);
    console.log(`[ingest:sanctions] ${name} — ${data.length} entries cached`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`[ingest:sanctions] ${name} failed (${msg}) — retrying in ${delay}ms`);
      await sleep(delay);
      return ingestList(name, fetcher, cacheKey, attempt + 1);
    }
    console.error(`[ingest:sanctions] ${name} failed after ${MAX_RETRIES} attempts: ${msg} — serving stale cache`);
  }
}

export async function runSanctionsIngest(): Promise<void> {
  await Promise.all([
    ingestList('OFAC_SDN', fetchOFACSDN, sanctionsCacheKey('OFAC_SDN')),
    ingestList('OFAC_CONS', fetchOFACConsolidated, sanctionsCacheKey('OFAC_CONS')),
    ingestList('UN_1267', fetchUNList, sanctionsCacheKey('UN_1267')),
    ingestList('EU_CFSP', fetchEUCFSP, sanctionsCacheKey('EU_CFSP')),
    ingestList('HM_TREASURY', fetchHMTreasury, sanctionsCacheKey('HM_TREASURY')),
    ingestList('FinCEN', fetchFinCEN, sanctionsCacheKey('FinCEN')),
  ]);
}

// Run every 6 hours — OFAC updates ~daily, others weekly
export function startSanctionsIngestCron(): void {
  cron.schedule('0 */6 * * *', () => {
    void runSanctionsIngest();
  });
  console.log('[ingest:sanctions] Cron scheduled: every 6 hours');
}
