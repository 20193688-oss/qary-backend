/* Auth routes — send-otp & verify-otp
 * In sandbox mode, the code is returned in the response AND logged.
 * In production, the code is only sent via SMS/email and never returned.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const router = express.Router();

const IS_SANDBOX = process.env.NODE_ENV !== 'production';
const OTP_TTL_SECONDS = parseInt(process.env.OTP_TTL_SECONDS || '300', 10);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-change-me-please';

// In-memory OTP store. Replace with Redis in production (see README).
//   Map<request_id, { code_hash, email, phone, purpose, created, used, attempts }>
const otpStore = new Map();

// Rate-limit: how many sends per phone/email in last 15 min
const sendBuckets = new Map(); // Map<key, [timestamps]>

function rateLimitSend(key, max, windowMs) {
  const now = Date.now();
  const arr = (sendBuckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) return false;
  arr.push(now);
  sendBuckets.set(key, arr);
  return true;
}

function hashCode(code) {
  return crypto.createHash('sha256').update(String(code)).digest('hex');
}

function genCode() {
  // 6-digit numeric
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/* ─── POST /api/auth/send-otp ────────────────────────────── */
router.post('/send-otp', async (req, res) => {
  const { email, phone, purpose, channels } = req.body || {};
  if (!email && !phone) {
    return res.status(400).json({ error: 'email_or_phone_required' });
  }
  if (purpose && !['register', 'login', '2fa', 'pay_confirm'].includes(purpose)) {
    return res.status(400).json({ error: 'invalid_purpose' });
  }

  // Rate-limit: 3 / 15 min per identity
  const rlKey = (email || '') + '|' + (phone || '');
  if (!rateLimitSend(rlKey, 3, 15 * 60 * 1000)) {
    return res.status(429).json({ error: 'rate_limited', retry_after_seconds: 900 });
  }

  const code = genCode();
  const request_id = 'otp_' + crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  otpStore.set(request_id, {
    code_hash: hashCode(code),
    email: email || null,
    phone: phone || null,
    purpose: purpose || 'login',
    created: now,
    used: false,
    attempts: 0
  });

  // ── Integration with real providers (only when env vars present) ──
  const channelsSent = [];

  if (phone && process.env.TWILIO_ACCOUNT_SID && !IS_SANDBOX) {
    try {
      // Lazy require so missing dep in sandbox isn't a problem
      const twilio = require('twilio')(
        process.env.TWILIO_ACCOUNT_SID,
        process.env.TWILIO_AUTH_TOKEN
      );
      await twilio.messages.create({
        body: `Tu código QARY es ${code}. No lo compartas.`,
        messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID,
        to: phone
      });
      channelsSent.push('sms');
    } catch (err) {
      console.error('[twilio] send failed', err.message);
    }
  }

  if (email && process.env.SENDGRID_API_KEY && !IS_SANDBOX) {
    try {
      const sgMail = require('@sendgrid/mail');
      sgMail.setApiKey(process.env.SENDGRID_API_KEY);
      await sgMail.send({
        to: email,
        from: process.env.SENDGRID_FROM || 'noreply@qary.pe',
        subject: 'Tu código QARY',
        text: `Tu código es ${code}. Expira en 5 minutos.`,
        html: `<p>Tu código QARY es <strong style="font-size:24px">${code}</strong></p><p>Expira en 5 minutos. Si no fuiste tú, ignora este mensaje.</p>`
      });
      channelsSent.push('email');
    } catch (err) {
      console.error('[sendgrid] send failed', err.message);
    }
  }

  // Always log in sandbox so junior devs can see it
  if (IS_SANDBOX) {
    console.log(`\n  📨 [SANDBOX OTP] request_id=${request_id} code=${code}`);
    console.log(`     to: ${email || ''} ${phone || ''}\n`);
    channelsSent.push('console');
  }

  const response = {
    request_id,
    expires_at: new Date(now + OTP_TTL_SECONDS * 1000).toISOString(),
    ttl_seconds: OTP_TTL_SECONDS,
    channels_sent: channelsSent
  };

  // In sandbox, return the code so frontend can auto-fill (ONLY in sandbox)
  if (IS_SANDBOX) response.sandbox_otp = code;

  res.json(response);
});

/* ─── POST /api/auth/verify-otp ──────────────────────────── */
router.post('/verify-otp', (req, res) => {
  const { request_id, otp, code } = req.body || {};
  const provided = String(otp || code || '').trim();
  if (!request_id || !provided) {
    return res.status(400).json({ error: 'request_id_and_code_required' });
  }

  const entry = otpStore.get(request_id);
  if (!entry) return res.status(400).json({ error: 'not_found' });
  if (entry.used) return res.status(400).json({ error: 'already_used' });
  if (Date.now() - entry.created > OTP_TTL_SECONDS * 1000) {
    otpStore.delete(request_id);
    return res.status(400).json({ error: 'expired' });
  }

  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts > 5) {
    otpStore.delete(request_id);
    return res.status(429).json({ error: 'too_many_attempts' });
  }

  // Constant-time compare
  const expected = Buffer.from(entry.code_hash, 'hex');
  const got = Buffer.from(hashCode(provided), 'hex');
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    return res.status(400).json({ error: 'invalid_code', attempts_left: 5 - entry.attempts });
  }

  entry.used = true;

  // Issue tokens
  const userId = 'usr_' + crypto.randomBytes(8).toString('hex');
  const accessToken = jwt.sign(
    { sub: userId, email: entry.email, phone: entry.phone, scope: 'user' },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
  const refreshToken = jwt.sign(
    { sub: userId, type: 'refresh' },
    JWT_SECRET,
    { expiresIn: '30d' }
  );

  res.json({
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: 3600,
    user: {
      id: userId,
      email: entry.email,
      phone: entry.phone,
      phone_verified: true
    }
  });
});

/* ─── Periodic cleanup ───────────────────────────────────── */
setInterval(() => {
  const cutoff = Date.now() - OTP_TTL_SECONDS * 1000;
  for (const [id, entry] of otpStore) {
    if (entry.created < cutoff) otpStore.delete(id);
  }
}, 60_000).unref();

module.exports = router;
