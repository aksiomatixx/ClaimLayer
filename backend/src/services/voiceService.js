'use strict';

/**
 * voiceService.js — Voice intake: Twilio token + Whisper transcription + Claude extraction.
 *
 * All three integrations degrade gracefully when API keys are absent:
 *   - No TWILIO_*  → getAccessToken() throws a descriptive error (caller shows fallback UI)
 *   - No OPENAI_API_KEY → transcribeAudio() throws (caller falls back to manual text entry)
 *   - No ANTHROPIC_API_KEY → extractClaimFields() throws (caller shows unextracted transcript)
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('../logger');
const db     = require('./db');

// ── Twilio access token ───────────────────────────────────────────────────────

/**
 * Issues a short-lived Twilio Client SDK access token for browser recording.
 * Token TTL: 3600 seconds (1 hour).
 */
async function getAccessToken(userId) {
  const { TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_API_KEY || !TWILIO_API_SECRET) {
    throw new Error('Twilio credentials not configured — TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET required');
  }

  const twilio      = require('twilio');
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  const token = new AccessToken(TWILIO_ACCOUNT_SID, TWILIO_API_KEY, TWILIO_API_SECRET, { ttl: 3600 });
  token.identity = userId;
  token.addGrant(new VoiceGrant({ incomingAllow: false }));

  logger.info({ msg: 'voiceService: Twilio access token issued', userId });
  return token.toJwt();
}

// ── Whisper transcription ─────────────────────────────────────────────────────

/**
 * Transcribes an audio buffer using OpenAI Whisper.
 *
 * @param {Buffer} audioBuffer   Raw audio bytes (webm/mp4/wav/m4a)
 * @param {string} language      Language hint: 'en' or 'es'
 * @param {string} mimeType      MIME type of the audio (e.g. 'audio/webm')
 * @returns {object} { text, words, duration_seconds }
 */
async function transcribeAudio(audioBuffer, language = 'en', mimeType = 'audio/webm') {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not configured — voice transcription unavailable');
  }

  const { default: OpenAI } = await import('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Whisper requires a file-like object with a name
  const ext = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('wav') ? 'wav' : 'webm';
  const file = new File([audioBuffer], `recording.${ext}`, { type: mimeType });

  const start = Date.now();

  const response = await openai.audio.transcriptions.create({
    file,
    model:           'whisper-1',
    language:        language,
    response_format: 'verbose_json',
    temperature:     0,
  });

  logger.info({
    msg:         'voiceService: Whisper transcription complete',
    language,
    durationSec: response.duration,
    textLength:  response.text?.length,
    latencyMs:   Date.now() - start,
  });

  return {
    text:             response.text,
    words:            response.words || [],
    duration_seconds: response.duration,
    language:         response.language,
  };
}

// ── Claude field extraction ───────────────────────────────────────────────────

/**
 * Passes transcript to Claude and extracts structured claim fields.
 *
 * @param {string} transcript   Raw transcript text
 * @param {object} claim        Claim context (dateOfInjury, bodyPart, etc.)
 * @returns {object}  Structured extraction: body_part, mechanism, time_of_injury,
 *                    witnesses, prior_claims, medical_treatment, confidence, extraction_notes
 */
async function extractClaimFields(transcript, claim = {}) {
  const aiService = require('./aiService');

  const promptPath = path.join(__dirname, '../../prompts/voice_extraction.txt');
  const systemPrompt = fs.readFileSync(promptPath, 'utf8').trim();

  const inputSnapshot = {
    transcript,
    claim_context: {
      date_of_injury: claim.dateOfInjury,
      employer_name:  claim.employerName,
      known_body_part: claim.bodyPart || null,
    },
  };

  let result, raw = null, meta = { input_tokens: null, output_tokens: null, latency_ms: null };
  if (typeof aiService._callClaudeMeta === 'function') {
    const out = await aiService._callClaudeMeta(systemPrompt, JSON.stringify(inputSnapshot), 800);
    result = out.parsed; raw = out.raw; meta = out.meta;
  } else {
    result = await aiService._callClaude(systemPrompt, JSON.stringify(inputSnapshot), 800);
  }

  // Validate required output
  if (typeof result.confidence !== 'number') result.confidence = 50;
  if (!result.extraction_notes) result.extraction_notes = '';

  try {
    const aid = require('./aiDecisionsService');
    await aid.logDecision({
      claim_id:      claim.id || null,
      decision_type: 'voice_extract',
      prompt_name:   'voice_extraction',
      model:         require('../config').anthropic.model,
      input_snapshot: inputSnapshot,
      output_parsed: result,
      output_raw:    raw,
      ...meta,
      confidence:        typeof result.confidence === 'number' ? result.confidence : null,
      guardrail_actions: [],
    });
  } catch (e) { logger.warn({ msg: 'voice: audit log failed', err: e.message }); }

  logger.info({
    msg:        'voiceService: Claude extraction complete',
    confidence: result.confidence,
    bodyPart:   result.body_part,
  });

  return result;
}

