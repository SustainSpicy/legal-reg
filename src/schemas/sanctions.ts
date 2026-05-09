import { z } from 'zod';
import { ErrorOutputSchema } from '../errors/codes.js';

export const SANCTIONS_LISTS = [
  'OFAC_SDN',
  'OFAC_CONS',
  'FinCEN',
  'UN_1267',
  'EU_CFSP',
  'HM_TREASURY',
] as const;

export const SanctionsScreenInput = z.object({
  entity_name: z
    .string()
    .describe('Entity name to screen against sanctions lists')
    .default('Specially Designated Nationals LLC'),
  jurisdiction: z
    .string()
    .optional()
    .describe('Known jurisdiction — improves disambiguation'),
  lists: z
    .array(z.enum(SANCTIONS_LISTS))
    .optional()
    .default(['OFAC_SDN', 'OFAC_CONS', 'FinCEN', 'UN_1267', 'EU_CFSP', 'HM_TREASURY'])
    .describe('Sanctions lists to check. Defaults to all six.'),
  fuzzy_threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.85)
    .describe('Minimum score to return a fuzzy candidate (0–1). Default 0.85.'),
});

export const SanctionsHitSchema = z.object({
  list: z.enum(SANCTIONS_LISTS),
  entry_id: z.string(),
  matched_name: z.string(),
  score: z.number().min(0).max(1),
  match_type: z.enum(['exact', 'normalised', 'fuzzy']),
  listed_on: z.string().nullable(),
  program: z.string().nullable().describe('Sanctions programme (e.g. SDGT, IRAN)'),
});

export const FuzzyCandidateSchema = z.object({
  list: z.enum(SANCTIONS_LISTS),
  candidate_name: z.string(),
  score: z.number().min(0).max(1),
  disposition: z.literal('no_match'),
});

export const SanctionsScreenSuccessSchema = z.object({
  entity_name: z.string(),
  screened_at: z.string().describe('ISO 8601 timestamp'),
  clear: z.boolean().describe('True if no confirmed hits on any list'),
  hits: z.array(SanctionsHitSchema),
  fuzzy_candidates: z.array(FuzzyCandidateSchema).describe(
    'Near-matches below confidence threshold — returned for human review',
  ),
  lists_checked: z.array(z.enum(SANCTIONS_LISTS)),
  freshness_secs: z.number(),
  data_freshness: z.enum(['fresh', 'stale']).default('fresh'),
});

export const SanctionsScreenOutput = z.union([SanctionsScreenSuccessSchema, ErrorOutputSchema]);

export type SanctionsScreenInputType = z.infer<typeof SanctionsScreenInput>;
export type SanctionsScreenOutputType = z.infer<typeof SanctionsScreenSuccessSchema>;
