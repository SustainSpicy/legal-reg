// OpenCorporates free API — no API key required for basic name search.
// Covers ~200M companies across 150+ jurisdictions, sourced directly from
// official registries (including Delaware ICIS, CA BizFile, etc.).
// Rate limit: ~500 req/day anonymous; higher with OPENCORPORATES_API_TOKEN.
// Docs: https://api.opencorporates.com/documentation/API-Reference

import { generateEntityId } from '../../resolvers/entity-resolver.js';
import { normaliseName } from '../../resolvers/name-normaliser.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

const OC_BASE = 'https://api.opencorporates.com/v0.4';

// Convert our jurisdiction codes to OpenCorporates format (US-DE → us_de, GB → gb)
function toOCCode(jurisdiction: string): string {
  return jurisdiction.toLowerCase().replace('-', '_');
}

interface OCCompany {
  name: string;
  company_number: string;
  jurisdiction_code: string;
  incorporation_date: string | null;
  dissolution_date: string | null;
  current_status: string | null;
  registry_url: string | null;
  registered_address_in_full?: string | null;
}

function mapOCStatus(raw: string | null): EntityLookupOutputType['status'] {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('active') || s.includes('good standing') || s.includes('in existence')) return 'active';
  if (s.includes('dissol') || s.includes('cancel') || s.includes('void') || s.includes('struck')) return 'dissolved';
  if (s.includes('suspend') || s.includes('delinq') || s.includes('inactive')) return 'suspended';
  return 'unknown';
}

export async function lookupViaOpenCorporates(
  entityName: string,
  jurisdiction: string,
): Promise<EntityLookupOutputType | null> {
  const code = toOCCode(jurisdiction);
  const token = process.env['OPENCORPORATES_API_TOKEN'];
  const tokenParam = token ? `&api_token=${token}` : '';

  const url = `${OC_BASE}/companies/search?q=${encodeURIComponent(entityName)}&jurisdiction_code=${code}&order=score${tokenParam}`;

  const res = await fetch(url, {
    headers: {
      'User-Agent': `CorpSignal-MCP/1.0 (${process.env['EDGAR_CONTACT_EMAIL'] ?? 'compliance@corpsignal.io'})`,
      Accept: 'application/json',
    },
  }).catch(() => null);

  if (!res) return null;

  if (res.status === 401) {
    // OpenCorporates no longer offers anonymous free-tier access — an API token is required.
    // Set OPENCORPORATES_API_TOKEN in .env to enable this source.
    // Register at https://opencorporates.com/users/new for a free API token.
    console.warn('[opencorporates] 401 Unauthorized — set OPENCORPORATES_API_TOKEN in .env');
    return null;
  }

  if (!res.ok) return null;

  const data = await res.json().catch(() => null) as {
    results?: { companies?: Array<{ company: OCCompany }> };
  } | null;

  const companies = (data?.results?.companies ?? []).map((c) => c.company);
  if (companies.length === 0) return null;

  const normQuery = normaliseName(entityName);
  const ranked = companies
    .map((c) => ({
      c,
      score: normaliseName(c.name) === normQuery ? 1.0 : 0.85,
    }))
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (!best) return null;
  const { c, score } = best;

  return {
    entity_id: generateEntityId(jurisdiction, c.name),
    canonical_name: c.name,
    jurisdiction,
    status: mapOCStatus(c.current_status),
    incorporated_at: c.incorporation_date ?? null,
    registered_agent: null,
    officers: [],
    source: `opencorporates_${code}`,
    source_url: c.registry_url ?? `https://opencorporates.com/companies/${code}/${c.company_number}`,
    freshness_secs: 0,
    confidence: score,
    data_freshness: 'fresh',
  };
}
