import { z } from 'zod';

export const BeneficialOwnersInput = z.object({
  entity_name: z
    .string()
    .optional()
    .describe('Entity name — used if entity_id not provided')
    .default('Acme Holdings LLC'),
  jurisdiction: z
    .string()
    .optional()
    .default('US-DE')
    .describe('ISO jurisdiction code'),
  entity_id: z
    .string()
    .optional()
    .describe('Canonical corpsig_ entity ID — preferred over name lookup'),
  include_indirect: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include indirect/chain-of-control ownership where available'),
});

export const BeneficialOwnerSchema = z.object({
  owner_id: z.string().nullable().describe('corpsig_ ID if owner is itself a registered entity'),
  name: z.string(),
  ownership_pct: z.number().nullable().describe('Ownership percentage (0–100). Null if undisclosed.'),
  control_type: z.enum(['ownership', 'voting_rights', 'appointment_rights', 'other']),
  indirect: z.boolean().describe('True if ownership is through an intermediary'),
  nationality: z.string().nullable().describe('ISO 3166-1 alpha-2 country code'),
  source: z.enum(['GLEIF_LEI', 'UK_PSC', 'SEDAR', 'EDGAR_PROXY']),
  notified_on: z.string().nullable(),
});

export const BeneficialOwnersOutput = z.object({
  entity_id: z.string(),
  canonical_name: z.string(),
  jurisdiction: z.string(),
  owners: z.array(BeneficialOwnerSchema),
  disclosure_status: z.enum([
    'full',
    'partial',
    'not_required',
    'unavailable',
  ]).describe('Completeness of beneficial ownership data for this jurisdiction'),
  source: z.string(),
  freshness_secs: z.number(),
  data_freshness: z.enum(['fresh', 'stale']).default('fresh'),
});

export type BeneficialOwnersInputType = z.infer<typeof BeneficialOwnersInput>;
export type BeneficialOwnersOutputType = z.infer<typeof BeneficialOwnersOutput>;
