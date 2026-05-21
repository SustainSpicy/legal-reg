// Delaware ICIS (Integrated Corporate Information System)
// Official portal: https://icis.corp.delaware.gov
// No public REST API — scrapes the WebForms portal.
// Delaware is the most important US jurisdiction (~70% of Fortune 500 incorporate here).
//
// Lookup order:
//   1. OpenCorporates API — indexes ICIS directly; requires OPENCORPORATES_API_TOKEN
//   2. ICIS 3-step scrape — GET form state, POST search, POST detail postback
//
// ICIS form notes (updated 2025):
//   • Submit button: ctl00$ContentPlaceHolder1$btnSubmit  (was btnSearch)
//   • Entity name:   ctl00$ContentPlaceHolder1$frmEntityName  (was txtEntityName)
//   • Results table: id="tblResults" with span[id$=lblFileNumber] + anchor[data-ca]
//   • Detail via:    __doPostBack postback from search results VIEWSTATE (no direct URL)

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { lookupViaOpenCorporates } from './opencorporates.js';

const ICIS_URL = 'https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx';
// Direct entity permalink — discovered from form action="SearchDetailsPage.aspx?i={fileNumber}"
// in the detail postback response. Stable per-entity deep link.
const ICIS_DETAIL_URL = 'https://icis.corp.delaware.gov/Ecorp/EntitySearch/SearchDetailsPage.aspx';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// Per-step timeout — 3 steps × 8 s = 24 s max, keeping chained calls under 30 s
const ICIS_STEP_TIMEOUT_MS = 8_000;

// Per-process semaphore — prevents IP bans under concurrent load
let icisActive = 0;
const ICIS_MAX_CONCURRENT = 2;

async function acquireIcisSlot(): Promise<void> {
  while (icisActive >= ICIS_MAX_CONCURRENT) {
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  icisActive++;
}

function releaseIcisSlot(): void {
  icisActive = Math.max(0, icisActive - 1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectHiddens(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
    const nameM = /name="([^"]+)"/.exec(m[0]);
    const valM = /value="([^"]*)"/.exec(m[0]);
    if (nameM) out[nameM[1]] = valM?.[1] ?? '';
  }
  return out;
}

function parseCookies(headers: Headers): string {
  const cookies = headers.getSetCookie?.() ?? [];
  return cookies.map((c) => c.split(';')[0]?.trim() ?? '').filter(Boolean).join('; ');
}

interface ICISResult {
  file_number: string;
  entity_name: string;
  status: EntityLookupOutputType['status'];
  event_target: string;
}

function parseSearchResults(html: string): ICISResult[] {
  const results: ICISResult[] = [];

  const tblMatch = /<table[^>]*id="tblResults"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tblMatch) return results;

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowM: RegExpExecArray | null;
  let first = true;

  while ((rowM = rowRe.exec(tblMatch[1]!)) !== null) {
    if (first) { first = false; continue; }

    const fileM = /lblFileNumber[^>]*>(\d+)<\/span>/.exec(rowM[1]!);
    const nameM = /<a[^>]*>([^<]+)<\/a>/.exec(rowM[1]!);
    const caM = /data-ca="(True|False)"/.exec(rowM[1]!);
    const idM = /id="([^"]*lnkbtnEntityName[^"]*)"/.exec(rowM[1]!);

    const fileNum = fileM?.[1];
    const entityName = nameM?.[1]?.trim();
    if (!fileNum || !entityName) continue;

    const cancelled = caM?.[1] === 'True';
    const status: EntityLookupOutputType['status'] = cancelled ? 'dissolved' : 'active';

    // ID uses _ separators; postback event target uses $
    const eventTarget = (idM?.[1] ?? '').replace(/_/g, '$');

    results.push({ file_number: fileNum, entity_name: entityName, status, event_target: eventTarget });
  }

  return results;
}

interface DetailInfo {
  incorporated_at: string | null;
  registered_agent: EntityLookupOutputType['registered_agent'];
  status: EntityLookupOutputType['status'] | null;
}

