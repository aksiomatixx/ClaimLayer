'use strict';

require('dotenv').config();

const express      = require('express');
const cookieParser = require('cookie-parser');
const config       = require('./config');
const logger       = require('./logger');
const { auditLog } = require('./middleware/audit');

const claimsRouter       = require('./routes/claims');
const webhooksRouter     = require('./routes/webhooks');
const providersRouter    = require('./routes/providers');
const appointmentsRouter = require('./routes/appointments');
const voiceRouter        = require('./routes/voice');
const documentsRouter    = require('./routes/documents');
const authRouter         = require('./routes/auth');
const employerRouter     = require('./routes/employer');
const rfasRouter         = require('./routes/rfas');
const reportingRouter    = require('./routes/reporting');
const qmeRouter          = require('./routes/qme');

const app = express();

// ── Global middleware ────────────────────────────────────────────────────────
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(auditLog);

// ── Health check (unauthenticated) ───────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString(), env: config.nodeEnv })
);

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api/v1/claims',        claimsRouter);
app.use('/api/v1/providers',     providersRouter);
app.use('/api/v1/appointments',  appointmentsRouter);
app.use('/api/v1/voice',         voiceRouter);
app.use('/api/v1/documents',     documentsRouter);
app.use('/api/v1/auth',          authRouter);
app.use('/api/v1/employer',      employerRouter);
app.use('/api/v1/rfas',         rfasRouter);
app.use('/api/v1/qme',          qmeRouter);
app.use('/api/v1',               reportingRouter);
app.use('/webhooks',             webhooksRouter);

// ── Optional employer portal router (present in M4+) ─────────────────────────
try {
  const employerRouter = require('./routes/employer');
  app.use('/api/v1/employer', employerRouter);
} catch {
  // employer router not present — OK in older deployments
}

// ── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ error: `Route not found: ${req.method} ${req.path}` })
);

// ── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  logger.error({ msg: 'Unhandled error', err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const { verifyConnection } = require('./services/supabase');
  verifyConnection()
    .then(() => {
      app.listen(config.port, () => {
        logger.info({ msg: 'HomeCare TPA backend listening', port: config.port, env: config.nodeEnv });
      });
    })
    .catch(err => {
      logger.error({ msg: 'Supabase connection check failed — refusing to start', err: err.message });
      process.exit(1);
    });
}

module.exports = app; // exported for supertest
