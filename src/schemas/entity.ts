import { z } from 'zod';
import { ErrorOutputSchema } from '../errors/codes.js';

export const EntityLookupInput = z.object({
  entity_name: z
    .string()
    .describe('Company name to look up')
    .default('Acme Holdings LLC'),
  jurisdiction: z
    .string()
    .optional()
    .describe(
      'ISO jurisdiction code (e.g. US-DE, US-CA, GB). Omit to search all supported jurisdictions.',
    )
    .default('US-DE'),
  include_officers: z.boolean().optional().default(true),
  include_registered_agent: z.boolean().optional().default(true),
});

export const OfficerSchema = z.object({
  name: z.string(),
  role: z.string(),
  since: z.string().nullable(),
});

export const RegisteredAgentSchema = z.object({
  name: z.string(),
  address: z.string(),
}).nullable();

export const EntityLookupSuccessSchema = z.object({
  entity_id: z.string().describe('Canonical corpsig_ prefixed entity ID'),
  canonical_name: z.string(),
  jurisdiction: z.string(),
  status: z.enum(['active', 'dissolved', 'suspended', 'unknown']),
  incorporated_at: z.string().nullable(),
  registered_agent: RegisteredAgentSchema,
  officers: z.array(OfficerSchema),
  source: z.string().describe('Upstream source identifier'),
  source_url: z.string().nullable(),
  freshness_secs: z.number().describe('Age of cached record in seconds'),
  confidence: z.number().min(0).max(1).describe('Name match confidence 0–1'),
  data_freshness: z.enum(['fresh', 'stale']).default('fresh'),
});

export const EntityLookupOutput = z.union([EntityLookupSuccessSchema, ErrorOutputSchema]);

export type EntityLookupInputType = z.infer<typeof EntityLookupInput>;
export type EntityLookupOutputType = z.infer<typeof EntityLookupSuccessSchema>;
