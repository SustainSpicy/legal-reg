// MCP Contributor Deep Validation Script
// Runs Steps 3–7 of the Deep Validation System Prompt via @ctxprotocol/sdk

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '..', '.env');

// Load .env manually
const envVars = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split('\n')
    .filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => {
      const idx = l.indexOf('=');
      return [l.slice(0, idx).trim(), l.slice(idx + 1).trim()];
    })
);

const CTX_API_KEY = envVars['CONTEXT_API_KEY'];
const TOOL_ID = '81dfac76-5ac2-4caf-8146-db92bbbe98c2';

if (!CTX_API_KEY) { console.error('CONTEXT_API_KEY not found in .env'); process.exit(1); }

// Dynamic import of SDK
const { ContextClient } = await import('@ctxprotocol/sdk');

const client = new ContextClient({ apiKey: CTX_API_KEY });

console.log('\n=== STEP 3: Marketplace Discovery ===');
let toolMeta;
try {
  toolMeta = await client.discovery.get(TOOL_ID);
  console.log('Tool ID:', toolMeta.id);
  console.log('Name:', toolMeta.name);
  console.log('Description:', toolMeta.description?.slice(0, 120) + '...');
  console.log('MCP Tools:', toolMeta.mcpTools?.map(t => t.name).join(', '));
  console.log('Pricing:', JSON.stringify(toolMeta.pricing ?? 'none'));
  console.log('Status: DISCOVERED ✓');
} catch (err) {
  console.error('Discovery failed:', err.message);
  process.exit(1);
}

// Canonical test suite
const tests = [
  {
    step: 'entity_lookup — exact DE match',
    toolName: 'entity_lookup',
    args: { entity_name: 'Stripe Holdings LLC', jurisdiction: 'US-DE' },
    validate: r => r?.canonical_name?.includes('STRIPE') && r?.status,
  },
  {
    step: 'entity_lookup — no-match returns ENTITY_NOT_FOUND',
    toolName: 'entity_lookup',
    args: { entity_name: 'ZZZQ Fake Holdings XYZ123 LLC', jurisdiction: 'US-DE' },
    // SDK throws execution_failed with ENTITY_NOT_FOUND code — expected correct behavior
    expectErrorCode: 'ENTITY_NOT_FOUND',
    validate: r => false,
  },
  {
    step: 'entity_lookup — Microsoft Corp US-DE exact',
    toolName: 'entity_lookup',
    args: { entity_name: 'Microsoft Corporation', jurisdiction: 'US-DE' },
    validate: r => r?.canonical_name?.toUpperCase().includes('MICROSOFT'),
  },
  {
    step: 'sanctions_screen — clean entity',
    toolName: 'sanctions_screen',
    args: { entity_name: 'Apple Inc' },
    validate: r => r?.clear === true && Array.isArray(r?.hits) && r.hits.length === 0,
  },
  {
    step: 'sanctions_screen — known sanctioned name (Mahan Air)',
    toolName: 'sanctions_screen',
    args: { entity_name: 'Mahan Air' },
    validate: r => r?.clear === false && Array.isArray(r?.hits) && r.hits.length > 0,
  },
  {
    step: 'compliance_risk_score',
    toolName: 'compliance_risk_score',
    args: { entity_name: 'Microsoft Corporation', jurisdiction: 'US-DE' },
    validate: r => typeof r?.risk_score === 'number' && r.risk_score >= 0 && r.risk_score <= 1,
  },
  {
    step: 'filings_fetch — public company',
    toolName: 'filings_fetch',
    args: { entity_name: 'Microsoft Corporation', jurisdiction: 'US' },
    validate: r => Array.isArray(r?.filings) && r.filings.length > 0,
  },
  {
    step: 'beneficial_owners — UK entity',
    toolName: 'beneficial_owners',
    args: { entity_name: 'Barclays PLC', jurisdiction: 'GB' },
    validate: r => r != null,
  },
];

console.log('\n=== STEPS 4+5: Query + Execute Mode Validation ===');

let passed = 0, failed = 0;
const failures = [];

for (const test of tests) {
  process.stdout.write(`\n[TEST] ${test.step}\n`);
  const t0 = Date.now();
  try {
    const result = await client.tools.execute({
      toolId: TOOL_ID,
      toolName: test.toolName,
      args: test.args,
      mode: 'execute',
    });
    const elapsed = Date.now() - t0;
    const data = result.result;
    const ok = test.validate(data);
    if (ok) {
      console.log(`  PASS ✓  (${elapsed}ms)`);
      if (data?.canonical_name) console.log(`  → ${data.canonical_name} | ${data.status} | conf=${data.confidence}`);
      if (data?.risk_score !== undefined) console.log(`  → risk_score=${data.risk_score}`);
      if (data?.matches) console.log(`  → matches=${data.matches.length}`);
      if (data?.filings) console.log(`  → filings=${data.filings.length}`);
      passed++;
    } else {
      console.log(`  FAIL ✗  (${elapsed}ms)`);
      console.log('  Raw result:', JSON.stringify(data).slice(0, 300));
      failed++;
      failures.push({ test: test.step, data });
    }
  } catch (err) {
    const elapsed = Date.now() - t0;
    // Some tools signal "not found" via SDK execution_failed with a known code embedded in message
    const bodyStr = err.message ?? '';
    let embeddedCode = null;
    try {
      const jsonMatch = bodyStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) embeddedCode = JSON.parse(jsonMatch[0])?.error?.code;
    } catch {}
    if (test.expectErrorCode && embeddedCode === test.expectErrorCode) {
      console.log(`  PASS ✓  (${elapsed}ms) — correctly returned ${test.expectErrorCode}`);
      passed++;
    } else {
      console.log(`  ERROR ✗  (${elapsed}ms): ${err.message}`);
      if (err.code) console.log(`  code=${err.code} helpUrl=${err.helpUrl}`);
      failed++;
      failures.push({ test: test.step, error: err.message, code: err.code });
    }
  }
}

console.log('\n=== VALIDATION SUMMARY ===');
console.log(`Passed: ${passed}/${tests.length}`);
console.log(`Failed: ${failed}/${tests.length}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.test}: ${f.error ?? JSON.stringify(f.data).slice(0, 150)}`);
  }
}

console.log('\nValidation complete.');
process.exit(failed > 0 ? 1 : 0);
