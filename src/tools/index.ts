import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEntityLookup } from './entity-lookup.js';
import { registerSanctionsScreen } from './sanctions-screen.js';
import { registerComplianceRiskScore } from './compliance-risk-score.js';
import { registerFilingsFetch } from './filings-fetch.js';
import { registerBeneficialOwners } from './beneficial-owners.js';

export function registerAllTools(server: McpServer): void {
  registerEntityLookup(server);
  registerSanctionsScreen(server);
  registerComplianceRiskScore(server);
  registerFilingsFetch(server);
  registerBeneficialOwners(server);
}
