'use strict';

/**
 * Carrier & Policy Modeling routes (admin-only).
 *
 *   GET  /api/v1/insurers                      — list carriers
 *   POST /api/v1/insurers                      — create carrier
 *   GET  /api/v1/employers/:id/policies        — policies for an employer
 *   POST /api/v1/employers/:id/policies        — create policy for an employer
 *   GET  /api/v1/employers/:id/policy-at?doi=  — resolve policy in force at DOI
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const policyService = require('../services/policyService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

router.get('/insurers', requireAuth, requireRole(['admin']), async (_req, res) => {
  try {
    res.json({ insurers: await policyService.listInsurers() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post(
  '/insurers',
  requireAuth, requireRole(['admin']),
  [body('fein').matches(/^[0-9]{9}$/), body('name').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const insurer = await policyService.createInsurer(req.body);
      res.status(201).json({ insurer });
    } catch (err) { res.status(400).json({ error: err.message }); }
  }
);

router.get(
  '/employers/:id/policies',
  requireAuth, requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      res.json({ policies: await policyService.listPoliciesForEmployer(req.params.id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

router.post(
  '/employers/:id/policies',
  requireAuth, requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('policy_number').notEmpty(),
    body('effective_date').matches(/^\d{4}-\d{2}-\d{2}$/),
  ],
  validate,
  async (req, res) => {
    try {
      const policy = await policyService.createPolicy({ ...req.body, employer_id: req.params.id });
      res.status(201).json({ policy });
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 400;
      res.status(status).json({ error: err.message });
    }
  }
);

router.get(
  '/employers/:id/policy-at',
  requireAuth, requireRole(['admin']),
  [param('id').notEmpty(), query('doi').matches(/^\d{4}-\d{2}-\d{2}$/)],
  validate,
  async (req, res) => {
    try {
      const policy = await policyService.resolvePolicy(req.params.id, req.query.doi);
      if (!policy) return res.status(404).json({ error: 'No policy in force at that date' });
      res.json({ policy });
    } catch (err) { res.status(500).json({ error: err.message }); }
  }
);

module.exports = router;
