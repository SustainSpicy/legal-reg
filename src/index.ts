import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createContextMiddleware } from '@ctxprotocol/sdk';
import rateLimit from 'express-rate-limit';
import { connectRedis, redis, isRedisConnected } from './cache/client.js';
import { getCached, sanctionsCacheKey } from './cache/helpers.js';
import { registerAllTools } from './tools/index.js';
import { startSanctionsIngestCron, runSanctionsIngest } from './ingest/sanctions.js';
import { startSOSIngestCron } from './ingest/sos-portals.js';
import { startSOSScraperCron } from './ingest/sos-scraper.js';
import { startCompaniesHouseCron, handleCompaniesHouseWebhook } from './ingest/companies-house.js';
import { logger, httpLogger } from './logger.js';

const PORT = parseInt(process.env['PORT'] ?? '3000', 10);

function validateEnv(): void {
  const edgarEmail = process.env['EDGAR_CONTACT_EMAIL'];
  if (!edgarEmail || edgarEmail.includes('yourdomain') || edgarEmail.includes('example.com')) {
    logger.warn(
      'EDGAR_CONTACT_EMAIL is a placeholder. ' +
      'EDGAR User-Agent policy requires a real contact email.',
    );
  }

  const contextKey = process.env['CONTEXT_API_KEY'];
  if (!contextKey || !contextKey.startsWith('sk_live_')) {
    logger.warn('CONTEXT_API_KEY is missing or not a live key — tool billing will not work.');
  }

  if (!process.env['COMPANIES_HOUSE_WEBHOOK_SECRET']) {
    logger.warn('COMPANIES_HOUSE_WEBHOOK_SECRET not set — webhook signature verification disabled.');
  }
}

// ---- Webhook HMAC verification -----------------------------------------------
// Companies House signs webhook payloads with HMAC-SHA256 of the raw body.
// Without the secret configured, verification is skipped (warn-only).

function verifyWebhookSignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  const secret = process.env['COMPANIES_HOUSE_WEBHOOK_SECRET'];
  if (!secret) return true; // Unconfigured — allow through (startup warning already logged)
  if (!signatureHeader) return false;

  const expected = createHmac('sha256', secret).update(rawBody).digest('base64');
  try {
    return timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ---- Rate limiter ------------------------------------------------------------
// Provides a safety-net floor even when Context Protocol middleware is disabled
// (e.g. development mode). 300 req/min matches the declared tool rateLimit.

const mcpRateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'Too many requests — please slow down.' },
  },
});

async function main(): Promise<void> {
  validateEnv();
  await connectRedis();

  // Pre-warm sanctions cache on startup; cron keeps it fresh thereafter
  await runSanctionsIngest();

  startSanctionsIngestCron();
  startSOSIngestCron();
  startSOSScraperCron();
  startCompaniesHouseCron();

  const app = express();

  // Structured HTTP request/response logging (skips /health to reduce noise)
  app.use(httpLogger);

  // Parse JSON with a hard body size cap.
  // The verify callback captures the raw buffer needed for webhook HMAC checks.
  app.use(
    express.json({
      limit: '50kb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );

  // ---- Health check ----------------------------------------------------------
  // Returns 200 / 503 based on Redis connectivity and sanctions list presence.
  // Render and uptime monitors use this to decide whether to route traffic.

  app.get('/health', async (_req, res) => {
    const redisOk = isRedisConnected();
    let sanctionsLoaded = false;
    if (redisOk) {
      const sample = await getCached<unknown[]>(sanctionsCacheKey('OFAC_SDN'));
      sanctionsLoaded = Array.isArray(sample) && sample.length > 0;
    }

    res.status(redisOk ? 200 : 503).json({
      status: redisOk ? 'ok' : 'degraded',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      dependencies: {
        redis: redisOk ? 'connected' : 'disconnected',
        sanctions: sanctionsLoaded ? 'loaded' : 'pending',
      },
    });
  });

  // ---- Webhook: Companies House ----------------------------------------------
  // ACK immediately (CH requires 200 within 5s) then process async.
  // Requests without a valid HMAC-SHA256 signature are rejected with 401.

  app.post('/webhooks/companies-house', (req, res) => {
    const sig = req.headers['x-companies-house-signature'] as string | undefined;
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;

    if (!verifyWebhookSignature(rawBody ?? Buffer.alloc(0), sig)) {
      logger.warn({ sig }, 'Rejected Companies House webhook — invalid signature');
      res.status(401).json({ error: 'Invalid signature' });
      return;
    }

    res.status(200).json({ received: true });
    void handleCompaniesHouseWebhook(req.body as unknown);
  });

  // ---- MCP endpoint ---------------------------------------------------------
  // Context Protocol middleware enforces billing on paid tool calls.
  // Rate limiter applies in all environments as a safety-net floor.

  if (process.env['NODE_ENV'] !== 'development') {
    app.use('/mcp', createContextMiddleware());
  } else {
    logger.info('Development mode — Context auth middleware disabled');
  }

  app.use('/mcp', mcpRateLimiter);

  app.post('/mcp', async (req, res) => {
    const server = new McpServer({ name: 'corpsignal-mcp', version: '1.0.0' });
    registerAllTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Stateless transport — no persistent SSE session. Return 405 so clients
  // fall back to POST-only mode rather than treating this as a missing endpoint.
  app.get('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      error: 'SSE streaming not supported — server uses stateless POST transport',
    });
  });

  app.delete('/mcp', (_req, res) => {
    res.status(405).set('Allow', 'POST').json({
      error: 'Session management not supported — server uses stateless POST transport',
    });
  });

  // ---- Start server ----------------------------------------------------------

  const httpServer = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'CorpSignal MCP server started');
    logger.info(`MCP endpoint:   http://localhost:${PORT}/mcp`);
    logger.info(`Health check:   http://localhost:${PORT}/health`);
  });

  // ---- Graceful shutdown -----------------------------------------------------
  // Render (and most PaaS) sends SIGTERM before terminating the container.
  // We stop accepting new connections and wait up to 10s for in-flight requests
  // to complete before closing Redis and exiting cleanly.

  function shutdown(signal: string): void {
    logger.info({ signal }, 'Shutdown signal received — draining connections');
    httpServer.close(async () => {
      await redis.quit().catch(() => {});
      logger.info('Graceful shutdown complete');
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000).unref();
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
