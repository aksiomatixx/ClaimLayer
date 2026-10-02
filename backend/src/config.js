'use strict';

require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  // Express `trust proxy` — REQUIRED behind a reverse proxy, otherwise
  // every client shares the proxy's IP and the rate limiter throttles
  // the whole user base together. Unset (the safe local/dev/test
  // default) means "no proxy: use the socket address". Accepts a hop
  // count ("1"), a named preset ("loopback"), or a CIDR list.
  // 'true' is intentionally mapped to 1 hop — blind trust of the whole
  // X-Forwarded-For chain would let clients spoof their rate-limit key.
  trustProxy: process.env.TRUST_PROXY || null,

  jwtSecret: process.env.JWT_SECRET,

  filehandler: {
    // Production: https://api.jwsoftware.com/filehandler/v1
    // Mock (backend/mocks/mock_filehandler.py): http://localhost:8002
    baseUrl: process.env.FILEHANDLER_BASE_URL || 'https://api.jwsoftware.com/filehandler/v1',
    apiKey:  process.env.FILEHANDLER_API_KEY,
  },

  adp: {
    // Production auth: https://accounts.adp.com/auth/oauth/v2/token
    // Mock (backend/mocks/mock_adp.py): http://localhost:8001/auth/oauth/v2/token
    authUrl:      process.env.ADP_AUTH_URL      || 'https://accounts.adp.com/auth/oauth/v2/token',
    baseUrl:      process.env.ADP_BASE_URL      || 'https://api.adp.com',
    clientId:     process.env.ADP_CLIENT_ID,
    clientSecret: process.env.ADP_CLIENT_SECRET,
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    // Pin the exact model ID. claude-sonnet-4-6 is the complete current ID
    // (no date-suffixed variant exists for this generation).
    model: 'claude-sonnet-4-6',
  },

  supabase: {
    url:            process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
    anonKey:        process.env.SUPABASE_ANON_KEY,
  },

  // Direct Postgres connection for transactional writes (ADR-0006).
  // Required in production: consequential writes must commit atomically
  // with their audit-ledger entries and queued jobs. Without it (dev /
  // DB-less demo / the in-memory test suite) the unit of work runs in a
  // non-transactional compatibility mode over supabase-js.
  database: {
    url:              process.env.DATABASE_URL || null,
    // 'disable' | 'require' (TLS, no CA check) | 'verify' (TLS + CA check,
    // DATABASE_SSL_CA or system roots). Default: disable for localhost,
    // require otherwise.
    ssl:              process.env.DATABASE_SSL || null,
    sslCa:            process.env.DATABASE_SSL_CA || null,
    poolMax:          parseInt(process.env.DATABASE_POOL_MAX || '10', 10),
    statementTimeoutMs: parseInt(process.env.DATABASE_STATEMENT_TIMEOUT_MS || '15000', 10),
  },

  jobs: {
    // How long a claimed job is leased before another worker may reclaim it.
    // Handlers that can run longer than this must be safe to run twice.
    leaseSeconds: parseInt(process.env.JOBS_LEASE_SECONDS || '300', 10),
    pollIntervalMs: parseInt(process.env.JOBS_POLL_INTERVAL_MS || '2000', 10),
    // After commit, the API process tries a newly enqueued job at once
    // (low latency). Workers still own retries and recovery.
    kick: process.env.JOBS_KICK !== 'false',
    // Run a poller inside the API process (retries, expired leases). Set
    // 'false' when dedicated workers (npm run worker) are deployed;
    // running both is safe (SKIP LOCKED), just redundant.
    inProcessPoller: process.env.JOBS_IN_PROCESS_POLLER !== 'false',
  },

  tenancy: {
    // The well-known default tenant created by the multi-tenancy foundation
    // migration. Sessions that aren't yet tied to a provisioned tenant (dev
    // logins, single-tenant demo) fall back to this so req.user.tenantId is
    // always present.
    defaultTenantId: process.env.DEFAULT_TENANT_ID || '00000000-0000-0000-0000-000000000001',
  },

  lob: {
    apiKey:  process.env.LOB_API_KEY,
    baseUrl: 'https://api.lob.com/v1',
  },

  sendgrid: {
    apiKey:                    process.env.SENDGRID_API_KEY,
    templateIntakeComplete:    process.env.SENDGRID_TEMPLATE_INTAKE_COMPLETE,
    fromEmail:                 'claims@homecaretpa.com',
  },

  twilio: {
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken:  process.env.TWILIO_AUTH_TOKEN,
    apiKey:     process.env.TWILIO_API_KEY,
    apiSecret:  process.env.TWILIO_API_SECRET,
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },

  adjuster: {
    name:  process.env.ADJUSTER_NAME  || 'Demo Adjuster',
    phone: process.env.ADJUSTER_PHONE || '(800) 555-0100',
    email: process.env.ADJUSTER_EMAIL || 'adjuster@claimlayer.example',
  },

  magicLink: {
    secret:  process.env.MAGIC_LINK_SECRET || process.env.JWT_SECRET,
    ttlHours: 72,
  },

  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173',
  },

  webhooks: {
    dxfSecret:    process.env.DXF_WEBHOOK_SECRET,
    enlyteSecret: process.env.ENLYTE_WEBHOOK_SECRET,
    lobSecret:    process.env.LOB_WEBHOOK_SECRET,
    // Shared secret for the inbound-email channel (SendGrid Inbound
    // Parse / Mailgun Routes deliver multipart posts; neither signs
    // with HMAC, so the contract is a secret token in the request).
    emailInboundToken: process.env.EMAIL_INBOUND_TOKEN,
  },
};

// Validate the minimum set needed to start.
// ANTHROPIC_API_KEY is optional when running with mocks only.
const required = [
  ['JWT_SECRET',           config.jwtSecret],
  ['FILEHANDLER_API_KEY',  config.filehandler.apiKey],
  ['ADP_CLIENT_ID',        config.adp.clientId],
  ['ADP_CLIENT_SECRET',    config.adp.clientSecret],
];

// Production must run the transactional path (ADR-0006).
if (config.nodeEnv === 'production') {
  required.push(['DATABASE_URL', config.database.url]);
}

if (config.nodeEnv !== 'test') {
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`[config] Missing required environment variables: ${missing.join(', ')}`);
    console.error('[config] Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
}

module.exports = config;
