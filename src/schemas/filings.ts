import { z } from 'zod';

export const FilingsFetchInput = z.object({
  entity_id: z
    .string()
    .optional()
    .describe('Canonical corpsig_ entity ID (preferred)'),
  entity_name: z
    .string()
    .optional()
    .describe('Entity name — used if entity_id not provided')
    .default('Apple Inc'),
  jurisdiction: z
    .string()
    .optional()
    .default('US-DE')
    .describe('Jurisdiction code — required when using entity_name'),
  filing_types: z
    .array(z.string())
    .optional()
    .describe('Filter by filing type (e.g. ["10-K", "8-K"] or ["confirmation-statement"])'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .default(10)
    .describe('Max filings to return (1–50)'),
  parse_financials: z
    .boolean()
    .optional()
    .default(false)
    .describe('Extract key financial metrics from the latest annual filing. Adds ~10s latency on cache miss.'),
});

export const FilingItemSchema = z.object({
  filing_id: z.string(),
  type: z.string(),
  date: z.string(),
  description: z.string().nullable(),
  url: z.string().nullable(),
  source: z.enum(['EDGAR', 'COMPANIES_HOUSE', 'SEDAR']),
});

export const FinancialsSchema = z.object({
  period: z.string().nullable(),
  revenue_usd: z.number().nullable(),
  net_income_usd: z.number().nullable(),
  total_assets_usd: z.number().nullable(),
  currency_original: z.string().nullable(),
}).nullable();

export const FilingsFetchOutput = z.object({
  entity_id: z.string(),
  canonical_name: z.string(),
  jurisdiction: z.string(),
  filings: z.array(FilingItemSchema),
  financials: FinancialsSchema.describe('Key financials parsed from latest annual filing — null if parse_financials=false'),
  total_available: z.number().int(),
  source: z.string(),
  freshness_secs: z.number(),
  data_freshness: z.enum(['fresh', 'stale']).default('fresh'),
});

export type FilingsFetchInputType = z.infer<typeof FilingsFetchInput>;
export type FilingsFetchOutputType = z.infer<typeof FilingsFetchOutput>;
export type FilingItemType = z.infer<typeof FilingItemSchema>;
