/**
 * Step 4 — Query Mode Marketplace Validation via @ctxprotocol/sdk
 * Runs the canonical "Try asking" prompt suite against the live marketplace listing.
 */

import { ContextClient } from '@ctxprotocol/sdk';

const CONTEXT_API_KEY = process.env.CONTEXT_API_KEY;
const TOOL_ID = '81dfac76-5ac2-4caf-8146-db92bbbe98c2';
const TOOL_NAME = 'CorpSignal MCP';

const client = new ContextClient({ apiKey: CONTEXT_API_KEY });

// Step 3.4 — Canonical "Try asking" prompt suite
// Covers: happy path, discovery, comparative, advanced filtered, multi-step, edge-case, power-user
const PROMPT_SUITE = [
  // 1. Core happy-path — entity lookup
  {
    id: 'P1',
    category: 'happy-path',
    prompt: 'Look up Stripe Inc in Delaware and tell me if it is an active registered entity.',
  },
  // 2. Discovery / listing
  {
    id: 'P2',
    category: 'discovery',
    prompt: 'What companies named "Global Holdings" are registered in the UK?',
  },
  // 3. Sanctions — clean entity
  {
    id: 'P3',
    category: 'happy-path',
    prompt: 'Screen Barclays Bank PLC against all sanctions lists and tell me if it is clear.',
  },
  // 4. Comparative — risk scores
  {
    id: 'P4',
    category: 'comparative',
    prompt: 'Compare the compliance risk scores for Apple Inc in Delaware and Gazprom in Russia. Which is higher and why?',
  },
  // 5. Advanced filtered — filings with type filter
  {
    id: 'P5',
    category: 'advanced-filtered',
    prompt: 'Fetch the last 5 annual reports (10-K filings) for Apple Inc from SEC EDGAR.',
  },
  // 6. Multi-step workflow — entity + sanctions + risk
  {
    id: 'P6',
    category: 'multi-step',
    prompt: 'Run a full due diligence check on Revolut Ltd in the UK: verify it is registered, screen it for sanctions, and give me a compliance risk score.',
  },
  // 7. Beneficial owners
  {
    id: 'P7',
    category: 'advanced-filtered',
    prompt: 'Who are the beneficial owners or persons with significant control of Revolut Ltd in the UK?',
  },
  // 8. Edge-case — entity not found
  {
    id: 'P8',
    category: 'edge-case',
    prompt: 'Look up "Definitely Not A Real Company XYZ123" in Delaware.',
  },
  // 9. Power-user — financial data
  {
    id: 'P9',
    category: 'power-user',
    prompt: 'Get the latest 10-K filing for Microsoft Corp and parse its financial metrics including revenue and net income.',
  },
  // 10. Jurisdiction breadth
  {
    id: 'P10',
    category: 'happy-path',
    prompt: 'Is Amazon.com Inc registered as an active company in Delaware?',
  },
];

const DETERMINISTIC_FAILURE_MARKERS = [
  'I am unable to',
  'I cannot provide',
  "I'm unable to",
  "I'm not able to",
  'I do not have',
  'no data available',
  'could not fulfill',
  'slug not found',
  'event not found',
  'market not found',
  'could not resolve',
  'not found',
];

function checkDeterministicFailure(text) {
  return DETERMINISTIC_FAILURE_MARKERS.filter(m => text.toLowerCase().includes(m.toLowerCase()));
}

async function runPrompt(entry) {
  const { id, prompt, category } = entry;
  const start = Date.now();
  let answer;
  try {
    answer = await client.query.run({
      query: prompt,
      tools: [TOOL_ID],
      queryDepth: 'deep',
      responseShape: 'answer_with_evidence',
      includeDeveloperTrace: true,
    });
  } catch (err) {
    return {
      id, category, prompt,
      pass: false,
      durationMs: Date.now() - start,
      error: err.message,
      failureMarkers: [],
      traceIssues: [],
    };
  }
  const durationMs = Date.now() - start;

  // ctx SDK v0.10: response is at answer.response, trace summary at answer.developerTrace.summary
  const responseText = answer?.response ?? answer?.answer ?? answer?.text ?? JSON.stringify(answer).slice(0, 500);
  const failureMarkers = checkDeterministicFailure(responseText);

  const traceSummary = answer?.developerTrace?.summary ?? {};
  const toolCalls = traceSummary.toolCalls ?? 0;
  const retryCount = traceSummary.retryCount ?? 0;
  const selfHealCount = traceSummary.selfHealCount ?? 0;
  const toolsUsed = (answer?.toolsUsed ?? []).map(t => t.name ?? t);

  const traceIssues = [];
  if (toolCalls === 0) traceIssues.push('Zero tool calls — tool was never invoked');
  if (retryCount > 3) traceIssues.push(`High retry count: ${retryCount}`);
  if (selfHealCount > 3) traceIssues.push(`High self-heal count: ${selfHealCount}`);

  const pass = failureMarkers.length === 0 && traceIssues.filter(t => t.includes('Zero')).length === 0;

  return {
    id, category, prompt,
    pass,
    durationMs,
    responseText: responseText.slice(0, 400),
    cost: answer?.cost?.totalCostUsd ?? null,
    toolsUsed,
    trace: { toolCalls, retryCount, selfHealCount },
    failureMarkers,
    traceIssues,
    evidence: answer?.evidence ?? null,
  };
}

