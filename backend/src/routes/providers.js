'use strict';

const express         = require('express');
const { query, param, validationResult } = require('express-validator');
const providerService = require('../services/providerService');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── GET /api/v1/providers — search MPN providers ──────────────────────────────
router.get(
  '/',
  requireAuth,
  [
    query('zip')
      .notEmpty().withMessage('zip is required')
      .matches(/^\d{5}$/).withMessage('zip must be a 5-digit US zip code'),
    query('specialty')
      .optional()
      .isIn(['Occupational Medicine', 'Orthopedic Surgery', 'Urgent Care', 'Physical Therapy', 'all'])
      .withMessage('Invalid specialty value'),
    query('walk_in')
      .optional()
      .isIn(['true', 'false'])
      .withMessage('walk_in must be true or false'),
    query('limit')
      .optional()
      .isInt({ min: 1, max: 20 })
      .withMessage('limit must be between 1 and 20'),
  ],
  validate,
  async (req, res) => {
    try {
      const { zip, specialty, walk_in, limit } = req.query;
      const providers = await providerService.search({
        zip,
        specialty,
        walk_in: walk_in === 'true' ? true : walk_in === 'false' ? false : undefined,
        limit:   limit ? parseInt(limit, 10) : 8,
      });
      res.json({ providers, count: providers.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

// ── GET /api/v1/providers/:id — single provider ───────────────────────────────
router.get(
  '/:id',
  requireAuth,
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const provider = await providerService.getById(req.params.id);
      res.json(provider);
    } catch (err) {
      const status = err.message.includes('not found') ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  }
);

module.exports = router;
