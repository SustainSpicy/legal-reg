// Colorado Secretary of State — Business Entity Search
// Primary: https://data.colorado.gov/resource/2bgs-cdmr.json (Socrata open data)
// Fallback: SOS direct form search at https://www.sos.state.co.us/biz/
// No API key required.

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

// Known Socrata dataset IDs for Colorado business entity data (try each in order)
const CO_SOCRATA_CANDIDATES = [
  'https://data.colorado.gov/resource/2bgs-cdmr.json',
  'https://data.colorado.gov/resource/gg53-asnr.json', // alternate dataset
];

const CO_SOS_FORM_URL = 'https://www.sos.state.co.us/biz/BusinessEntityResults.do';

interface COEntityRecord {
  entityname: string;
  entityid: string;
  entitystatus: string;
  entitytype: string;
  principaladdress1?: string;
  principalcity?: string;
  principalstate?: string;
  principalzipcode?: string;
  registeredagentname?: string;
  registeredagentaddress1?: string;
  registeredagentcity?: string;
  formationdate?: string;
}

function mapCOStatus(raw: string): EntityLookupOutputType['status'] {
  const s = raw.toLowerCase();
  if (s === 'good standing' || s.includes('active') || s.includes('good')) return 'active';
  if (s.includes('dissolv') || s.includes('withdraw') || s.includes('revok')) return 'dissolved';
  if (s.includes('delinquent') || s.includes('suspend')) return 'suspended';
  return 'unknown';
}

function buildFromRecord(r: COEntityRecord): EntityLookupOutputType {
  const agentAddr = [r.registeredagentaddress1, r.registeredagentcity, 'CO']
    .filter(Boolean)
    .join(', ');

  return {
    entity_id: generateEntityId('US-CO', r.entityname),
    canonical_name: r.entityname,
    jurisdiction: 'US-CO',
    status: mapCOStatus(r.entitystatus),
    incorporated_at: r.formationdate ?? null,
    registered_agent: r.registeredagentname
      ? { name: r.registeredagentname, address: agentAddr }
      : null,
    officers: [],
    source: 'colorado_sos',
    source_url: `https://www.sos.state.co.us/biz/BusinessEntityDetail.do?quitButtonDestination=BusinessEntityResults&nameTyp=ENT&masterFileId=${r.entityid}`,
    freshness_secs: 0,
    confidence: 1,
    data_freshness: 'fresh',
  };
}

async function trySOCrataLookup(entityName: string): Promise<EntityLookupOutputType | null> {
  const escaped = entityName.toUpperCase().replace(/'/g, "''");
  const params = new URLSearchParams({
    '$where': `upper(entityname) like '${escaped}%'`,
    '$limit': '5',
    '$order': 'entityname ASC',
  });

  for (const base of CO_SOCRATA_CANDIDATES) {
    const res = await fetch(`${base}?${params.toString()}`, {
      headers: { 'User-Agent': 'CorpSignal-MCP/1.0' },
    }).catch(() => null);
    if (!res?.ok) continue;

    const records = await res.json().catch(() => null) as COEntityRecord[] | null;
    if (!records || records.length === 0) continue;

    const normQuery = normaliseName(entityName);
    const best = records
      .map((r) => ({ r, score: normaliseName(r.entityname) === normQuery ? 1 : 0.8 }))
      .sort((a, b) => b.score - a.score)[0];
    if (best) return buildFromRecord(best.r);
  }
  return null;
}

// Extract table rows from Colorado SOS HTML results page
function parseCOHtmlTable(html: string): string[][] {
  const tableMatch = /<table[^>]*id="[^"]*results[^"]*"[^>]*>[\s\S]*?<\/table>/i.exec(html)
    ?? /<table[^>]*class="[^"]*results[^"]*"[^>]*>[\s\S]*?<\/table>/i.exec(html)
    ?? /<table[^>]*>[\s\S]*?<\/table>/i.exec(html);
  if (!tableMatch) return [];

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: string[][] = [];
  let m: RegExpExecArray | null;
  let first = true;
  while ((m = rowRe.exec(tableMatch[0])) !== null) {
    if (first) { first = false; continue; }
    const cells = [...m[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((c) => c[1]!.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').trim());
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

async function trySosFormLookup(entityName: string): Promise<EntityLookupOutputType | null> {
  const params = new URLSearchParams({
    nameTyp: 'ENT',
    masterFileId: '',
    entityName,
    btnSearch: 'Search',
  });

  const res = await fetch(`${CO_SOS_FORM_URL}?${params.toString()}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; CorpSignal/1.0; +https://corpsignal.com)',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Referer': 'https://www.sos.state.co.us/biz/',
    },
  }).catch(() => null);

  if (!res?.ok) return null;

  const html = await res.text().catch(() => null);
  if (!html) return null;

  const rows = parseCOHtmlTable(html);
  if (rows.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const best = rows
    .map((r) => ({ r, score: normaliseName(r[0] ?? '') === normQuery ? 1 : 0.8 }))
    .sort((a, b) => b.score - a.score)[0];
  if (!best) return null;

  // CO SOS HTML table columns: [Entity Name, Entity ID, Status, Type, Formation Date]
  const [name = entityName, entityId = '', status = '', , formationDate = null] = best.r;

  return {
    entity_id: generateEntityId('US-CO', name),
    canonical_name: name,
    jurisdiction: 'US-CO',
    status: mapCOStatus(status),
    incorporated_at: formationDate || null,
    registered_agent: null,
    officers: [],
    source: 'colorado_sos',
    source_url: entityId
      ? `https://www.sos.state.co.us/biz/BusinessEntityDetail.do?quitButtonDestination=BusinessEntityResults&nameTyp=ENT&masterFileId=${entityId}`
      : CO_SOS_FORM_URL,
    freshness_secs: 0,
    confidence: best.score,
    data_freshness: 'fresh',
  };
}

export async function lookupColoradoEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  return (await trySOCrataLookup(entityName)) ?? (await trySosFormLookup(entityName));
}
