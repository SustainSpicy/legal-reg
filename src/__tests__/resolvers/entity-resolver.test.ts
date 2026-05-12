import { describe, it, expect, vi } from 'vitest';

// Mock all modules that touch Redis or make HTTP calls
vi.mock('../../cache/helpers.js', () => ({
  getCached: vi.fn().mockResolvedValue(null),
  setCache: vi.fn().mockResolvedValue(undefined),
  entityCacheKey: (jur: string, name: string) =>
    `entity:${jur.toLowerCase()}:${name.toLowerCase()}`,
  addToEntityWatchlist: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../ingest/sources/sos-portals.js', () => ({
  SCRAPE_ONLY_STATES: ['US-AL', 'US-AK'],
  lookupSOSEntity: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../ingest/sos-scraper.js', () => ({
  scrapeEntityOnDemand: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../ingest/sources/companies-house.js', () => ({
  resolveUKEntity: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../ingest/sources/canada.js', () => ({
  resolveCanadianEntity: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../ingest/sources/edgar.js', () => ({
  resolveEDGAREntity: vi.fn().mockResolvedValue(null),
}));

import { generateEntityId, disambiguateEntities } from '../../resolvers/entity-resolver.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

function makeEntity(name: string, jurisdiction: string, confidence = 0.9): EntityLookupOutputType {
  return {
    entity_id: generateEntityId(jurisdiction, name),
    canonical_name: name,
    jurisdiction,
    status: 'active',
    incorporated_at: null,
    registered_agent: null,
    officers: [],
    source: 'test',
    source_url: null,
    freshness_secs: 0,
    confidence,
    data_freshness: 'fresh',
  };
}

describe('generateEntityId', () => {
  it('is deterministic', () => {
    expect(generateEntityId('US-DE', 'Apple Inc')).toBe(generateEntityId('US-DE', 'Apple Inc'));
  });

  it('starts with the corpsig prefix', () => {
    expect(generateEntityId('US-DE', 'Apple Inc')).toMatch(/^corpsig_/);
  });

  it('encodes jurisdiction with underscores', () => {
    expect(generateEntityId('US-DE', 'X')).toContain('us_de');
    expect(generateEntityId('CA-BC', 'X')).toContain('ca_bc');
  });

  it('normalises the entity name (strips legal suffix, lowercases)', () => {
    const withSuffix = generateEntityId('US-DE', 'Apple Inc');
    const plain = generateEntityId('US-DE', 'Apple');
    expect(withSuffix).toBe(plain);
  });

  it('truncates name segment to 40 characters', () => {
    const longName = 'A'.repeat(80);
    const id = generateEntityId('US-DE', longName);
    const namePart = id.replace('corpsig_us_de_', '');
    expect(namePart.length).toBeLessThanOrEqual(40);
  });

  it('produces different IDs for different jurisdictions', () => {
    expect(generateEntityId('US-DE', 'Apple')).not.toBe(generateEntityId('US-CA', 'Apple'));
  });
});

describe('disambiguateEntities', () => {
  it('returns null for an empty candidate list', () => {
    expect(disambiguateEntities([], 'Apple Inc', 'US-DE')).toBeNull();
  });

  it('returns the sole candidate immediately', () => {
    const entity = makeEntity('Apple Inc', 'US-DE');
    expect(disambiguateEntities([entity], 'Apple Inc', 'US-DE')).toBe(entity);
  });

  it('prefers a jurisdiction match over a weaker name match', () => {
    const deEntity = makeEntity('Apple Inc', 'US-DE');
    const caEntity = makeEntity('Apple Holdings', 'US-CA');
    const result = disambiguateEntities([caEntity, deEntity], 'Apple Inc', 'US-DE');
    expect(result?.jurisdiction).toBe('US-DE');
  });

  it('prefers a closer name match when jurisdictions are equal', () => {
    const exact = makeEntity('Apple Inc', 'US-DE');
    const distant = makeEntity('Appleby Westbridge Holdings Corp', 'US-DE');
    const result = disambiguateEntities([distant, exact], 'Apple Inc', 'US-DE');
    expect(result?.canonical_name).toBe('Apple Inc');
  });

  it('returns the best candidate even with a single entry', () => {
    const entity = makeEntity('Google LLC', 'US-CA');
    expect(disambiguateEntities([entity], 'Google', 'US-CA')).toBe(entity);
  });
});
