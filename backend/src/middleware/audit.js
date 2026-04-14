'use strict';

/**
 * Audit-log middleware.
 *
 * Logs every API request with: method, path, status, userId, role, latency, ip.
 * This feeds the audit_log table in M2 (Supabase).
 *
 * All admin actions are retained for 7 years per California WC audit
 * requirements (docs/regulatory.md).
 */

const logger = require('../logger');

function auditLog(req, res, next) {
  const start = Date.now();

  res.on('finish', () => {
    // Skip health-check noise in logs
    if (req.path === '/health') return;

    logger.info({
      type:      'api_request',
      method:    req.method,
      path:      req.path,
      status:    res.statusCode,
      userId:    req.user?.sub || req.user?.id || null,
      userEmail: req.user?.email || null,
      userRole:  req.user?.role || null,
      latencyMs: Date.now() - start,
      ip:        req.ip,
    });
  });

  next();
}

module.exports = { auditLog };
