// Companies House REST API (UK)
// Free official API: https://api.companieshouse.gov.uk
// Requires API key — set COMPANIES_HOUSE_API_KEY env var

import type { EntityLookupOutputType } from '../../schemas/entity.js';
import { generateEntityId } from '../../resolvers/entity-resolver.js';

const BASE_URL = 'https://api.companieshouse.gov.uk';

function getApiKey(): string {
  const key = process.env['COMPANIES_HOUSE_API_KEY'];
  if (!key) throw new Error('COMPANIES_HOUSE_API_KEY is not set');
  return key;
}

function authHeader(): Record<string, string> {
  const key = getApiKey();
  const encoded = Buffer.from(`${key}:`).toString('base64');
  return { Authorization: `Basic ${encoded}` };
}

interface CHSearchResult {
  company_number: string;
  title: string;
  company_status: string;
  date_of_creation: string;
  company_type: string;
}

interface CHCompanyProfile {
  company_number: string;
  company_name: string;
  company_status: string;
  date_of_creation: string;
  registered_office_address: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    postal_code?: string;
    country?: string;
  };
}

interface CHOfficer {
  name: string;
  officer_role: string;
  appointed_on?: string;
  resigned_on?: string;
}

export async function searchCompaniesHouse(name: string): Promise<CHSearchResult[]> {
  const url = `${BASE_URL}/search/companies?q=${encodeURIComponent(name)}&items_per_page=5`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) throw new Error(`Companies House search failed: ${res.status}`);
  const data = await res.json() as { items?: CHSearchResult[] };
  return data.items ?? [];
}

export async function fetchCompanyProfile(companyNumber: string): Promise<CHCompanyProfile> {
  const url = `${BASE_URL}/company/${companyNumber}`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) throw new Error(`Companies House profile fetch failed: ${res.status}`);
  return res.json() as Promise<CHCompanyProfile>;
}

export async function fetchCompanyOfficers(companyNumber: string): Promise<CHOfficer[]> {
  const url = `${BASE_URL}/company/${companyNumber}/officers?items_per_page=20`;
  const res = await fetch(url, { headers: authHeader() });
  if (!res.ok) return [];
  const data = await res.json() as { items?: CHOfficer[] };
  return (data.items ?? []).filter((o) => !o.resigned_on);
}

export async function resolveUKEntity(entityName: string): Promise<EntityLookupOutputType | null> {
  const results = await searchCompaniesHouse(entityName);
  if (results.length === 0) return null;

  const best = results[0]!;
  const profile = await fetchCompanyProfile(best.company_number);
  const officers = await fetchCompanyOfficers(best.company_number);

  const address = [
    profile.registered_office_address.address_line_1,
    profile.registered_office_address.locality,
    profile.registered_office_address.postal_code,
    profile.registered_office_address.country,
  ]
    .filter(Boolean)
    .join(', ');

  return {
    entity_id: generateEntityId('GB', profile.company_name),
    canonical_name: profile.company_name,
    jurisdiction: 'GB',
    status: profile.company_status === 'active' ? 'active' : 'dissolved',
    incorporated_at: profile.date_of_creation ?? null,
    registered_agent: address ? { name: 'Registered Office', address } : null,
    officers: officers.map((o) => ({
      name: o.name,
      role: o.officer_role,
      since: o.appointed_on ?? null,
    })),
    source: 'companies_house',
    source_url: `https://find-and-update.company-information.service.gov.uk/company/${best.company_number}`,
    freshness_secs: 0,
    confidence: 0.95,
    data_freshness: 'fresh',
  };
}
