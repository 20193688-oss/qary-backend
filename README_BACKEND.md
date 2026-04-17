/* QARY backend — minimal sandbox server
 * ─────────────────────────────────────
 * Endpoints:
 *   GET  /health
 *   POST /api/auth/send-otp
 *   POST /api/auth/verify-otp
 *   POST /api/payments/create-intent
 *   POST /api/payments/webhook     (raw body for signature verification)
 *   POST /api/profile/avatar       (multipart/form-data)
 *
 * In sandbox mode:
 *   - OTP codes are logged to console AND returned in the response so you
 *     can test without real SMS/email credentials.
 *   - Payment intents return a mock payment_url and a signed QR payload.
 *   - Avatar upload returns a local URL — no S3 needed.
 *
 * Enable real providers by setting env vars:
 *   TWILIO_ACCOUNT_SID, SENDGRID_API_KEY, STRIPE_SECRET_KEY, etc.
 */

'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const fs = require('fs');

const authRoutes = require('./routes/auth');
const paymentsRoutes = require('./routes/payments');
const profileRoutes = require('./routes/profile');
const stripeWebhook = require('./webhooks/stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const IS_SANDBOX = process.env.NODE_ENV !== 'production';

/* ─── CORS ──────────────────────────────────────────────── */
// In production, set CORS_ORIGIN to your frontend URL (e.g. https://qary.vercel.app).
// In sandbox, we allow any origin so local testing works painlessly.
const corsOrigin = process.env.CORS_ORIGIN || '*';
app.use(
  cors({
    origin: corsOrigin === '*' ? true : corsOrigin.split(',').map((s) => s.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key']
  })
);

/* ─── Logging ───────────────────────────────────────────── */
app.use(morgan(IS_SANDBOX ? 'dev' : 'combined'));

/* ─── Body parsers ──────────────────────────────────────── */
// Stripe webhook MUST use the raw body — register it BEFORE json parser.
app.post(
  '/api/payments/webhook',
  express.raw({ type: 'application/json' }),
  stripeWebhook
);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

/* ─── Static: serve uploaded avatars ────────────────────── */
const uploadsDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
app.use('/uploads', express.static(uploadsDir));

/* ─── Routes ────────────────────────────────────────────── */
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'qary-backend',
    version: '1.0.0',
    sandbox: IS_SANDBOX,
    uptime_seconds: Math.floor(process.uptime()),
    time: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    name: 'QARY backend',
    docs: 'See README_BACKEND.md',
    endpoints: [
      'GET  /health',
      'POST /api/auth/send-otp',
      'POST /api/auth/verify-otp',
      'POST /api/payments/create-intent',
      'POST /api/payments/webhook',
      'POST /api/profile/avatar'
    ]
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/profile', profileRoutes);

/* ─── 404 + error handler ───────────────────────────────── */
app.use((req, res) => {
  res.status(404).json({ error: 'not_found', path: req.path });
});

app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  res
    .status(err.status || 500)
    .json({ error: err.code || 'internal_error', message: err.message });
});

/* ─── Start ─────────────────────────────────────────────── */
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n╔════════════════════════════════════════════╗`);
  console.log(`║  QARY backend listening on port ${PORT}      ║`);
  console.log(`║  Mode: ${IS_SANDBOX ? 'SANDBOX (OTPs visible in logs)' : 'PRODUCTION'}`.padEnd(45) + '║');
  console.log(`║  Health: http://localhost:${PORT}/health       ║`);
  console.log(`╚════════════════════════════════════════════╝\n`);
});
