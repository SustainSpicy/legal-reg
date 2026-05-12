// Florida Division of Corporations — SunBiz
// Public search: https://search.sunbiz.org
// Returns HTML; we parse the results table.
// No API key required.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const FL_SEARCH_BASE = 'https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResults';

function mapFLStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s === 'active') return 'active';
  if (s.includes('dissol') || s.includes('inactiv') || s.includes('revok')) return 'dissolved';
  if (s.includes('delinq')) return 'suspended';
  return 'unknown';
}

// Extract <td> text cells from the first table in the HTML.
function parseResultsTable(html: string): string[][] {
  const tableMatch = /<table[^>]*>[\s\S]*?<\/table>/i.exec(html);
  if (!tableMatch) return [];

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[][] = [];
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = rowRe.exec(tableMatch[0])) !== null) {
    if (first) { first = false; continue; } // skip header
    const cells = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((c) => c[1]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

export async function lookupFloridaEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  const params = new URLSearchParams({
    SearchTerm: entityName,
    SearchType: 'EntityName',
    SearchNameOrder: 'BEGINS',
  });

  const res = await fetch(`${FL_SEARCH_BASE}?${params.toString()}`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent': 'Mozilla/5.0 (compatible; CorpSignal/1.0; +https://corpsignal.com)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://search.sunbiz.org/Inquiry/CorporationSearch/ByName',
    },
  }).catch(() => null);

  if (!res?.ok) return null;

  // Try JSON first (some SunBiz endpoints still return JSON)
  const contentType = res.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => null) as { Items?: Array<{ EntityName: string; DocumentNumber: string; Status: string; FiledDate: string | null }> } | null;
    const results = data?.Items ?? [];
    if (results.length === 0) return null;

    const normQuery = normaliseName(entityName);
    const best = results
      .map((r) => ({ r, score: normaliseName(r.EntityName) === normQuery ? 1 : 0.8 }))
      .sort((a, b) => b.score - a.score)[0];
    if (!best) return null;

    return {
      entity_id: generateEntityId('US-FL', best.r.EntityName),
      canonical_name: best.r.EntityName,
      jurisdiction: 'US-FL',
      status: mapFLStatus(best.r.Status),
      incorporated_at: best.r.FiledDate ?? null,
      registered_agent: null,
      officers: [],
      source: 'florida_sunbiz',
      source_url: `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?documentId=${best.r.DocumentNumber}`,
      freshness_secs: 0,
      confidence: best.score,
      data_freshness: 'fresh',
    };
  }

  // HTML fallback — parse results table
  const html = await res.text().catch(() => null);
  if (!html) return null;

  const rows = parseResultsTable(html);
  if (rows.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best = rows
    .map((r) => ({ r, score: normaliseName(r[0] ?? '') === normQuery ? 1 : 0.8 }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;

  // SunBiz HTML table columns: [Entity Name, Document #, Status, Filed Date]
  const [name = entityName, docNum = '', status = '', filedDate = null] = best.r;

  return {
    entity_id: generateEntityId('US-FL', name),
    canonical_name: name,
    jurisdiction: 'US-FL',
    status: mapFLStatus(status),
    incorporated_at: filedDate || null,
    registered_agent: null,
    officers: [],
    source: 'florida_sunbiz',
    source_url: docNum
      ? `https://search.sunbiz.org/Inquiry/CorporationSearch/SearchResultDetail?documentId=${docNum}`
      : 'https://search.sunbiz.org',
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}
