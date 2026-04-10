import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import { connectRedis } from './cache/client.js';
import { registerAllTools } from './tools/index.js';
import { startSanctionsIngestCron, runSanctionsIngest } from './ingest/sanctions.js';
import { startSOSIngestCron } from './ingest/sos-portals.js';
import { startSOSScraperCron } from './ingest/sos-scraper.js';
import { startCompaniesHouseCron } from './ingest/companies-house.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

function validateEnv(): void {
  const edgarEmail = process.env['EDGAR_CONTACT_EMAIL'];
  if (!edgarEmail || edgarEmail.includes('yourdomain') || edgarEmail.includes('example.com')) {
    console.warn(
      '[server] WARNING: EDGAR_CONTACT_EMAIL is a placeholder. ' +
      'EDGAR User-Agent policy requires a real contact email. ' +
      'Set EDGAR_CONTACT_EMAIL in your .env to avoid rate-limiting or IP blocks from SEC.',
    );
  }

  const contextKey = process.env['CONTEXT_API_KEY'];
  if (!contextKey || contextKey.startsWith('sk_live_') === false) {
    console.warn('[server] WARNING: CONTEXT_API_KEY is missing or not a live key — tool billing will not work.');
  }
}

async function main(): Promise<void> {
  validateEnv();
  // Connect to Redis — if unavailable, tools fall back to live upstream with stale flag
  await connectRedis();

  // Seed sanctions lists immediately on startup, then keep them fresh via cron
  await runSanctionsIngest();

  // Start all background ingestion crons
  startSanctionsIngestCron();
  startSOSIngestCron();
  startSOSScraperCron();
  startCompaniesHouseCron();

  const app = express();
  app.use(express.json());

  // Health check — useful for Railway / uptime monitors
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '1.0.0', timestamp: new Date().toISOString() });
  });

  // createContextMiddleware() secures paid tool calls.
  // Free discovery methods (tools/list, tools/describe) pass through without billing.
  // Skipped in development (NODE_ENV=development) so local curl/testing works without a token.
  if (process.env['NODE_ENV'] !== 'development') {
    app.use('/mcp', createContextMiddleware());
  } else {
    console.log('[server] Development mode — Context auth middleware disabled');
  }

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({
      name: 'corpsignal-mcp',
      version: '1.0.0',
    });

    registerAllTools(server);

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.listen(PORT, () => {
    console.log(`[server] CorpSignal MCP running on :${PORT}`);
    console.log(`[server] MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`[server] Health check: http://localhost:${PORT}/health`);
  });
}

main().catch((err: unknown) => {
  console.error('[server] Fatal startup error:', err);
  process.exit(1);
});
