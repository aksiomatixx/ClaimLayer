'use strict';

require('dotenv').config();

const crypto       = require('crypto');
const express      = require('express');
const cookieParser = require('cookie-parser');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
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
const wcisRouter         = require('./routes/wcis');
const qmeRouter          = require('./routes/qme');
const mmiRouter          = require('./routes/mmi');
const pdRouter           = require('./routes/pd');
const settlementRouter   = require('./routes/settlement');
const { offersRouter }   = require('./routes/settlement');
const {
  claimsRouter:        disbursementClaimsRouter,
  disbursementsRouter,
  pdAdvancesRouter,
  stipulationsRouter,
} = require('./routes/disbursement');

const app = express();

// ── Global middleware ────────────────────────────────────────────────────────

// Request ID — honored from a trusted proxy header if present, otherwise
// generated. Threaded through audit logs and error responses so any log
// line can be correlated to one request.
app.use((req, res, next) => {
  req.id = req.get('x-request-id') || crypto.randomUUID();
  res.set('x-request-id', req.id);
  next();
});

app.use(helmet());
app.use(cookieParser());
app.use(express.json({ limit: '10mb' }));
app.use(auditLog);

// ── Rate limiting (disabled under test — supertest shares one IP) ────────────
if (config.nodeEnv !== 'test') {
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 1000,
    standardHeaders: true,
    legacyHeaders: false,
  }));
  // Tighter bound on credential endpoints (login, magic links)
  app.use('/api/v1/auth', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 50,
    standardHeaders: true,
    legacyHeaders: false,
  }));
}

// ── Health check (unauthenticated) ───────────────────────────────────────────
app.get('/health', (_req, res) =>
  res.json({ status: 'ok', ts: new Date().toISOString(), env: config.nodeEnv })
);

// ── API routes ───────────────────────────────────────────────────────────────
app.use('/api/v1/claims',        claimsRouter);
app.use('/api/v1/providers',     providersRouter);
app.use('/api/v1/appointments',  appointmentsRouter);
app.use('/api/v1/voice',         voiceRouter);
app.use('/api/v1',               require('./routes/ingestion')); // before documentsRouter: /documents/triage must not match its /:id
app.use('/api/v1/documents',     documentsRouter);
app.use('/api/v1/auth',          authRouter);
app.use('/api/v1/employer',      employerRouter);
app.use('/api/v1/rfas',         rfasRouter);
app.use('/api/v1/qme',          qmeRouter);
app.use('/api/v1/mmi',          mmiRouter);
app.use('/api/v1/pd',           pdRouter);
app.use('/api/v1/claims',        settlementRouter);
app.use('/api/v1/offers',        offersRouter);
app.use('/api/v1/claims',        disbursementClaimsRouter);
app.use('/api/v1/disbursements', disbursementsRouter);
app.use('/api/v1/pd-advances',   pdAdvancesRouter);
app.use('/api/v1/stipulations',  stipulationsRouter);
app.use('/api/v1',               require('./routes/td-periods'));
app.use('/api/v1',               reportingRouter);
app.use('/api/v1/wcis',          wcisRouter);
app.use('/api/v1/admin',         require('./routes/admin'));
app.use('/api/v1',               require('./routes/ai-decisions'));
app.use('/api/v1',               require('./routes/integrations'));
app.use('/api/v1',               require('./routes/policies'));
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
  logger.error({ msg: 'Unhandled error', requestId: req.id, err: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
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
