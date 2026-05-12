import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ComplianceRiskInput, ComplianceRiskSuccessSchema } from '../schemas/compliance.js';
import { getCached, setCache, complianceCacheKey } from '../cache/helpers.js';
import {
  resolveEntityFromCache,
  resolveEntityUpstream,
  generateEntityId,
} from '../resolvers/entity-resolver.js';
import { screenEntity } from '../resolvers/sanctions-matcher.js';
import { SANCTIONS_LISTS } from '../schemas/sanctions.js';
import type { ComplianceRiskOutputType } from '../schemas/compliance.js';
import {
  getJurisdictionRiskLevel,
  JURISDICTION_RISK_SCORE,
} from '../data/fatf-jurisdictions.js';

const FORMULA_VERSION = '1.1.0'; // bumped: full FATF grey/black list + OFAC comprehensive

const SIGNAL_WEIGHTS = {
  registration_status: 0.30,
  sanctions_clear: 0.40,
  officer_count: 0.10,
  data_freshness: 0.10,
  jurisdiction_risk: 0.10,
} as const;

function riskTier(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score < 0.25) return 'low';
  if (score < 0.50) return 'medium';
  if (score < 0.75) return 'high';
  return 'critical';
}

export function registerComplianceRiskScore(server: McpServer): void {
  server.registerTool(
    'compliance_risk_score',
    {
      description:
        'Generate a transparent compliance risk score (0=low, 1=high) for any entity. Every signal, weight, and contribution is exposed in score_breakdown — no black-box outputs. Combines registration status, sanctions screening, officer records, data freshness, and jurisdiction risk.',
      inputSchema: ComplianceRiskInput,
      outputSchema: ComplianceRiskSuccessSchema,
      _meta: {
        surface: 'both',
        queryEligible: true,
        latencyClass: 'fast',
        pricing: { executeUsd: '0.005' },
        rateLimit: {
          maxRequestsPerMinute: 200,
          cooldownMs: 300,
          maxConcurrency: 30,
        },
        dataBroker: {
          deterministic: true,
          auditFields: ['formula_version', 'scored_at', 'freshness_secs', 'data_freshness'],
        },
      },
    },
    async (args) => {
      const { entity_name, jurisdiction = 'US-DE', entity_id } = args;

      const canonicalId = entity_id ?? generateEntityId(jurisdiction, entity_name);
      const cacheKey = complianceCacheKey(canonicalId);
      const cached = await getCached<ComplianceRiskOutputType>(cacheKey);
      if (cached) {
        return {
          content: [{ type: 'text', text: JSON.stringify(cached) }],
          structuredContent: cached,
        };
      }

      const [entity, sanctionsResult] = await Promise.all([
        (async () => {
          const c = await resolveEntityFromCache(entity_name, jurisdiction);
          return c ?? resolveEntityUpstream(entity_name, jurisdiction);
        })(),
        screenEntity(entity_name, [...SANCTIONS_LISTS], 0.85),
      ]);

      const registrationScore = entity.status === 'active' ? 0 : 1;
      const sanctionsClearScore = sanctionsResult.hits.length > 0 ? 1 : 0;
      const officerScore = entity.officers.length > 0 ? 0 : 0.5;
      const freshnessScore = entity.data_freshness === 'stale' ? 0.3 : 0;

      // Use iso2 code for jurisdiction risk — strip 'US-' prefix for US states
      const iso2 = jurisdiction.includes('-') ? jurisdiction.split('-')[0]! : jurisdiction;
      const jurisdictionRiskLevel = getJurisdictionRiskLevel(iso2);
      const jurisdictionRiskScore = JURISDICTION_RISK_SCORE[jurisdictionRiskLevel];

      const scoreBreakdown = [
        {
          signal: 'registration_status',
          value: entity.status,
          weight: SIGNAL_WEIGHTS.registration_status,
          contribution: registrationScore * SIGNAL_WEIGHTS.registration_status,
          source: entity.source,
        },
        {
          signal: 'sanctions_clear',
          value: sanctionsResult.hits.length === 0,
          weight: SIGNAL_WEIGHTS.sanctions_clear,
          contribution: sanctionsClearScore * SIGNAL_WEIGHTS.sanctions_clear,
          source: [...SANCTIONS_LISTS].join(','),
        },
        {
          signal: 'officer_count',
          value: entity.officers.length,
          weight: SIGNAL_WEIGHTS.officer_count,
          contribution: officerScore * SIGNAL_WEIGHTS.officer_count,
          source: entity.source,
        },
        {
          signal: 'data_freshness',
          value: entity.data_freshness,
          weight: SIGNAL_WEIGHTS.data_freshness,
          contribution: freshnessScore * SIGNAL_WEIGHTS.data_freshness,
          source: 'cache',
        },
        {
          signal: 'jurisdiction_risk',
          value: `${jurisdiction}:${jurisdictionRiskLevel}`,
          weight: SIGNAL_WEIGHTS.jurisdiction_risk,
          contribution: jurisdictionRiskScore * SIGNAL_WEIGHTS.jurisdiction_risk,
          source: 'fatf_v2024_10+ofac',
        },
      ];

      const riskScore = scoreBreakdown.reduce((sum, s) => sum + s.contribution, 0);

      const result: ComplianceRiskOutputType = {
        entity_id: canonicalId,
        canonical_name: entity.canonical_name,
        jurisdiction,
        risk_score: Math.min(1, Math.max(0, riskScore)),
        risk_tier: riskTier(riskScore),
        score_breakdown: scoreBreakdown,
        formula_version: FORMULA_VERSION,
        scored_at: new Date().toISOString(),
        freshness_secs: entity.freshness_secs,
        data_freshness: entity.data_freshness,
      };

      await setCache(cacheKey, result, 1800);

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
