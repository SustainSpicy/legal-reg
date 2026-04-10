import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SanctionsScreenInput, SanctionsScreenOutput } from '../schemas/sanctions.js';
import { getCached, setCache, sanctionsScreenCacheKey } from '../cache/helpers.js';
import { screenEntity } from '../resolvers/sanctions-matcher.js';
import type { SanctionsScreenOutputType } from '../schemas/sanctions.js';

const SCREEN_CACHE_TTL = 3600; // 1 hour — sanctions lists refresh every 6h

export function registerSanctionsScreen(server: McpServer): void {
  server.registerTool(
    'sanctions_screen',
    {
      description:
        'Screen any entity against all major sanctions lists: OFAC SDN, OFAC Consolidated, FinCEN, UN 1267, EU CFSP, and HM Treasury. Returns exact hits, normalised hits, and fuzzy candidates above the confidence threshold.',
      inputSchema: SanctionsScreenInput,
      outputSchema: SanctionsScreenOutput,
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
          auditFields: ['lists_checked', 'freshness_secs', 'screened_at', 'data_freshness'],
        },
      },
    },
    async (args) => {
      const {
        entity_name,
        lists = ['OFAC_SDN', 'OFAC_CONS', 'FinCEN', 'UN_1267', 'EU_CFSP', 'HM_TREASURY'],
        fuzzy_threshold = 0.85,
      } = args;

      const cacheKey = sanctionsScreenCacheKey(entity_name);
      const cached = await getCached<SanctionsScreenOutputType>(cacheKey);
      if (cached) {
        return {
          content: [{ type: 'text', text: JSON.stringify(cached) }],
          structuredContent: cached,
        };
      }

      const { hits, fuzzy_candidates } = await screenEntity(entity_name, lists, fuzzy_threshold);

      const result: SanctionsScreenOutputType = {
        entity_name,
        screened_at: new Date().toISOString(),
        clear: hits.length === 0,
        hits,
        fuzzy_candidates,
        lists_checked: lists,
        freshness_secs: 0,
        data_freshness: 'fresh',
      };

      await setCache(cacheKey, result, SCREEN_CACHE_TTL);

      return {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
