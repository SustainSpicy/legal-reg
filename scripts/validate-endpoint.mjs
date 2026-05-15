/**
 * Step 2 — Direct endpoint validation via raw HTTP (MCP over HTTP/SSE)
 * Bypasses SDK transport to avoid multi-replica session routing issues.
 */

const ENDPOINT = 'https://corpsignal.vctry4real.dev/mcp';

const SMOKE_CASES = [
  {
    tool: 'entity_lookup',
    args: { entity_name: 'Stripe Inc', jurisdiction: 'US-DE', include_officers: true, include_registered_agent: true },
  },
  {
    tool: 'sanctions_screen',
    args: { entity_name: 'Barclays Bank PLC', jurisdiction: 'GB', lists: ['OFAC_SDN', 'OFAC_CONS', 'FinCEN', 'UN_1267', 'EU_CFSP', 'HM_TREASURY'], fuzzy_threshold: 0.85 },
  },
  {
    tool: 'compliance_risk_score',
    args: { entity_name: 'Apple Inc', jurisdiction: 'US-DE' },
  },
  {
    tool: 'filings_fetch',
    args: { entity_name: 'Apple Inc', jurisdiction: 'US-DE', filing_types: ['10-K'], limit: 3, parse_financials: false },
  },
  {
    tool: 'beneficial_owners',
    args: { entity_name: 'Revolut Ltd', jurisdiction: 'GB' },
  },
];

const REFUSALS = [
  'I am unable to', 'I cannot provide', "I'm unable to", 'I do not have',
  'no data available', 'could not fulfill', 'could not resolve',
];

function parseSseBody(text) {
  // SSE format: "event: message\ndata: {...}\n\n"
  const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
  if (!dataLines.length) return null;
  try { return JSON.parse(dataLines[dataLines.length - 1].slice(6)); } catch { return null; }
}

async function mcpPost(body, sessionId = null) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = parseSseBody(text) ?? (() => { try { return JSON.parse(text); } catch { return null; } })();
  return { status: res.status, sessionId: res.headers.get('mcp-session-id'), parsed, raw: text };
}

async function initSession() {
  const r = await mcpPost({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'corpsignal-validator', version: '1.0' } },
  });
  if (r.status !== 200) throw new Error(`Initialize failed: HTTP ${r.status} ${r.raw}`);
  if (!r.sessionId) throw new Error('No mcp-session-id returned from initialize');
  // Send initialized notification
  await mcpPost({ jsonrpc: '2.0', method: 'notifications/initialized' }, r.sessionId);
  return r.sessionId;
}

