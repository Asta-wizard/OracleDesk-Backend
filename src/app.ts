import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import hpp from 'hpp';

import { config } from './config';
import { prisma } from './lib/prisma';
import { logger } from './lib/logger';
import { acceptInboundId, currentContext, newId, runInContext, runWithContext } from './lib/context';
import { sendError } from './utils/response.util';
import { errorMiddleware } from './middlewares/error.middleware';
import { globalLimiter } from './middlewares/rate-limit.middleware';
import { abortMiddleware } from './middlewares/abort.middleware';
import router from './routes';

const app = express();

// BigInt (u64 market ids, i128 amounts) serialises as a decimal string.
app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));

// ─── Correlation id ───
// First, so even requests rejected by helmet/CORS/body parsing carry an id.
app.use((req, res, next) => {
  const raw = req.get('x-request-id');
  const inbound = acceptInboundId(raw);
  if (raw && !inbound) logger.debug({ length: raw.length }, 'Ignoring malformed X-Request-Id'); // never log the value
  const requestId = inbound ?? newId('req');
  res.setHeader('X-Request-Id', requestId);
  runWithContext({ requestId, kind: 'http' }, () => {
    res.locals.requestContext = currentContext();
    next();
  });
});

// ─── Security ───
app.use(helmet());
app.use(hpp());
app.use(cors({
  // Explicit allowlist from CORS_ORIGINS; never "*" with credentials.
  origin: (origin, callback) => {
    // Requests without an Origin header (curl, server-to-server) carry no
    // browser credentials, so CORS doesn't apply to them.
    if (!origin || config.CORS_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
  // #123: let browsers send Idempotency-Key and read Idempotent-Replayed.
  allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'],
  exposedHeaders: ['Idempotent-Replayed', 'Retry-After', 'X-Request-Id'],
}));

// ─── Rate Limiting ───
app.use(globalLimiter);

// ─── Body Parsing + Compression ───
app.use(compression());
app.use(express.json({ limit: '1mb' }));
// Stream-based body parsing can resume handlers outside the request's async
// context; re-enter it so everything downstream stays correlated.
app.use((_req, res, next) => runInContext(res.locals.requestContext, next));

// ─── HTTP Logging ───
// Paths only: the route template, never the query string or referrer.
app.use((req, res, next) => {
  if (config.NODE_ENV !== 'test') {
    const ctx = currentContext();
    res.on('finish', () => {
      const log = () =>
        logger.info(
          {
            method: req.method,
            route: req.route ? req.baseUrl + req.route.path : 'unmatched',
            status: res.statusCode,
            durationMs: Date.now() - (ctx?.startedAt ?? Date.now()),
            contentLength: res.getHeader('content-length'),
          },
          'http',
        );
      // 'finish' listeners may not run inside the request's context.
      if (ctx) runInContext(ctx, log);
      else log();
    });
  }
  next();
});

// ─── Request Timeout & Abort Signal ───
app.use(abortMiddleware);

// ─── Health Check ───
app.get('/health', (_req, res) => {
  res.json({ ok: true, data: { status: 'healthy', uptime: process.uptime() }, error: null });
});

// Readiness for rolling deploys (#144): the process is only ready when it can
// reach the database. Keep this cheap — it runs every few seconds.
app.get('/readyz', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, data: { status: 'ready' }, error: null });
  } catch {
    sendError(res, 503, 'NOT_READY', 'Database is not reachable');
  }
});

// ─── API Routes ───
app.use('/api/v1', router);

// ─── 404 Handler ───
app.use((_req, res) => {
  sendError(res, 404, 'NOT_FOUND', 'Route not found');
});

// ─── Global Error Handler ───
app.use(errorMiddleware);

export default app;
