import pino from 'pino';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: { service: 'corpsignal-mcp' },
});

// Lightweight HTTP request logger middleware — attach to Express with app.use(httpLogger)
export function httpLogger(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  // Skip health check polling to avoid log noise
  if (req.url === '/health') { next(); return; }

  const start = Date.now();
  res.on('finish', () => {
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]({
      method: req.method,
      url: req.url,
      status: res.statusCode,
      ms: Date.now() - start,
    });
  });
  next();
}
