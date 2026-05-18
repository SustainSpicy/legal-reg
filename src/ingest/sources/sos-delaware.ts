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
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

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
  // Detail page span IDs vary — try several patterns
  const agentM = /<span[^>]*(?:RegisteredAgent|Resident\s*Agent)[^>]*>([^<]+)<\/span>/i.exec(html)
    ?? /<td[^>]*>Registered\s*Agent<\/td>\s*<td[^>]*>([^<]+)<\/td>/i.exec(html);
  const officeM = /<span[^>]*(?:RegisteredOffice|Resident\s*Office)[^>]*>([^<]+)<\/span>/i.exec(html)
    ?? /<td[^>]*>Registered\s*Office<\/td>\s*<td[^>]*>([^<]+)<\/td>/i.exec(html);
  const statusM = /<span[^>]*EntityStatus[^>]*>([^<]+)<\/span>/i.exec(html)
    ?? /<td[^>]*>Entity\s*Status<\/td>\s*<td[^>]*>([^<]+)<\/td>/i.exec(html);
  const incM = /<span[^>]*(?:IncorporationDate|DateOfFormation)[^>]*>([^<]+)<\/span>/i.exec(html)
    ?? /<td[^>]*>(?:Incorporation|Formation)\s*Date<\/td>\s*<td[^>]*>([^<]+)<\/td>/i.exec(html);

  const agentName = agentM?.[1]?.trim() ?? null;
  const agentAddr = officeM?.[1]?.trim() ?? null;

  const rawStatus = statusM?.[1]?.trim().toLowerCase() ?? '';
  let status: EntityLookupOutputType['status'] | null = null;
  if (rawStatus) {
    if (rawStatus.includes('good standing') || rawStatus === 'active') status = 'active';
    else if (rawStatus.includes('void') || rawStatus.includes('cancel') || rawStatus.includes('dissol')) status = 'dissolved';
    else if (rawStatus.includes('suspend')) status = 'suspended';
    else status = 'unknown';
  }

  return {
    incorporated_at: incM?.[1]?.trim() ?? null,
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
  });
  if (!initRes.ok) throw new Error(`ICIS init failed: ${initRes.status}`);
  const cookies1 = parseCookies(initRes.headers);
  const initHtml = await initRes.text();
  const hiddens1 = collectHiddens(initHtml);

  const searchBody = new URLSearchParams({
    ...hiddens1,
    'ctl00$ContentPlaceHolder1$frmEntityName': entityName,
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
  });
  if (!searchRes.ok) throw new Error(`ICIS search failed: ${searchRes.status}`);

  const searchCookies2 = parseCookies(searchRes.headers);
  const allCookies = [cookies1, searchCookies2].filter(Boolean).join('; ');
  const searchHtml = await searchRes.text();

  const results = parseSearchResults(searchHtml);
  if (results.length === 0) return null;

  // Pick best match by name similarity
  const normQuery = normaliseName(entityName);
  const scored = results.map((r) => ({
    r,
    score: normaliseName(r.entity_name) === normQuery ? 1.0 : 0.85,
  })).sort((a, b) => b.score - a.score);

  const best = scored[0]!;

  // Step 3: detail postback for registered_agent + incorporated_at
  let detail: DetailInfo = { incorporated_at: null, registered_agent: null, status: null };
  if (best.r.event_target) {
    detail = await fetchICISDetail(searchHtml, allCookies, best.r).catch(() => ({
      incorporated_at: null, registered_agent: null, status: null,
    }));
  }

  const status = detail.status ?? best.r.status;

  return {
    entity_id: generateEntityId('US-DE', best.r.entity_name),
    canonical_name: best.r.entity_name,
    jurisdiction: 'US-DE',
    status,
    incorporated_at: detail.incorporated_at ?? null,
    registered_agent: detail.registered_agent ?? null,
    officers: [],
    source: 'delaware_sos',
    source_url: `https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx`,
    freshness_secs: 0,
    confidence: best.score,
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
  return lookupDelawareEntityViaICIS(entityName).catch(() => null);
}