// ── Full transcription + extraction pipeline ──────────────────────────────────

/**
 * Full pipeline: audio buffer → transcription → Claude extraction → document record.
 *
 * @param {object} opts
 * @param {string}  opts.claimId
 * @param {Buffer}  opts.audioBuffer
 * @param {string}  opts.language     'en' | 'es'
 * @param {string}  opts.mimeType
 * @returns {object} { transcript, extraction, documentId }
 */
async function processVoiceIntake({ claimId, audioBuffer, language, mimeType }) {
  // 1. Transcribe
  let transcription;
  try {
    transcription = await transcribeAudio(audioBuffer, language, mimeType);
  } catch (err) {
    logger.error({ msg: 'voiceService: transcription failed', claimId, err: err.message });
    throw err;
  }

  // 2. Create document record for the audio file
  const audioDoc = await db.documents.create({
    claim_id:   claimId,
    doc_type:   'voice_recording',
    source:     'employee_upload',
    mime_type:  mimeType,
    size_bytes: audioBuffer.length,
    filehandler_pushed: false,
  });

  // 3. Create document record for the transcript
  const transcriptDoc = await db.documents.create({
    claim_id:   claimId,
    doc_type:   'voice_transcript',
    source:     'system_generated',
    content:    transcription.text,
    mime_type:  'text/plain',
    filehandler_pushed: false,
  });

  // 4. Claude extraction (best-effort — don't fail if Claude unavailable)
  let extraction = null;
  try {
    const claimService = require('./claimService');
    const claim = await claimService.getClaim(claimId);
    extraction = await extractClaimFields(transcription.text, claim || {});
  } catch (err) {
    logger.warn({ msg: 'voiceService: Claude extraction failed (non-fatal)', claimId, err: err.message });
  }

  return {
    transcript:   transcription.text,
    extraction,
    audioDocId:   audioDoc.id,
    transcriptDocId: transcriptDoc.id,
  };
}

// ── Text intake pipeline (equal alternative to voice) ─────────────────────────

/**
 * Text path: employee typed their statement directly.
 * Skips transcription — passes typed text straight to Claude extraction.
 * No consent disclosure required.
 *
 * @param {object} opts
 * @param {string}  opts.claimId
 * @param {string}  opts.text        Employee's typed statement
 * @returns {object} { transcript, extraction, transcriptDocId }
 */
async function processTextIntake({ claimId, text }) {
  if (!text || text.trim().length < 10) {
    throw new Error('Description is too short — please provide more detail about your injury');
  }

  // Create document record for the text statement
  const transcriptDoc = await db.documents.create({
    claim_id:   claimId,
    doc_type:   'text_statement',
    source:     'employee_typed',
    content:    text.trim(),
    mime_type:  'text/plain',
    filehandler_pushed: false,
  });

  // Claude extraction (same step as voice path)
  let extraction = null;
  try {
    const claimService = require('./claimService');
    const claim = await claimService.getClaim(claimId);
    extraction = await extractClaimFields(text.trim(), claim || {});
  } catch (err) {
    logger.warn({ msg: 'voiceService: Claude extraction failed on text path (non-fatal)', claimId, err: err.message });
  }

  logger.info({ msg: 'voiceService: text intake processed', claimId, textLength: text.length });

  return {
    transcript:      text.trim(),
    extraction,
    transcriptDocId: transcriptDoc.id,
  };
}

module.exports = {
  getAccessToken,
  transcribeAudio,
  extractClaimFields,
  processVoiceIntake,
  processTextIntake,
};