async function main() {
  console.log('='.repeat(65));
  console.log('STEP 4 — QUERY MODE MARKETPLACE VALIDATION');
  console.log(`Tool ID:   ${TOOL_ID}`);
  console.log(`Tool Name: ${TOOL_NAME}`);
  console.log('='.repeat(65));

  // 4.1 Discover the tool
  console.log('\n[4.1] Discovering tool on marketplace...');
  try {
    const discovery = await client.discovery.search({
      query: TOOL_NAME,
      mode: 'query',
    });
    const match = (discovery?.tools ?? discovery ?? []).find?.(
      t => t.id === TOOL_ID || t.name?.toLowerCase().includes('corpsignal')
    );
    if (match) {
      console.log(`  ✅ Found: "${match.name ?? match.id}" (id=${match.id})`);
    } else {
      console.log('  ⚠️  Tool not found via discovery — may not be staked/activated yet');
      console.log('     Proceeding with pinned tool ID...');
    }
  } catch (err) {
    console.log(`  ⚠️  Discovery search failed: ${err.message} — proceeding with pinned ID`);
  }

  // 4.3 Execute prompt suite
  console.log(`\n[4.3] Running ${PROMPT_SUITE.length} prompts...\n`);
  const results = [];
  for (const entry of PROMPT_SUITE) {
    process.stdout.write(`  [${entry.id}] ${entry.prompt.slice(0, 60)}... `);
    const result = await runPrompt(entry);
    const icon = result.pass ? '✅' : '❌';
    console.log(`${icon} ${result.durationMs}ms`);
    if (result.error) console.log(`       Error: ${result.error}`);
    if (result.failureMarkers.length) result.failureMarkers.forEach(m => console.log(`       ❌ Deterministic failure: "${m}"`));
    if (result.traceIssues.length) result.traceIssues.forEach(t => console.log(`       ⚠️  ${t}`));
    if (result.trace) console.log(`       trace: toolCalls=${result.trace.toolCalls} retries=${result.trace.retryCount} heals=${result.trace.selfHealCount} cost=$${result.cost ?? 'n/a'}`);
    if (result.responseText) console.log(`       response: ${result.responseText.slice(0, 200)}...`);
    results.push(result);
  }

  // Final sign-off
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const deterministicFails = results.filter(r => r.failureMarkers.length > 0);
  const zeroToolCalls = results.filter(r => r.trace?.toolCalls === 0);
  const avgCost = results
    .filter(r => r.cost != null)
    .reduce((s, r) => s + parseFloat(r.cost), 0) / Math.max(1, results.filter(r => r.cost != null).length);

  console.log('\n' + '='.repeat(65));
  console.log('STEP 4 FINAL SIGN-OFF');
  console.log('='.repeat(65));
  console.log(`Query mode: ${passed}/${results.length} PASS, ${failed} FAIL`);
  console.log(`Deterministic failures: ${deterministicFails.length}`);
  console.log(`Zero tool-call failures: ${zeroToolCalls.length}`);
  console.log(`Average cost/query: $${avgCost.toFixed(5)}`);
  console.log('');
  results.forEach(r => {
    const s = r.pass ? '✅' : '❌';
    const marker = r.failureMarkers.length ? ` [DETERMINISTIC: ${r.failureMarkers[0]}]` : '';
    const trace = r.trace ? ` tools=${r.trace.toolCalls}` : '';
    console.log(`  ${s} [${r.id}] ${r.category}${marker}${trace}`);
  });
  console.log('');
  if (failed === 0) {
    console.log('Query mode marketplace: ✅ PASS');
  } else {
    console.log('Query mode marketplace: ❌ FAIL — entering Step 6 fix loop');
    console.log('\nFailed prompts:');
    results.filter(r => !r.pass).forEach(r => {
      console.log(`  [${r.id}] ${r.prompt}`);
      console.log(`       markers: ${r.failureMarkers.join('; ') || 'none'}`);
      console.log(`       trace issues: ${r.traceIssues.join('; ') || 'none'}`);
      if (r.error) console.log(`       error: ${r.error}`);
    });
  }
}

main().catch(err => { console.error('Fatal:', err.stack); process.exit(1); });