function parseDetailHtml(html: string): DetailInfo {
  // ICIS detail page uses ContentPlaceHolder1 lbl* span IDs (confirmed against live 2025 HTML).
  // The form action on the detail page is SearchDetailsPage.aspx?i={fileNumber}, which gives
  // us the stable per-entity permalink used as source_url.
  function spanVal(id: string): string | null {
    const re = new RegExp(`id="${id}"[^>]*>([^<]*)<`, 'i');
    return re.exec(html)?.[1]?.trim() || null;
  }

  const agentName = spanVal('ctl00_ContentPlaceHolder1_lblAgentName');
  const addr1     = spanVal('ctl00_ContentPlaceHolder1_lblAgentAddress1');
  const city      = spanVal('ctl00_ContentPlaceHolder1_lblAgentCity');
  const state     = spanVal('ctl00_ContentPlaceHolder1_lblAgentState');
  const zip       = spanVal('ctl00_ContentPlaceHolder1_lblAgentPostalCode');
  const incDate   = spanVal('ctl00_ContentPlaceHolder1_lblIncDate');

  const addressParts = [addr1, city, state, zip].filter(Boolean);
  const agentAddr = addressParts.length > 0 ? addressParts.join(', ') : null;

  // Status is rendered as visible text — ICIS uses "GOOD STANDING", "VOID", etc.
  let status: EntityLookupOutputType['status'] | null = null;
  if (/good standing/i.test(html)) status = 'active';
  else if (/\b(?:void|cancel|dissol)/i.test(html)) status = 'dissolved';
  else if (/suspend/i.test(html)) status = 'suspended';

  return {
    incorporated_at: incDate,
    registered_agent: agentName ? { name: agentName, address: agentAddr ?? '' } : null,
    status,
  };
}

// ---------------------------------------------------------------------------
// ICIS 3-step scrape
// ---------------------------------------------------------------------------

export async function searchDelawareEntities(entityName: string): Promise<ICISResult[]> {
  // Step 1: GET — acquire session cookie + VIEWSTATE
  const initRes = await fetch(ICIS_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(ICIS_STEP_TIMEOUT_MS),
  });
  if (!initRes.ok) throw new Error(`ICIS init failed: ${initRes.status}`);
  const cookies1 = parseCookies(initRes.headers);
  const initHtml = await initRes.text();
  const hiddens1 = collectHiddens(initHtml);

  // Step 2: POST search
  const searchBody = new URLSearchParams({
    ...hiddens1,
    'ctl00$ContentPlaceHolder1$frmEntityName': entityName,
    'ctl00$ContentPlaceHolder1$btnSubmit': 'Search',
    'email_confirm': '',  // honeypot — must be empty
  });

  const searchRes = await fetch(ICIS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': ICIS_URL,
      'Origin': 'https://icis.corp.delaware.gov',
      'Cookie': cookies1,
    },
    body: searchBody.toString(),
    signal: AbortSignal.timeout(ICIS_STEP_TIMEOUT_MS),
  });
  if (!searchRes.ok) throw new Error(`ICIS search failed: ${searchRes.status}`);
  const searchHtml = await searchRes.text();

  return parseSearchResults(searchHtml);
}

