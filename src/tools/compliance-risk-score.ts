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
import { structuredError } from '../errors/codes.js';
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
        'Generate a transparent compliance risk score (0=low, 1=high) for any entity. Every signal, weight, and contribution is exposed in score_breakdown — no black-box outputs. Combines registration status, sanctions screening, officer records, data freshness, and FATF jurisdiction risk. Use this when assessing counterparty risk before onboarding, during due diligence reviews, or when the user asks for a risk rating or compliance assessment of a company.',
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
      const { entity_name, jurisdiction, entity_id } = args;

      if (!entity_id && !entity_name) {
        return structuredError('ENTITY_NOT_FOUND', 'Provide either entity_id or entity_name to score compliance risk');
      }

      const resolvedJurisdiction = jurisdiction ?? 'US-DE';
      const canonicalId = entity_id ?? generateEntityId(resolvedJurisdiction, entity_name!);
      const cacheKey = complianceCacheKey(canonicalId);
      const cached = await getCached<ComplianceRiskOutputType>(cacheKey);
      if (cached) {
        return {
          content: [{ type: 'text', text: JSON.stringify(cached) }],
          structuredContent: cached,
        };
      }

      // Resolve entity first so we can guard against stubs before doing any work
      const entity = await (async () => {
        if (!entity_name) {
          // entity_id-only path: look up by the id key written by entity_lookup
          return getCached<import('../schemas/entity.js').EntityLookupOutputType>(`entity:id:${canonicalId}`);
        }
        const c = await resolveEntityFromCache(entity_name, resolvedJurisdiction);
        return c ?? resolveEntityUpstream(entity_name, resolvedJurisdiction);
      })();

      // Refuse to score a confidence-0 stub — the entity hasn't been resolved.
      // This prevents contamination when entity_lookup returned ENTITY_NOT_FOUND
      // but the caller re-uses the inferred entity_id for downstream calls.
      if (!entity || (entity.confidence === 0 && entity.status === 'unknown')) {
        return structuredError(
          'ENTITY_NOT_RESOLVED',
          `Entity '${entity_name ?? canonicalId}' is not resolved — ` +
          `run entity_lookup first to verify the entity exists before scoring compliance risk.`,
        );
      }

      const sanctionsResult = await screenEntity(entity.canonical_name, [...SANCTIONS_LISTS], 0.85);

      const registrationScore = entity.status === 'active' ? 0 : 1;
      const sanctionsClearScore = sanctionsResult.hits.length > 0 ? 1 : 0;
      // officer_count is only a meaningful signal for sources that actually expose
      // officer data. EDGAR Submissions API and OpenCorporates free tier return
      // officers:[] for every entity regardless of reality — absence ≠ risk.
      // Only apply the 0.5 penalty when source is a SOS portal (which publishes
      // officer/director data) and officers are still empty.
      const sourceExposesOfficers = !entity.source.startsWith('edgar') &&
        !entity.source.startsWith('opencorporates') &&
        entity.source !== 'companies_house';
      const officerScore = (!sourceExposesOfficers || entity.officers.length > 0) ? 0 : 0.5;
      const freshnessScore = entity.data_freshness === 'stale' ? 0.3 : 0;

      // Use iso2 code for jurisdiction risk — strip 'US-' prefix for US states
      const iso2 = resolvedJurisdiction.includes('-') ? resolvedJurisdiction.split('-')[0]! : resolvedJurisdiction;
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
          value: `${resolvedJurisdiction}:${jurisdictionRiskLevel}`,
          weight: SIGNAL_WEIGHTS.jurisdiction_risk,
          contribution: jurisdictionRiskScore * SIGNAL_WEIGHTS.jurisdiction_risk,
          source: 'fatf_v2024_10+ofac',
        },
      ];

      const riskScore = scoreBreakdown.reduce((sum, s) => sum + s.contribution, 0);

      const result: ComplianceRiskOutputType = {
        entity_id: canonicalId,
        canonical_name: entity.canonical_name,
        jurisdiction: resolvedJurisdiction,
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
