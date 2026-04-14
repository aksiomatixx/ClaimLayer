'use strict';

/**
 * Voice intake routes.
 *
 * GET  /api/v1/voice/token       — Twilio access token for browser recording
 * POST /api/v1/voice/transcribe  — Whisper transcription + Claude extraction (voice path)
 * POST /api/v1/voice/text        — Claude extraction for typed text (text path — no transcription)
 *
 * Both /transcribe and /text feed into the same Claude extraction step and
 * return the same structured fields. Voice and text are equal-weight options.
 */

const express       = require('express');
const multer        = require('multer');
const { body, validationResult } = require('express-validator');
const voiceService  = require('../services/voiceService');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Audio upload — in-memory (max 25MB; Whisper limit is 25MB)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/m4a'];
    cb(null, allowed.includes(file.mimetype) || file.mimetype.startsWith('audio/'));
  },
});

function validate(req, res, next) {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ error: 'Validation failed', details: errors.array() });
  next();
}

// ── GET /api/v1/voice/token ───────────────────────────────────────────────────
router.get(
  '/token',
  requireAuth,
  requireRole(['employee', 'admin']),
  async (req, res) => {
    try {
      const token = await voiceService.getAccessToken(req.user.sub);
      res.json({ token });
    } catch (err) {
      // Return 503 so the frontend can show the text fallback option
      res.status(503).json({
        error:    err.message,
        fallback: 'text_entry',
      });
    }
  }
);

// ── POST /api/v1/voice/transcribe — voice path ────────────────────────────────
// Accepts multipart/form-data with an 'audio' file field + claim_id + language.
router.post(
  '/transcribe',
  requireAuth,
  requireRole(['employee', 'admin']),
  upload.single('audio'),
  async (req, res) => {
    try {
      const { claim_id, language } = req.body;
      if (!req.file) return res.status(400).json({ error: 'audio file is required' });

      const lang = ['en', 'es'].includes(language) ? language : 'en';

      const result = await voiceService.processVoiceIntake({
        claimId:     claim_id,
        audioBuffer: req.file.buffer,
        language:    lang,
        mimeType:    req.file.mimetype,
      });

      res.json(result);
    } catch (err) {
      // Surface transcription failures clearly so the frontend can offer the text path
      res.status(500).json({ error: err.message, fallback: 'text_entry' });
    }
  }
);

// ── POST /api/v1/voice/text — text path (equal alternative) ──────────────────
// Accepts JSON body. No transcription step. Passes typed text to Claude extraction.
router.post(
  '/text',
  requireAuth,
  requireRole(['employee', 'admin']),
  [
    body('claim_id').optional().isString(),
    body('text')
      .notEmpty().withMessage('text is required')
      .isLength({ min: 10 }).withMessage('Please provide more detail about your injury (at least 10 characters)'),
    body('language').optional().isIn(['en', 'es']),
  ],
  validate,
  async (req, res) => {
    try {
      const result = await voiceService.processTextIntake({
        claimId: req.body.claim_id,
        text:    req.body.text,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
