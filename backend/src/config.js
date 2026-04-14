'use strict';

require('dotenv').config();

const config = {
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv: process.env.NODE_ENV || 'development',

  jwtSecret: process.env.JWT_SECRET,

  filehandler: {
    baseUrl: process.env.FILEHANDLER_BASE_URL || 'https://api.jwsoftware.com/filehandler/v1',
    apiKey:  process.env.FILEHANDLER_API_KEY,
  },

  adp: {
    authUrl:      process.env.ADP_AUTH_URL      || 'https://accounts.adp.com/auth/oauth/v2/token',
    baseUrl:      process.env.ADP_BASE_URL      || 'https://api.adp.com',
    clientId:     process.env.ADP_CLIENT_ID,
    clientSecret: process.env.ADP_CLIENT_SECRET,
  },

  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY,
    // Always pin the exact model string — never use a bare alias
    model: 'claude-sonnet-4-20250514',
  },

  supabase: {
    url:            process.env.SUPABASE_URL,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
  },

  lob: {
    apiKey:  process.env.LOB_API_KEY,
    baseUrl: 'https://api.lob.com/v1',
  },

  webhooks: {
    dxfSecret:    process.env.DXF_WEBHOOK_SECRET,
    enlyteSecret: process.env.ENLYTE_WEBHOOK_SECRET,
    lobSecret:    process.env.LOB_WEBHOOK_SECRET,
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

if (config.nodeEnv !== 'test') {
  const missing = required.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`[config] Missing required environment variables: ${missing.join(', ')}`);
    console.error('[config] Copy .env.example to .env and fill in the values.');
    process.exit(1);
  }
}

module.exports = config;