async function listTools(sessionId) {
  const r = await mcpPost({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
  if (r.status !== 200) throw new Error(`listTools failed: ${r.status}`);
  return r.parsed?.result?.tools ?? [];
}

async function callTool(sessionId, id, name, args) {
  const start = Date.now();
  const r = await mcpPost({
    jsonrpc: '2.0', id,
    method: 'tools/call',
    params: { name, arguments: args },
  }, sessionId);
  const ms = Date.now() - start;
  return { ...r, ms };
}

function auditSchema(tool) {
  const issues = [];
  const REQUIRED_META = ['surface', 'queryEligible', 'latencyClass', 'pricing', 'rateLimit'];
  if (!tool.outputSchema) issues.push('MISSING outputSchema (Data Broker Standard violation)');
  if (!tool._meta) { issues.push('MISSING _meta entirely'); }
  else {
    for (const f of REQUIRED_META) {
      if (!(f in tool._meta)) issues.push(`_meta missing: ${f}`);
    }
  }
  const noDesc = Object.entries(tool.inputSchema?.properties ?? {})
    .filter(([, v]) => !v.description).map(([k]) => k);
  if (noDesc.length) issues.push(`inputSchema props without description: ${noDesc.join(', ')}`);
  return issues;
}

function auditResponse(toolResult) {
  const issues = [];
  if (!toolResult.parsed) { issues.push('Could not parse response'); return issues; }
  if (toolResult.status !== 200) issues.push(`HTTP ${toolResult.status}`);
  const rpc = toolResult.parsed;
  if (rpc.error) { issues.push(`JSON-RPC error: ${JSON.stringify(rpc.error)}`); return issues; }
  const toolRes = rpc.result;
  if (!toolRes) { issues.push('No result in RPC response'); return issues; }
  if (!toolRes.content?.length) issues.push('content array is empty or missing');
  if (!toolRes.structuredContent) issues.push('MISSING structuredContent — ctx planner cannot parse');
  if (toolRes.isError) issues.push(`isError=true — error path hit`);
  const text = (toolRes.content ?? []).map(c => c.text ?? '').join(' ');
  for (const r of REFUSALS) {
    if (text.includes(r)) issues.push(`Deterministic failure gate: "${r}" found in text`);
  }
  return issues;
}

async function main() {
  console.log('='.repeat(65));
  console.log('STEP 2 — DIRECT ENDPOINT VALIDATION');
  console.log(`Endpoint: ${ENDPOINT}`);
  console.log('='.repeat(65));

  // 2.1 Connection + initialize
  console.log('\n[2.1] Connecting and initializing...');
  let sessionId;
  try {
    sessionId = await initSession();
    console.log(`  ✅ Connected  sessionId=${sessionId}`);
  } catch (err) {
    console.error(`  ❌ Connection FAILED: ${err.message}`);
    process.exit(1);
  }

  // 2.1 Tool discovery
  const tools = await listTools(sessionId);
  console.log(`\n[2.1] Discovered ${tools.length} tool(s): ${tools.map(t => t.name).join(', ')}`);

  // 2.2 Schema quality audit
  console.log('\n[2.2] Schema Quality Audit');
  console.log('-'.repeat(45));
  let schemaIssueCount = 0;
  for (const tool of tools) {
    const issues = auditSchema(tool);
    schemaIssueCount += issues.length;
    const icon = issues.length ? '⚠️ ' : '✅';
    console.log(`  ${icon} ${tool.name}`);
    console.log(`       surface=${tool._meta?.surface} queryEligible=${tool._meta?.queryEligible} latency=${tool._meta?.latencyClass} price=$${tool._meta?.pricing?.executeUsd ?? 'unset'}`);
    if (issues.length) issues.forEach(i => console.log(`       ❌ ${i}`));
  }

  // 2.3 Smoke tests (all in same session — same replica guaranteed)
  console.log('\n[2.3] Smoke Tests');
  console.log('-'.repeat(45));
  const smokeResults = [];
  let rpcId = 10;
  for (const { tool, args } of SMOKE_CASES) {
    process.stdout.write(`  Testing ${tool}... `);
    let r;
    try {
      r = await callTool(sessionId, rpcId++, tool, args);
    } catch (err) {
      console.log(`❌ EXCEPTION: ${err.message}`);
      smokeResults.push({ tool, pass: false, ms: 0, issues: [`exception: ${err.message}`] });
      continue;
    }
    const issues = auditResponse(r);
    const pass = issues.length === 0;
    console.log(`${pass ? '✅ PASS' : '❌ FAIL'} (${r.ms}ms)`);
    if (issues.length) issues.forEach(i => console.log(`         - ${i}`));
    // Show structured content preview
    const sc = r.parsed?.result?.structuredContent;
    if (sc) {
      const preview = JSON.stringify(sc).slice(0, 250);
      console.log(`         structuredContent: ${preview}${JSON.stringify(sc).length > 250 ? '...' : ''}`);
    }
    smokeResults.push({ tool, pass, ms: r.ms, issues });
  }

  // Final sign-off
  const passed = smokeResults.filter(r => r.pass).length;
  const failed = smokeResults.filter(r => !r.pass).length;
  console.log('\n' + '='.repeat(65));
  console.log('STEP 2 FINAL RESULTS');
  console.log('='.repeat(65));
  console.log(`Schema issues found: ${schemaIssueCount}`);
  console.log(`Smoke tests: ${passed}/${smokeResults.length} passed, ${failed} failed`);
  smokeResults.forEach(r => {
    console.log(`  ${r.pass ? '✅' : '❌'} ${r.tool.padEnd(25)} ${r.ms}ms`);
    r.issues.forEach(i => console.log(`       - ${i}`));
  });
  console.log('');
  if (failed > 0 || schemaIssueCount > 0) {
    console.log('⚠️  Issues found — see Step 6 fix loop');
  } else {
    console.log('✅ Step 2 PASS — ready for marketplace validation');
  }
}

main().catch(err => { console.error('Fatal:', err.stack); process.exit(1); });
