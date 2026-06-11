'use strict';

/**
 * Itemized Reserve Worksheet routes (admin-only — CL-RSV1).
 *
 *   GET    /api/v1/claims/:id/reserve-worksheet        — grouped worksheet + rollup proposal
 *   POST   /api/v1/claims/:id/reserve-worksheet/items  — add a line item
 *   PATCH  /api/v1/reserve-worksheet/items/:itemId     — edit a line item
 *   DELETE /api/v1/reserve-worksheet/items/:itemId     — remove a line item
 *
 * The worksheet only ever PROPOSES reserve changes — applying one goes
 * through the existing M3 approval route (PATCH /claims/:id/reserves).
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const worksheet = require('../services/reserveWorksheetService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

const _status = (err) =>
  err.message.includes('not found') ? 404
    : /must be|required|one of/.test(err.message) ? 400 : 500;

router.get(
  '/claims/:id/reserve-worksheet',
  requireAuth, requireRole(['admin']),
  [param('id').notEmpty()],
  validate,
  async (req, res) => {
    try {
      res.json(await worksheet.getWorksheet(req.params.id));
    } catch (err) { res.status(_status(err)).json({ error: err.message }); }
  }
);

router.post(
  '/claims/:id/reserve-worksheet/items',
  requireAuth, requireRole(['admin']),
  [
    param('id').notEmpty(),
    body('category').isIn(worksheet.CATEGORIES),
    body('label').notEmpty().isLength({ max: 200 }),
    body('shape').optional().isIn(worksheet.SHAPES),
    body('quantity').optional().isFloat({ gt: 0 }),
    body('unit_amount').optional().isFloat({ min: 0 }),
    body('flat_amount').optional().isFloat({ min: 0 }),
    body('basis_note').optional().isLength({ max: 1000 }),
  ],
  validate,
  async (req, res) => {
    try {
      const item = await worksheet.addLineItem(req.params.id, req.body, req.user?.email);
      res.status(201).json({ item });
    } catch (err) { res.status(_status(err)).json({ error: err.message }); }
  }
);

router.patch(
  '/reserve-worksheet/items/:itemId',
  requireAuth, requireRole(['admin']),
  [param('itemId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      const item = await worksheet.updateLineItem(req.params.itemId, req.body, req.user?.email);
      res.json({ item });
    } catch (err) { res.status(_status(err)).json({ error: err.message }); }
  }
);

router.delete(
  '/reserve-worksheet/items/:itemId',
  requireAuth, requireRole(['admin']),
  [param('itemId').notEmpty()],
  validate,
  async (req, res) => {
    try {
      res.json(await worksheet.removeLineItem(req.params.itemId, req.user?.email));
    } catch (err) { res.status(_status(err)).json({ error: err.message }); }
  }
);

module.exports = router;
