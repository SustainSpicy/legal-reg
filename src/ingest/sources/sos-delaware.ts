// Delaware ICIS (Integrated Corporate Information System)
// Official portal: https://icis.corp.delaware.gov
// No public REST API — structured HTML responses to POST requests.
// Delaware is the most important US jurisdiction (~70% of Fortune 500 incorporated here).
//
// Lookup order:
//   1. OpenCorporates free API — indexes ICIS directly, works from any IP, covers private companies
//   2. ICIS direct scrape — fallback if OC misses the entity (session cookie preserved correctly)

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { lookupViaOpenCorporates } from './opencorporates.js';

const ICIS_SEARCH_URL = 'https://icis.corp.delaware.gov/Ecorp/EntitySearch/NameSearch.aspx';
const ICIS_DETAIL_URL = 'https://icis.corp.delaware.gov/Ecorp/EntitySearch/EntitySearchResult.aspx';

function extractViewState(html: string): { viewstate: string; eventvalidation: string; generator: string } {
  const vsMatch = /id="__VIEWSTATE"\s+value="([^"]+)"/.exec(html);
  const evMatch = /id="__EVENTVALIDATION"\s+value="([^"]+)"/.exec(html);
  const vsgMatch = /id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/.exec(html);
  return {
    viewstate: vsMatch?.[1] ?? '',
    eventvalidation: evMatch?.[1] ?? '',
    generator: vsgMatch?.[1] ?? '',
  };
}

interface ICISEntity {
  file_number: string;
  entity_name: string;
  status: string;
  incorporation_date: string | null;
  entity_type: string;
}

function parseSearchResults(html: string): ICISEntity[] {
  const results: ICISEntity[] = [];

  const tableMatch = /<table[^>]*id="GridViewEntityInformation"[^>]*>([\s\S]*?)<\/table>/i.exec(html);
  if (!tableMatch) return results;

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  let isHeader = true;

  while ((rowMatch = rowRegex.exec(tableMatch[1]!)) !== null) {
    if (isHeader) { isHeader = false; continue; }

    const cells = [...rowMatch[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((m) => m[1]!.replace(/<[^>]+>/g, '').trim());

    if (cells.length < 3) continue;

    results.push({
      file_number: cells[0] ?? '',
      entity_name: cells[1] ?? '',
      status: cells[2] ?? '',
      incorporation_date: cells[3] ?? null,
      entity_type: cells[4] ?? '',
    });
  }

  return results;
}

function parseEntityDetail(html: string, fileNumber: string): Partial<EntityLookupOutputType> {
  const agentNameMatch = /<span[^>]*id="[^"]*RegisteredAgent[^"]*"[^>]*>([^<]+)<\/span>/i.exec(html);
  const agentAddrMatch = /<span[^>]*id="[^"]*RegisteredOffice[^"]*"[^>]*>([^<]+)<\/span>/i.exec(html);
  const statusMatch = /<span[^>]*id="[^"]*EntityStatus[^"]*"[^>]*>([^<]+)<\/span>/i.exec(html);
  const incDateMatch = /<span[^>]*id="[^"]*IncorporationDate[^"]*"[^>]*>([^<]+)<\/span>/i.exec(html);

  const agentName = agentNameMatch?.[1]?.trim() ?? null;
  const agentAddr = agentAddrMatch?.[1]?.trim() ?? null;
  const rawStatus = statusMatch?.[1]?.trim().toLowerCase() ?? 'unknown';

  let status: EntityLookupOutputType['status'] = 'unknown';
  if (rawStatus.includes('good standing') || rawStatus === 'active') status = 'active';
  else if (rawStatus.includes('void') || rawStatus.includes('cancel')) status = 'dissolved';
  else if (rawStatus.includes('suspend')) status = 'suspended';

  return {
    status,
    incorporated_at: incDateMatch?.[1]?.trim() ?? null,
    registered_agent: agentName ? { name: agentName, address: agentAddr ?? '' } : null,
    source_url: `https://icis.corp.delaware.gov/Ecorp/EntitySearch/EntitySearchResult.aspx?FileNumber=${fileNumber}`,
  };
}

export async function searchDelawareEntities(entityName: string): Promise<ICISEntity[]> {
  // Step 1: GET the search page to grab VIEWSTATE + session cookie
  const initRes = await fetch(ICIS_SEARCH_URL, {
    headers: { 'User-Agent': 'CorpSignal-MCP/1.0' },
  });
  if (!initRes.ok) throw new Error(`ICIS init failed: ${initRes.status}`);
  const initHtml = await initRes.text();
  const { viewstate, eventvalidation, generator } = extractViewState(initHtml);

  // Step 2: POST search, preserving the ASP.NET session cookie from step 1
  const body = new URLSearchParams({
    __VIEWSTATE: viewstate,
    __EVENTVALIDATION: eventvalidation,
    __VIEWSTATEGENERATOR: generator,
    ctl00$ContentPlaceHolder1$txtEntityName: entityName,
    ctl00$ContentPlaceHolder1$btnSearch: 'Search',
    ctl00$ContentPlaceHolder1$SearchType: 'B',
  });

  const searchRes = await fetch(ICIS_SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'CorpSignal-MCP/1.0',
      Referer: ICIS_SEARCH_URL,
      // Session cookie is required for VIEWSTATE validation on ASP.NET
      Cookie: initRes.headers.get('set-cookie') ?? '',
    },
    body: body.toString(),
  });

  if (!searchRes.ok) throw new Error(`ICIS search failed: ${searchRes.status}`);
  const searchHtml = await searchRes.text();
  return parseSearchResults(searchHtml);
}

