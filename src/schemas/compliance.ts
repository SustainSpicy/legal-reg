import { z } from 'zod';
import { ErrorOutputSchema } from '../errors/codes.js';

export const ComplianceRiskInput = z.object({
  entity_name: z
    .string()
    .describe('Entity name to score')
    .default('Acme Holdings LLC'),
  jurisdiction: z
    .string()
    .optional()
    .default('US-DE')
    .describe('ISO jurisdiction code (e.g. US-DE, GB)'),
  entity_id: z
    .string()
    .optional()
    .describe('Canonical corpsig_ entity ID — skips name resolution if provided'),
});

export const ScoreSignalSchema = z.object({
  signal: z.string().describe('Signal name (e.g. registration_status, sanctions_clear)'),
  value: z.union([z.string(), z.number(), z.boolean()]).describe('Raw signal value'),
  weight: z.number().min(0).max(1).describe('Weight of this signal in the composite score'),
  contribution: z.number().describe('Weighted contribution to the final score'),
  source: z.string().describe('Data source for this signal'),
});

export const ComplianceRiskSuccessSchema = z.object({
  entity_id: z.string(),
  canonical_name: z.string(),
  jurisdiction: z.string(),
  risk_score: z
    .number()
    .min(0)
    .max(1)
    .describe('Composite risk score 0=lowest risk, 1=highest risk'),
  risk_tier: z.enum(['low', 'medium', 'high', 'critical']),
  score_breakdown: z
    .array(ScoreSignalSchema)
    .describe('Every signal, weight and contribution — no black-box outputs'),
  formula_version: z
    .string()
    .describe('Scoring formula version — use for audit trail'),
  scored_at: z.string().describe('ISO 8601 timestamp'),
  freshness_secs: z.number(),
  data_freshness: z.enum(['fresh', 'stale']).default('fresh'),
});

export const ComplianceRiskOutput = z.union([ComplianceRiskSuccessSchema, ErrorOutputSchema]);

export type ComplianceRiskInputType = z.infer<typeof ComplianceRiskInput>;
export type ComplianceRiskOutputType = z.infer<typeof ComplianceRiskSuccessSchema>;
