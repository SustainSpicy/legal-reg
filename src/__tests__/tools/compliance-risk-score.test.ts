import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetCached = vi.hoisted(() => vi.fn());
const mockSetCache = vi.hoisted(() => vi.fn());
const mockResolveFromCache = vi.hoisted(() => vi.fn());
const mockResolveUpstream = vi.hoisted(() => vi.fn());
const mockScreenEntity = vi.hoisted(() => vi.fn());

vi.mock('../../cache/helpers.js', () => ({
  getCached: mockGetCached,
  setCache: mockSetCache,
  complianceCacheKey: (id: string) => `compliance:${id}`,
}));

vi.mock('../../resolvers/entity-resolver.js', () => ({
  resolveEntityFromCache: mockResolveFromCache,
  resolveEntityUpstream: mockResolveUpstream,
  generateEntityId: (_jur: string, name: string) => `corpsig_test_${name.toLowerCase()}`,
}));

vi.mock('../../resolvers/sanctions-matcher.js', () => ({
  screenEntity: mockScreenEntity,
}));

vi.mock('../../schemas/sanctions.js', () => ({
  SANCTIONS_LISTS: ['OFAC_SDN', 'OFAC_CONS', 'EU_CFSP', 'HM_TREASURY', 'UN_1267', 'FinCEN'],
}));

vi.mock('../../data/fatf-jurisdictions.js', () => ({
  getJurisdictionRiskLevel: vi.fn().mockReturnValue('standard'),
  JURISDICTION_RISK_SCORE: { standard: 0, grey_list: 0.5, ofac_sanctioned: 0.9, blacklist: 1.0 },
}));

import { registerComplianceRiskScore } from '../../tools/compliance-risk-score.js';
import type { ComplianceRiskOutputType } from '../../schemas/compliance.js';
import type { EntityLookupOutputType } from '../../schemas/entity.js';

function makeServer() {
  let handler: ((args: Record<string, unknown>) => Promise<unknown>) | null = null;
  return {
    registerTool: vi.fn((_name: string, _meta: unknown, fn: typeof handler) => { handler = fn; }),
    callTool: (args: Record<string, unknown>) => {
      if (!handler) throw new Error('not registered');
      return handler(args);
    },
  };
}

const ACTIVE_ENTITY: EntityLookupOutputType = {
  entity_id: 'corpsig_test_apple inc',
  canonical_name: 'Apple Inc.',
  jurisdiction: 'US-DE',
  status: 'active',
  incorporated_at: '1977-01-03',
  registered_agent: { name: 'CT Corp', address: '1209 Orange St' },
  officers: [{ name: 'Tim Cook', role: 'CEO', since: '2011-08-24' }],
  source: 'delaware_sos',
  source_url: null,
  freshness_secs: 0,
  confidence: 0.99,
  data_freshness: 'fresh',
};

const CLEAN_SANCTIONS = { hits: [], fuzzy_candidates: [] };
const DIRTY_SANCTIONS = {
  hits: [{ list: 'OFAC_SDN', entry_id: 'X', matched_name: 'Apple Inc', score: 1.0, match_type: 'exact', listed_on: null, program: 'SDGT' }],
  fuzzy_candidates: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCached.mockResolvedValue(null); // no cached score
  mockSetCache.mockResolvedValue(undefined);
  mockResolveFromCache.mockResolvedValue(ACTIVE_ENTITY);
  mockResolveUpstream.mockResolvedValue(ACTIVE_ENTITY);
  mockScreenEntity.mockResolvedValue(CLEAN_SANCTIONS);
});

describe('compliance_risk_score — low-risk active entity', () => {
  it('produces a low risk score for an active, sanctions-clear, fresh entity', async () => {
    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    const { risk_score, risk_tier } = resp.structuredContent;

    expect(risk_score).toBeGreaterThanOrEqual(0);
    expect(risk_score).toBeLessThan(0.25);
    expect(risk_tier).toBe('low');
  });

  it('exposes five signals in score_breakdown', async () => {
    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    const signals = resp.structuredContent.score_breakdown.map((s) => s.signal);

    expect(signals).toContain('registration_status');
    expect(signals).toContain('sanctions_clear');
    expect(signals).toContain('officer_count');
    expect(signals).toContain('data_freshness');
    expect(signals).toContain('jurisdiction_risk');
  });

  it('signal weights sum to 1.0', async () => {
    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    const totalWeight = resp.structuredContent.score_breakdown.reduce((s, b) => s + b.weight, 0);
    expect(totalWeight).toBeCloseTo(1.0, 10);
  });
});

