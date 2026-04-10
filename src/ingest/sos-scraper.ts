// Nightly Playwright scraper for the 8 SOS portals with no public API
// Runs at 2am UTC — NEVER triggered by a live agent request
//
// Honest caveat (Phase 3 hardening): 8 of 50 US state SOS portals have no
// public API and require scraping. If the nightly job fails, the cache serves
// stale data with data_freshness: 'stale' and freshness_secs indicating age.

import cron from 'node-cron';
import { setCache, getCached, entityCacheKey } from '../cache/helpers.js';
import { SCRAPE_ONLY_STATES, mapScrapedRecordToEntity } from './sources/sos-portals.js';
import { SCRAPER_CONFIGS } from './sources/sos-scraper-configs.js';
import type { ScrapedSOSRecord } from './sources/sos-portals.js';

export const SCRAPE_TTL_SECS = 86400; // 24 hours

// Playwright is loaded dynamically so the app starts without it when not needed
async function getPlaywright() {
  const { chromium } = await import('playwright');
  return chromium;
}

// Verify that a selector resolves to at least one element within a timeout.
// Returns false (and logs a warning) if the selector never appears — this lets
// us detect broken configs early rather than silently scraping 0 rows.
async function selectorExists(
  page: import('playwright').Page,
  selector: string,
  timeoutMs = 5000,
): Promise<boolean> {
  try {
    await page.waitForSelector(selector, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

async function scrapeJurisdiction(jurisdiction: string): Promise<number> {
  const config = SCRAPER_CONFIGS.find((c) => c.jurisdiction === jurisdiction);
  if (!config) {
    console.warn(`[scraper] No config found for ${jurisdiction}`);
    return 0;
  }

  const chromium = await getPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let scraped = 0;
  let rowErrors = 0;

  try {
    await page.goto(config.searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Verify the search input exists before trying to interact with it
    const inputExists = await selectorExists(page, config.searchInputSelector, 8000);
    if (!inputExists) {
      console.error(
        `[scraper] ${jurisdiction}: search input '${config.searchInputSelector}' not found — ` +
        'portal HTML may have changed. Skipping.',
      );
      return 0;
    }

    const searchInput = page.locator(config.searchInputSelector).first();
    await searchInput.fill('%'); // Wildcard — supported by most portals for bulk fetch

    const searchBtn = page.locator(config.searchButtonSelector).first();
    await searchBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    // Verify result rows appeared
    const rowsExist = await selectorExists(page, config.resultRowSelector, 8000);
    if (!rowsExist) {
      console.warn(`[scraper] ${jurisdiction}: no result rows found for selector '${config.resultRowSelector}' — wildcard search may be unsupported, trying 'A'`);

      // Retry with 'A' prefix — catches portals that don't accept wildcards
      await searchInput.fill('A');
      await searchBtn.click();
      await page.waitForLoadState('networkidle', { timeout: 15000 });

      const retryExists = await selectorExists(page, config.resultRowSelector, 5000);
      if (!retryExists) {
        console.error(`[scraper] ${jurisdiction}: still no rows after retry — selector may be stale. Skipping.`);
        return 0;
      }
    }

    let pageNum = 0;
    const maxPages = config.pagination?.maxPages ?? 1;

    while (pageNum < maxPages) {
      const rows = await page.locator(config.resultRowSelector).all();

      for (const row of rows) {
        try {
          const name = (await row.locator(config.fields.name).textContent())?.trim();
          if (!name) continue;

          const rawStatus = config.fields.status
            ? (await row.locator(config.fields.status).textContent())?.trim() ?? 'unknown'
            : 'unknown';

          const incorporatedAt = config.fields.incorporatedAt
            ? (await row.locator(config.fields.incorporatedAt).textContent())?.trim() ?? null
            : null;

          const record: ScrapedSOSRecord = {
            entity_name: name,
            jurisdiction,
            status: rawStatus,
            incorporated_at: incorporatedAt,
            registered_agent_name: null,
            registered_agent_address: null,
          };

          const entity = mapScrapedRecordToEntity(record);
          const key = entityCacheKey(jurisdiction, name);
          await setCache(key, entity, SCRAPE_TTL_SECS);
          scraped++;
        } catch {
          rowErrors++;
          // Budget: if more than 20% of rows on a page are failing, the selector
          // is probably wrong — abort this jurisdiction rather than caching garbage.
          if (rows.length > 5 && rowErrors / rows.length > 0.2) {
            console.error(
              `[scraper] ${jurisdiction}: >20% row parse failures (${rowErrors}/${rows.length}) — ` +
              'field selectors may be stale. Aborting this jurisdiction.',
            );
            return scraped;
          }
        }
      }

      // Pagination
      if (config.pagination && pageNum < maxPages - 1) {
        const nextBtn = page.locator(config.pagination.nextButtonSelector);
        const isDisabled = await nextBtn.isDisabled().catch(() => true);
        if (isDisabled) break;
        await nextBtn.click();
        await page.waitForLoadState('networkidle', { timeout: 10000 });
        pageNum++;
        rowErrors = 0; // Reset error budget per page
      } else {
        break;
      }
    }
  } finally {
    await browser.close();
  }

  return scraped;
}

/**
 * Scrape a single entity by name from a no-API state portal.
 * Used as on-demand fallback when the nightly cache is cold for a specific entity.
 * Returns null if not found or scrape fails.
 */
export async function scrapeEntityOnDemand(
  entityName: string,
  jurisdiction: string,
): Promise<import('../schemas/entity.js').EntityLookupOutputType | null> {
  const config = SCRAPER_CONFIGS.find((c) => c.jurisdiction === jurisdiction);
  if (!config) return null;

  // Check cache first — nightly job may have already seeded this entity
  const cached = await getCached<import('../schemas/entity.js').EntityLookupOutputType>(
    entityCacheKey(jurisdiction, entityName),
  );
  if (cached) return cached;

  const chromium = await getPlaywright();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    await page.goto(config.searchUrl, { waitUntil: 'networkidle', timeout: 30000 });

    const inputExists = await selectorExists(page, config.searchInputSelector, 8000);
    if (!inputExists) {
      console.error(`[scraper] on-demand ${jurisdiction}: input selector '${config.searchInputSelector}' not found`);
      return null;
    }

    const searchInput = page.locator(config.searchInputSelector).first();
    await searchInput.fill(entityName);

    const searchBtn = page.locator(config.searchButtonSelector).first();
    await searchBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15000 });

    const rowsExist = await selectorExists(page, config.resultRowSelector, 8000);
    if (!rowsExist) return null;

    const rows = await page.locator(config.resultRowSelector).all();
    if (rows.length === 0) return null;

    const firstRow = rows[0]!;
    const name = (await firstRow.locator(config.fields.name).textContent())?.trim();
    if (!name) return null;

    const rawStatus = config.fields.status
      ? (await firstRow.locator(config.fields.status).textContent())?.trim() ?? 'unknown'
      : 'unknown';

    const incorporatedAt = config.fields.incorporatedAt
      ? (await firstRow.locator(config.fields.incorporatedAt).textContent())?.trim() ?? null
      : null;

    const record: ScrapedSOSRecord = {
      entity_name: name,
      jurisdiction,
      status: rawStatus,
      incorporated_at: incorporatedAt,
      registered_agent_name: null,
      registered_agent_address: null,
    };

    const entity = mapScrapedRecordToEntity(record);
    await setCache(entityCacheKey(jurisdiction, name), entity, SCRAPE_TTL_SECS);
    return entity;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[scraper] On-demand scrape failed for ${entityName} (${jurisdiction}): ${msg}`);
    return null;
  } finally {
    await browser.close();
  }
}

async function runNightlyScrape(): Promise<void> {
  console.log('[scraper] Starting nightly SOS scrape for no-API states...');
  let totalScraped = 0;

  for (const jurisdiction of SCRAPE_ONLY_STATES) {
    try {
      console.log(`[scraper] Scraping ${jurisdiction}...`);
      const count = await scrapeJurisdiction(jurisdiction);
      totalScraped += count;
      console.log(`[scraper] ${jurisdiction}: ${count} entities cached`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Non-fatal — other states continue, stale cache serves this one
      console.error(`[scraper] ${jurisdiction} failed: ${msg} — serving stale cache`);
    }
  }

  console.log(`[scraper] Nightly scrape complete. Total entities cached: ${totalScraped}`);
}

// Runs at 2am UTC every night
export function startSOSScraperCron(): void {
  cron.schedule('0 2 * * *', () => {
    void runNightlyScrape();
  });
  console.log(`[scraper] Cron scheduled: nightly 2am UTC for ${SCRAPE_ONLY_STATES.join(', ')}`);
}
