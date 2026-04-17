/* Payments routes — sandbox create-intent + QR
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { signQR } = require('../lib/qr-signer');

const router = express.Router();

const IS_SANDBOX = process.env.NODE_ENV !== 'production';

// Ensure QR_SIGNING_SECRET exists (in sandbox, generate on the fly)
if (!process.env.QR_SIGNING_SECRET) {
  process.env.QR_SIGNING_SECRET = crypto.randomBytes(32).toString('hex');
  if (IS_SANDBOX) {
    console.log('[QARY] Generated dev QR_SIGNING_SECRET (set env var for persistence)');
  }
}

// In-memory transaction ledger (replace with DB in production)
const txLedger = new Map();

/* ─── POST /api/payments/create-intent ──────────────────── */
router.post('/create-intent', async (req, res) => {
  const { amount, currency, description, metadata } = req.body || {};

  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ error: 'amount_required_positive_number' });
  }
  const cur = (currency || 'PEN').toUpperCase();

  // If Stripe is configured, create a real PaymentIntent (even in sandbox — Stripe has test mode)
  if (process.env.STRIPE_SECRET_KEY) {
    try {
      const Stripe = require('stripe');
      const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
      const txId = 'tx_' + crypto.randomBytes(10).toString('hex');
      const intent = await stripe.paymentIntents.create(
        {
          amount: Math.round(amount), // amount in MINOR units (cents)
          currency: cur.toLowerCase(),
          description: description || 'QARY payment',
          metadata: { ...(metadata || {}), tx_id: txId },
          automatic_payment_methods: { enabled: true }
        },
        { idempotencyKey: req.headers['idempotency-key'] || txId }
      );
      const { qr_payload, expires_at } = signQR({
        amount,
        currency: cur,
        merchant: 'qary.pe',
        metadata: { tx_id: txId }
      });
      txLedger.set(txId, { status: 'pending', amount, currency: cur, created: Date.now() });
      return res.json({
        tx_id: txId,
        gateway: 'stripe',
        client_secret: intent.client_secret,
        publishable_key: process.env.STRIPE_PUBLISHABLE_KEY || null,
        qr_payload,
        qr_expires_at: expires_at,
        payment_url: null
      });
    } catch (err) {
      console.error('[stripe] create intent failed', err.message);
      return res.status(502).json({ error: 'gateway_error', message: err.message });
    }
  }

  // Sandbox-only path: no Stripe → return a mock payment URL and real signed QR
  const { qr_payload, tx_id, expires_at } = signQR({
    amount,
    currency: cur,
    merchant: 'qary.pe',
    metadata: metadata || {}
  });
  txLedger.set(tx_id, { status: 'pending', amount, currency: cur, created: Date.now() });

  const paymentUrl =
    (req.protocol + '://' + req.get('host')) +
    '/api/payments/mock-checkout?tx=' + tx_id;

  res.json({
    tx_id,
    gateway: 'sandbox',
    client_secret: null,
    publishable_key: null,
    qr_payload,
    qr_expires_at: expires_at,
    payment_url: paymentUrl,
    sandbox_note:
      'No STRIPE_SECRET_KEY set — returning a mock payment URL. GET the payment_url to simulate completion.'
  });
});

/* ─── GET /api/payments/mock-checkout — sandbox only ────── */
router.get('/mock-checkout', (req, res) => {
  const tx = req.query.tx;
  const entry = txLedger.get(tx);
  if (!entry) return res.status(404).send('Unknown tx');
  entry.status = 'paid';
  entry.paid_at = Date.now();
  res.send(
    `<!doctype html><html><body style="font-family:system-ui;padding:40px;text-align:center">
     <h1>✅ Pago simulado exitoso</h1>
     <p>tx: <code>${tx}</code></p>
     <p>S/. ${(entry.amount / 100).toFixed(2)} ${entry.currency}</p>
     <p>Puedes cerrar esta ventana.</p>
     </body></html>`
  );
});

/* ─── GET /api/payments/tx/:id — status check ────────────── */
router.get('/tx/:id', (req, res) => {
  const entry = txLedger.get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'not_found' });
  res.json({ tx_id: req.params.id, ...entry });
});

module.exports = router;