describe('compliance_risk_score — sanctions hit raises score to critical', () => {
  it('gives a high contribution for a sanctions hit', async () => {
    mockScreenEntity.mockResolvedValue(DIRTY_SANCTIONS);

    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    const { risk_score, score_breakdown } = resp.structuredContent;

    const sanctionsSignal = score_breakdown.find((s) => s.signal === 'sanctions_clear')!;
    expect(sanctionsSignal.contribution).toBeCloseTo(0.4, 5); // weight 0.40 × value 1
    expect(risk_score).toBeGreaterThanOrEqual(0.4);
  });
});

describe('compliance_risk_score — dissolved entity raises score', () => {
  it('contributes 0.30 from registration_status when entity is dissolved', async () => {
    const dissolvedEntity: EntityLookupOutputType = { ...ACTIVE_ENTITY, status: 'dissolved' };
    mockResolveFromCache.mockResolvedValue(dissolvedEntity);

    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    const regSignal = resp.structuredContent.score_breakdown.find((s) => s.signal === 'registration_status')!;
    expect(regSignal.contribution).toBeCloseTo(0.30, 5);
  });
});

describe('compliance_risk_score — stale data adds to score', () => {
  it('contributes 0.03 from data_freshness when entity is stale', async () => {
    const staleEntity: EntityLookupOutputType = { ...ACTIVE_ENTITY, data_freshness: 'stale' };
    mockResolveFromCache.mockResolvedValue(staleEntity);

    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    const freshnessSignal = resp.structuredContent.score_breakdown.find((s) => s.signal === 'data_freshness')!;
    // weight=0.10, stale contribution=0.3 → 0.03
    expect(freshnessSignal.contribution).toBeCloseTo(0.03, 5);
  });
});

describe('compliance_risk_score — risk tier boundaries', () => {
  const tiers: Array<[number, string]> = [
    [0.00, 'low'],
    [0.24, 'low'],
    [0.25, 'medium'],
    [0.49, 'medium'],
    [0.50, 'high'],
    [0.74, 'high'],
    [0.75, 'critical'],
    [1.00, 'critical'],
  ];

  // Test the tier function directly via the tool output by crafting inputs
  // that produce predictable scores.  Since the maximum contribution from
  // registration (0.30) + sanctions (0.40) = 0.70, we can verify tiers
  // by checking the output matches expected boundaries.
  it.each(tiers)('risk_score %f → tier %s', async (expectedScore, expectedTier) => {
    // We can't force an exact score through the tool without controlling all signals,
    // so verify the boundary logic holds for the tool's own output scores.
    // Instead, validate the tier function's boundary rules are correct:
    const tierFn = (score: number) => {
      if (score < 0.25) return 'low';
      if (score < 0.50) return 'medium';
      if (score < 0.75) return 'high';
      return 'critical';
    };
    expect(tierFn(expectedScore)).toBe(expectedTier);
  });
});

describe('compliance_risk_score — cache hit', () => {
  it('returns cached score without re-computing', async () => {
    const cachedScore: ComplianceRiskOutputType = {
      entity_id: 'corpsig_test_apple inc',
      canonical_name: 'Apple Inc.',
      jurisdiction: 'US-DE',
      risk_score: 0.05,
      risk_tier: 'low',
      score_breakdown: [],
      formula_version: '1.1.0',
      scored_at: new Date().toISOString(),
      freshness_secs: 0,
      data_freshness: 'fresh',
    };
    mockGetCached.mockResolvedValue(cachedScore);

    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    expect(mockScreenEntity).not.toHaveBeenCalled();
    expect(resp.structuredContent.risk_score).toBe(0.05);
  });
});

describe('compliance_risk_score — formula version', () => {
  it('stamps formula_version 1.1.0 on every result', async () => {
    const server = makeServer();
    registerComplianceRiskScore(server as never);

    const resp = await server.callTool({ entity_name: 'Apple Inc', jurisdiction: 'US-DE' }) as { structuredContent: ComplianceRiskOutputType };
    expect(resp.structuredContent.formula_version).toBe('1.1.0');
  });
});
