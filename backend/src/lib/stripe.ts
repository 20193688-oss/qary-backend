import Stripe from 'stripe';

export type StripeLike = Pick<
  Stripe,
  'paymentIntents' | 'webhooks' | 'refunds'
>;

let _stripe: Stripe | null = null;

export function getStripe(): StripeLike {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY missing — set it in .env (sandbox key sk_test_...)');
  }
  _stripe = new Stripe(key, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });
  return _stripe;
}

export function setStripeForTesting(s: StripeLike) {
  _stripe = s as Stripe;
}
