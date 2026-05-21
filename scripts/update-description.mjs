// Step 7: Update CorpSignal MCP tool description on Context Protocol marketplace
// Fixes: redundant "Description:" prefix, garbled checkmark encoding (â  â → •)

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '..', '.env');

const envVars = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const idx = l.indexOf('='); return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()]; })
);

const CTX_API_KEY = envVars['CONTEXT_API_KEY'];
const TOOL_ID = '81dfac76-5ac2-4caf-8146-db92bbbe98c2';

const description = `Real-time corporate registry verification, sanctions screening, compliance risk scoring, beneficial ownership lookup, and SEC/Companies House filings retrieval across US (all 50 states), UK, and Canada.

Features:
1. Entity verification across 50+ jurisdictions — queries live Secretary of State portals, UK Companies House, and SEC EDGAR to return registration status, incorporation date, registered agent, and officers in a normalised schema.
2. Six-list sanctions screening in one call — checks OFAC SDN, OFAC Consolidated, FinCEN, UN 1267, EU CFSP, and HM Treasury simultaneously and returns exact hits, normalised hits, and fuzzy candidates above a configurable threshold.
3. Transparent compliance risk scoring — generates a 0–1 risk score with every signal, weight, and contribution exposed in score_breakdown, combining registration status, sanctions result, officer records, data freshness, and FATF jurisdiction risk (formula version auditable).
4. Beneficial ownership and UBO lookup — UK entities via Companies House PSC register, US and global entities via GLEIF LEI registry with EDGAR Schedule 13G/D fallback for public companies with >5% holdings.
5. Corporate filings retrieval — recent SEC EDGAR filings for US public companies, Companies House filings for UK entities, SEDAR+ for Canadian public companies, with optional XBRL financial metric parsing from the latest 10-K.

Try asking:
1. Is Stripe Inc registered as an active company in Delaware?
2. Screen Barclays Bank PLC against all sanctions lists and tell me if it is clear.
3. Run a full due diligence check on Revolut Ltd in the UK: verify it is registered, screen it for sanctions, and give me a compliance risk score.
4. Who are the beneficial owners or persons with significant control of Revolut Ltd in the UK?
5. Compare the compliance risk scores for Apple Inc in Delaware and Gazprom in Russia. Which is higher and why?
6. Fetch the last 5 annual reports (10-K filings) for Apple Inc from SEC EDGAR.
7. Get the latest 10-K filing for Microsoft Corp and parse its financial metrics including revenue and net income.

Agent tips:
1. For fastest results, pass jurisdiction explicitly (e.g. US-DE, US-CA, GB, CA-ON) rather than leaving it for the tool to infer. Supported codes: US-XX for all 50 US states, GB for UK, CA/CA-BC/CA-ON/CA-AB/CA-QC for Canada.
2. For a complete counterparty check, call entity_lookup first to get the canonical entity_id, then pass that entity_id directly into sanctions_screen, compliance_risk_score, and beneficial_owners to skip name resolution on subsequent calls.
3. The compliance_risk_score tool calls entity_lookup and sanctions_screen internally, so you do not need to call those separately if a risk score is all that is required.
4. parse_financials on filings_fetch adds approximately 10 seconds on a cache miss and only works for US public companies with XBRL-tagged 10-K filings on SEC EDGAR.
5. Rate limits: entity_lookup and sanctions_screen allow 300 requests/min; compliance_risk_score 200; filings_fetch 150; beneficial_owners 100.`;

console.log('Updating description...');
console.log('Preview (first 200 chars):', description.slice(0, 200));

const res = await fetch(`https://www.ctxprotocol.com/api/v1/tools/${TOOL_ID}`, {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${CTX_API_KEY}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ description }),
});

if (!res.ok) {
  const body = await res.text();
  console.error(`PATCH failed ${res.status}:`, body);
  process.exit(1);
}

const updated = await res.json();
console.log('\nUpdated successfully.');
console.log('Description starts with:', updated.description?.slice(0, 100));
console.log('updatedAt:', updated.updatedAt);