async function lookupDelawareEntityViaICIS(entityName: string): Promise<EntityLookupOutputType | null> {
  const results = await searchDelawareEntities(entityName);
  if (results.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best = results
    .map((r) => ({ r, score: normaliseName(r.entity_name) === normQuery ? 1 : 0.8 }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best) return null;

  const { r } = best;

  let detail: Partial<EntityLookupOutputType> = {};
  if (r.file_number) {
    try {
      const detailRes = await fetch(
        `${ICIS_DETAIL_URL}?FileNumber=${encodeURIComponent(r.file_number)}`,
        { headers: { 'User-Agent': 'CorpSignal-MCP/1.0' } },
      );
      if (detailRes.ok) {
        detail = parseEntityDetail(await detailRes.text(), r.file_number);
      }
    } catch {
      // Non-fatal — return without detail
    }
  }

  const rawStatus = r.status.toLowerCase();
  let status: EntityLookupOutputType['status'] = detail.status ?? 'unknown';
  if (!detail.status) {
    if (rawStatus.includes('good') || rawStatus === 'active') status = 'active';
    else if (rawStatus.includes('void') || rawStatus.includes('cancel')) status = 'dissolved';
    else if (rawStatus.includes('suspend')) status = 'suspended';
  }

  return {
    entity_id: generateEntityId('US-DE', r.entity_name),
    canonical_name: r.entity_name,
    jurisdiction: 'US-DE',
    status,
    incorporated_at: detail.incorporated_at ?? r.incorporation_date ?? null,
    registered_agent: detail.registered_agent ?? null,
    officers: [],
    source: 'delaware_sos',
    source_url: detail.source_url ?? ICIS_SEARCH_URL,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}

export async function lookupDelawareEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  // OpenCorporates indexes ICIS directly and works from any IP — try first
  const ocResult = await lookupViaOpenCorporates(entityName, 'US-DE').catch(() => null);
  if (ocResult) return ocResult;

  // Fall back to direct ICIS scrape (requires session cookie, may be blocked from VPS)
  return lookupDelawareEntityViaICIS(entityName).catch(() => null);
}