async function fetchICISDetail(
  searchHtml: string,
  searchCookies: string,
  result: ICISResult,
): Promise<DetailInfo> {
  if (!result.event_target) return { incorporated_at: null, registered_agent: null, status: null };

  const hiddens2 = collectHiddens(searchHtml);
  const detailBody = new URLSearchParams({
    ...hiddens2,
    '__EVENTTARGET': result.event_target,
    '__EVENTARGUMENT': '',
    'email_confirm': '',
  });

  const detailRes = await fetch(ICIS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,*/*;q=0.8',
      'Referer': ICIS_URL,
      'Origin': 'https://icis.corp.delaware.gov',
      'Cookie': searchCookies,
    },
    body: detailBody.toString(),
    signal: AbortSignal.timeout(ICIS_STEP_TIMEOUT_MS),
  });
  if (!detailRes.ok) return { incorporated_at: null, registered_agent: null, status: null };

  return parseDetailHtml(await detailRes.text());
}

// ---------------------------------------------------------------------------
// Full ICIS lookup (search + optional detail)
// ---------------------------------------------------------------------------

async function lookupDelawareEntityViaICIS(entityName: string): Promise<EntityLookupOutputType | null> {
  // Step 1+2: GET + search POST
  const initRes = await fetch(ICIS_URL, {
    headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
    signal: AbortSignal.timeout(ICIS_STEP_TIMEOUT_MS),
  });
  if (!initRes.ok) throw new Error(`ICIS init failed: ${initRes.status}`);
  const cookies1 = parseCookies(initRes.headers);
  const initHtml = await initRes.text();
  const hiddens1 = collectHiddens(initHtml);

  // Search with suffix-stripped base name so ICIS returns the canonical parent entity.
  // "Tesla Inc" → "Tesla" ensures "TESLA, INC." appears in results alongside subsidiaries;
  // we then require an exact normalized match to select — rejecting SPVs and unrelated entities.
  const normBase = normaliseName(entityName);
  const searchTerm = normBase
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || entityName;

  const searchBody = new URLSearchParams({
    ...hiddens1,
    'ctl00$ContentPlaceHolder1$frmEntityName': searchTerm,
    'ctl00$ContentPlaceHolder1$btnSubmit': 'Search',
    'email_confirm': '',
  });

  const searchRes = await fetch(ICIS_URL, {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9',
      'Referer': ICIS_URL, 'Origin': 'https://icis.corp.delaware.gov', 'Cookie': cookies1,
    },
    body: searchBody.toString(),
    signal: AbortSignal.timeout(ICIS_STEP_TIMEOUT_MS),
  });
  if (!searchRes.ok) throw new Error(`ICIS search failed: ${searchRes.status}`);

  const searchCookies2 = parseCookies(searchRes.headers);
  const allCookies = [cookies1, searchCookies2].filter(Boolean).join('; ');
  const searchHtml = await searchRes.text();

  const results = parseSearchResults(searchHtml);
  if (results.length === 0) return null;

  // Require exact normalized match — a fuzzy first-hit produces wrong entities
  // (e.g. "Tesla Inc" → "TESLA 2014 WAREHOUSE SPV LLC" instead of "TESLA, INC.")
  const normQuery = normaliseName(entityName);
  const exactMatch = results.find((r) => normaliseName(r.entity_name) === normQuery);
  if (!exactMatch) return null;

  // Step 3: detail postback for registered_agent + incorporated_at + status
  let detail: DetailInfo = { incorporated_at: null, registered_agent: null, status: null };
  if (exactMatch.event_target) {
    detail = await fetchICISDetail(searchHtml, allCookies, exactMatch).catch(() => ({
      incorporated_at: null, registered_agent: null, status: null,
    }));
  }

  const status = detail.status ?? exactMatch.status;
  // Direct entity permalink — form action on detail page is SearchDetailsPage.aspx?i={fileNumber}
  const sourceUrl = `${ICIS_DETAIL_URL}?i=${encodeURIComponent(exactMatch.file_number)}`;

  return {
    entity_id: generateEntityId('US-DE', exactMatch.entity_name),
    canonical_name: exactMatch.entity_name,
    jurisdiction: 'US-DE',
    status,
    incorporated_at: detail.incorporated_at ?? null,
    registered_agent: detail.registered_agent ?? null,
    officers: [], // ICIS does not expose officer data via its public search interface
    source: 'delaware_sos',
    source_url: sourceUrl,
    freshness_secs: 0,
    confidence: 1.0,
    data_freshness: 'fresh',
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function lookupDelawareEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  // OpenCorporates indexes ICIS directly — try first if API token is configured
  if (process.env['OPENCORPORATES_API_TOKEN']) {
    const ocResult = await lookupViaOpenCorporates(entityName, 'US-DE').catch(() => null);
    if (ocResult) return ocResult;
  }

  // Direct ICIS scrape — 3-step flow (GET form → POST search → POST detail)
  // Rate-limited to ICIS_MAX_CONCURRENT concurrent requests to prevent IP bans
  await acquireIcisSlot();
  try {
    return await lookupDelawareEntityViaICIS(entityName).catch(() => null);
  } finally {
    releaseIcisSlot();
  }
}
