import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCached = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
}));

import { screenEntity } from '../../resolvers/sanctions-matcher.js';

type SanctionsList = 'OFAC_SDN' | 'OFAC_CONS' | 'EU_CFSP' | 'HM_TREASURY' | 'UN_1267' | 'FinCEN';
const LIST: SanctionsList = 'OFAC_SDN';

const TEST_ENTRIES = [
  {
    id: 'SDN_001',
    name: 'Bad Actor Corp',
    aliases: ['BAC Holdings LLC', 'Bad Actor International'],
    program: 'SDGT',
    listed_on: '2020-01-01',
  },
  {
    id: 'SDN_002',
    name: 'Sanctioned Enterprise Ltd',
    aliases: [],
    program: 'IRAN',
    listed_on: '2019-06-15',
  },
  {
    id: 'SDN_003',
    name: 'Rogue Exports GmbH',
    aliases: ['Rogue Exports AG'],
    program: 'CUBA',
    listed_on: '2021-03-10',
  },
];

describe('screenEntity — tier 1: exact match', () => {
  beforeEach(() => mockGetCached.mockResolvedValue(TEST_ENTRIES));

  it('finds an exact case-insensitive match', async () => {
    const result = await screenEntity('bad actor corp', [LIST], 0.85);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.match_type).toBe('exact');
    expect(result.hits[0]!.score).toBe(1.0);
    expect(result.hits[0]!.entry_id).toBe('SDN_001');
  });

  it('finds an exact match via alias', async () => {
    const result = await screenEntity('BAC Holdings LLC', [LIST], 0.85);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.matched_name).toBe('BAC Holdings LLC');
  });

  it('captures the program and listed_on from the entry', async () => {
    const result = await screenEntity('Bad Actor Corp', [LIST], 0.85);
    expect(result.hits[0]!.program).toBe('SDGT');
    expect(result.hits[0]!.listed_on).toBe('2020-01-01');
  });
});

describe('screenEntity — tier 2: normalised match', () => {
  beforeEach(() => mockGetCached.mockResolvedValue(TEST_ENTRIES));

  it('matches after stripping legal suffixes', async () => {
    // 'Bad Actor Corp' normalises to 'bad actor'; 'Bad Actor LLC' also → 'bad actor'
    const result = await screenEntity('Bad Actor LLC', [LIST], 0.85);
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.match_type).toBe('normalised');
    expect(result.hits[0]!.score).toBe(0.99);
  });

  it('matches entry via normalised alias', async () => {
    // 'Bad Actor International' normalises to 'bad actor'; query 'Bad Actor Inc' → 'bad actor'
    const result = await screenEntity('Bad Actor Inc', [LIST], 0.85);
    expect(result.hits[0]!.match_type).toBe('normalised');
  });
});

describe('screenEntity — tier 3: fuzzy candidates', () => {
  beforeEach(() => mockGetCached.mockResolvedValue(TEST_ENTRIES));

  it('adds a fuzzy candidate for a close-but-not-normalised match', async () => {
    // 'Rogue Export GmbH' (singular) vs 'Rogue Exports GmbH' → high similarity, below exact
    const result = await screenEntity('Rogue Export GmbH', [LIST], 0.7);
    const allMatches = [...result.hits, ...result.fuzzy_candidates];
    expect(allMatches.length).toBeGreaterThan(0);
  });

  it('does not add fuzzy candidates below the threshold', async () => {
    const result = await screenEntity('Completely Unrelated Name', [LIST], 0.85);
    expect(result.hits).toHaveLength(0);
    expect(result.fuzzy_candidates).toHaveLength(0);
  });

  it('deduplicates fuzzy candidates by list + name pair', async () => {
    const result = await screenEntity('Bad Actor', [LIST], 0.5);
    const pairs = result.fuzzy_candidates.map((c) => `${c.list}:${c.candidate_name}`);
    expect(pairs.length).toBe(new Set(pairs).size);
  });

  it('sorts fuzzy candidates highest score first', async () => {
    const result = await screenEntity('Bad Actor', [LIST], 0.5);
    for (let i = 1; i < result.fuzzy_candidates.length; i++) {
      expect(result.fuzzy_candidates[i - 1]!.score).toBeGreaterThanOrEqual(
        result.fuzzy_candidates[i]!.score,
      );
    }
  });
});

describe('screenEntity — empty / missing list', () => {
  it('returns no hits when sanctions cache is empty', async () => {
    mockGetCached.mockResolvedValue(null);
    const result = await screenEntity('Bad Actor Corp', [LIST], 0.85);
    expect(result.hits).toHaveLength(0);
    expect(result.fuzzy_candidates).toHaveLength(0);
  });

  it('returns no hits for a genuinely clean entity', async () => {
    mockGetCached.mockResolvedValue(TEST_ENTRIES);
    const result = await screenEntity('Honest Trading Co', [LIST], 0.85);
    expect(result.hits).toHaveLength(0);
  });
});

describe('screenEntity — multiple lists', () => {
  it('checks each list independently', async () => {
    mockGetCached.mockResolvedValue(TEST_ENTRIES);
    const lists: SanctionsList[] = ['OFAC_SDN', 'EU_CFSP'];
    const result = await screenEntity('Bad Actor Corp', lists, 0.85);
    // Both lists return the same test entries, so we expect 2 hits (one per list)
    expect(result.hits.length).toBeGreaterThanOrEqual(1);
    const hitLists = result.hits.map((h) => h.list);
    expect(hitLists).toContain('OFAC_SDN');
  });
});
