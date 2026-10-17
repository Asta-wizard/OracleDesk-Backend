import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import hpp from 'hpp';

import { config } from './config';
import { logger } from './lib/logger';
import { errorMiddleware } from './middlewares/error.middleware';
import { globalLimiter } from './middlewares/rate-limit.middleware';
import { abortMiddleware } from './middlewares/abort.middleware';
import router from './routes';
import { createHealthRouter } from './routes/health.routes';
import { health } from './services/health.service';

const app = express();

// BigInt (u64 market ids, i128 amounts) serialises as a decimal string.
app.set('json replacer', (_key: string, value: unknown) => (typeof value === 'bigint' ? value.toString() : value));

// ─── Liveness / Readiness (#111) ───
// Before the rate limiter, compression and CORS: orchestrators poll often from one IP.
app.use(createHealthRouter(health));

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
  exposedHeaders: ['Idempotent-Replayed', 'Retry-After'],
}));

// ─── Rate Limiting ───
app.use(globalLimiter);

// ─── Body Parsing + Compression ───
app.use(compression());
app.use(express.json({ limit: '1mb' }));

// ─── HTTP Logging ───
// Paths only: morgan's "combined" format would log query strings and referrers.
app.use(
  morgan(':method :url :status :res[content-length] - :response-time ms', {
    stream: { write: (msg) => logger.info(msg.trim()) },
    skip:   () => config.NODE_ENV === 'test',
  }),
);

// ─── Request Timeout & Abort Signal ───
app.use(abortMiddleware);

// ─── Health Check ───
// Deprecated in favour of /livez and /readyz; response shape is unchanged.
app.get('/health', (_req, res) => {
  res.setHeader('Deprecation', 'true');
  res.setHeader('Link', '</readyz>; rel="successor-version"');
  res.json({ ok: true, data: { status: 'healthy', uptime: process.uptime() }, error: null });
});

// ─── API Routes ───
app.use('/api/v1', router);

// ─── 404 Handler ───
app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    data: null,
    error: { code: 'NOT_FOUND', message: 'Route not found' },
  });
});

// ─── Global Error Handler ───
app.use(errorMiddleware);

export default app;
