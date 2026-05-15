import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { EntityLookupInput, EntityLookupSuccessSchema } from '../schemas/entity.js';
import { resolveEntityFromCache, resolveEntityUpstream, SUPPORTED_JURISDICTIONS } from '../resolvers/entity-resolver.js';
import { refreshEntityCache } from '../ingest/sos-portals.js';
import { structuredError } from '../errors/codes.js';
import type { EntityLookupOutputType } from '../schemas/entity.js';

export function registerEntityLookup(server: McpServer): void {
  server.registerTool(
    'entity_lookup',
    {
      description:
        'Verify any business entity: registration status, officers, and registered agent across US (all 50 states), UK (Companies House), and Canada. Returns a normalised schema regardless of jurisdiction. Use this when the user asks whether a company is active, wants to verify incorporation details, check if a business is legitimately registered, or confirm an entity registered agent.',
      inputSchema: EntityLookupInput,
      outputSchema: EntityLookupSuccessSchema,
      _meta: {
        surface: 'both',
        queryEligible: true,
        latencyClass: 'instant',
        pricing: { executeUsd: '0.001' },
        rateLimit: {
          maxRequestsPerMinute: 300,
          cooldownMs: 200,
          maxConcurrency: 50,
        },
        dataBroker: {
          deterministic: true,
          auditFields: ['source', 'freshness_secs', 'confidence', 'data_freshness'],
        },
      },
    },
    async (args) => {
      const { entity_name, jurisdiction = 'US-DE' } = args;

      if (!SUPPORTED_JURISDICTIONS[jurisdiction]) {
        return structuredError(
          'JURISDICTION_UNSUPPORTED',
          `Jurisdiction '${jurisdiction}' is not yet supported. Supported: ${Object.keys(SUPPORTED_JURISDICTIONS).join(', ')}`,
        );
      }

      const cached = await resolveEntityFromCache(entity_name, jurisdiction);
      if (cached) {
        const result: EntityLookupOutputType = { ...cached };
        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
        };
      }

      const result = await resolveEntityUpstream(entity_name, jurisdiction);

      // Trigger async cache refresh for next call
      void refreshEntityCache(entity_name, jurisdiction);

      if (result.status === 'unknown' && result.confidence === 0) {
        return structuredError('ENTITY_NOT_FOUND', `No entity found for '${entity_name}' in ${jurisdiction}`, {
          entity_name,
          jurisdiction,
        });
      }

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
