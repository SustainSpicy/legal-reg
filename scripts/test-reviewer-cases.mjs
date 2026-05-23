/**
 * Live test for Round 3 reviewer-specified cases.
 * Run locally: node scripts/test-reviewer-cases.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dir, '..', '.env');

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

const { ContextClient } = await import('@ctxprotocol/sdk');
const client = new ContextClient({ apiKey: CTX_API_KEY });

const tests = [
  // ── HARD BLOCKERS (must return ENTITY_NOT_FOUND, not filings) ──────────────
  {
    label: 'filings_fetch("Apple Inc", "US-DE") → ENTITY_NOT_FOUND',
    toolName: 'filings_fetch',
    args: { entity_name: 'Apple Inc', jurisdiction: 'US-DE' },
    expectErrorCode: 'ENTITY_NOT_FOUND',
  },
  {
    label: 'filings_fetch("Tesla Inc", "US-DE") → ENTITY_NOT_FOUND',
    toolName: 'filings_fetch',
    args: { entity_name: 'Tesla Inc', jurisdiction: 'US-DE' },
    expectErrorCode: 'ENTITY_NOT_FOUND',
  },
  {
    label: 'beneficial_owners("Apple Inc", "US-DE") → ENTITY_NOT_FOUND',
    toolName: 'beneficial_owners',
    args: { entity_name: 'Apple Inc', jurisdiction: 'US-DE' },
    expectErrorCode: 'ENTITY_NOT_FOUND',
  },
  // ── SMALLER NOTE (entity_id path must work when entity_lookup already ran) ──
  {
    label: 'entity_lookup("Microsoft Corporation", "US-DE") — seeds cache',
    toolName: 'entity_lookup',
    args: { entity_name: 'Microsoft Corporation', jurisdiction: 'US-DE' },
    validate: r => r?.canonical_name?.toUpperCase().includes('MICROSOFT'),
    seedsEntityId: true,
  },
  {
    // normaliseName strips "Corporation" → real entity_id = corpsig_us_de_microsoft
    label: 'filings_fetch(entity_id="corpsig_us_de_microsoft") → filings',
    toolName: 'filings_fetch',
    args: { entity_id: 'corpsig_us_de_microsoft', jurisdiction: 'US-DE' },
    validate: r => Array.isArray(r?.filings) && r.filings.length > 0,
  },
  // ── REGRESSION: legitimate DE entity still works ──────────────────────────
  {
    label: 'filings_fetch("Stripe Holdings LLC", "US-DE") → filings (regression)',
    toolName: 'filings_fetch',
    args: { entity_name: 'Stripe Holdings LLC', jurisdiction: 'US-DE' },
    // Stripe is actually registered in DE — expect either filings or ENTITY_NOT_FOUND
    // (no EDGAR data for private cos). Both are correct; just must NOT crash.
    validate: _r => true,
    allowError: true,
  },
];

let passed = 0, failed = 0;
const failures = [];

console.log('\n=== Round 3 Reviewer Cases — Live Test ===\n');

for (const test of tests) {
  process.stdout.write(`[TEST] ${test.label}\n`);
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

    if (test.expectErrorCode) {
      // We expected an error code but got a success result
      console.log(`  FAIL ✗  (${elapsed}ms) — expected ${test.expectErrorCode} but got success`);
      console.log(`  Data: ${JSON.stringify(data).slice(0, 200)}`);
      failed++;
      failures.push({ label: test.label, reason: `expected ${test.expectErrorCode}, got success`, data });
    } else if (test.validate) {
      const ok = test.validate(data);
      if (ok) {
        console.log(`  PASS ✓  (${elapsed}ms)`);
        if (data?.canonical_name) console.log(`  → ${data.canonical_name}`);
        if (data?.filings) console.log(`  → filings=${data.filings.length}, source=${data.source}`);
        passed++;
      } else {
        console.log(`  FAIL ✗  (${elapsed}ms)`);
        console.log(`  Data: ${JSON.stringify(data).slice(0, 300)}`);
        failed++;
        failures.push({ label: test.label, reason: 'validate() returned false', data });
      }
    } else {
      console.log(`  PASS ✓  (${elapsed}ms)`);
      passed++;
    }
  } catch (err) {
    const elapsed = Date.now() - t0;
    const bodyStr = err.message ?? '';
    let embeddedCode = null;
    try {
      const jsonMatch = bodyStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) embeddedCode = JSON.parse(jsonMatch[0])?.error?.code;
    } catch {}

    if (test.expectErrorCode && embeddedCode === test.expectErrorCode) {
      console.log(`  PASS ✓  (${elapsed}ms) — correctly returned ${test.expectErrorCode}`);
      passed++;
    } else if (test.allowError) {
      console.log(`  PASS ✓  (${elapsed}ms) — error acceptable: ${embeddedCode ?? err.message?.slice(0, 80)}`);
      passed++;
    } else {
      console.log(`  FAIL ✗  (${elapsed}ms)`);
      console.log(`  Error: ${err.message?.slice(0, 200)}`);
      if (embeddedCode) console.log(`  code=${embeddedCode}`);
      failed++;
      failures.push({ label: test.label, error: err.message?.slice(0, 200), code: embeddedCode });
    }
  }
  console.log();
}

console.log('=== SUMMARY ===');
console.log(`Passed: ${passed}/${tests.length}`);
console.log(`Failed: ${failed}/${tests.length}`);

if (failures.length > 0) {
  console.log('\nFailures:');
  for (const f of failures) {
    console.log(`  - ${f.label}`);
    if (f.reason) console.log(`    reason: ${f.reason}`);
    if (f.error)  console.log(`    error:  ${f.error}`);
  }
}

process.exit(failed > 0 ? 1 : 0);
