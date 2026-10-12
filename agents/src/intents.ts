import { z } from 'zod';

export const IntentSchemas = {
  // ─── Wallet & Money ───
  check_balance: z.object({
    currency: z.string().length(3).optional(),
  }),
  send_money: z.object({
    toUserId: z.string().optional(),
    accountNumber: z.string().optional(),
    amount: z.number().positive(),
    currency: z.string().length(3),
    description: z.string().optional(),
  }),
  deposit: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3),
  }),
  withdraw: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3),
    accountNumber: z.string().optional(),
  }),

  // ─── FX ───
  convert_currency: z.object({
    amount: z.number().positive(),
    fromCurrency: z.string().length(3),
    toCurrency: z.string().length(3),
  }),
  get_exchange_rate: z.object({
    baseCurrency: z.string().length(3),
    quoteCurrency: z.string().length(3),
  }),

  // ─── Payments ───
  pay: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3),
    method: z.enum(['CARD', 'WALLET', 'QR_CODE', 'BANK_TRANSFER', 'PIX', 'SPEI', 'SEPA', 'ACH', 'UPI']).optional(),
    description: z.string().optional(),
  }),
  confirm_payment: z.object({
    paymentId: z.string(),
    pin: z.string().length(4),
  }),

  // ─── Invoicing ───
  create_invoice: z.object({
    type: z.enum(['BOLETA', 'FACTURA']),
    amount: z.number().positive(),
    currency: z.string().length(3),
    receiverTaxId: z.string().optional(),
    country: z.string().length(2).default('PE'),
  }),

  // ─── Loans ───
  simulate_loan: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3),
    termMonths: z.number().int().positive(),
  }),
  apply_loan: z.object({
    amount: z.number().positive(),
    currency: z.string().length(3),
    termMonths: z.number().int().positive(),
  }),

  // ─── Points ───
  check_points: z.object({}),
  redeem_points: z.object({
    amount: z.number().int().positive(),
    reason: z.string(),
  }),

  // ─── Support & Info ───
  report_issue: z.object({
    type: z.enum(['PAYMENT', 'SECURITY', 'SERVICE', 'OTHER']),
    description: z.string(),
  }),
  financial_health: z.object({}),
  detect_ant_expenses: z.object({}),

  // ─── Legacy (ride-sharing) ───
  request_ride: z.object({
    pickup: z.string(),
    dropoff: z.string(),
    payment_method: z.enum(['card', 'cash', 'wallet']).optional(),
  }),
  cancel_ride: z.object({
    orderId: z.string(),
    reason: z.string().optional(),
  }),
  call_driver: z.object({ orderId: z.string() }),
  call_user: z.object({ orderId: z.string() }),
  toggle_flash: z.object({ on: z.boolean() }),
} as const;

export type IntentName = keyof typeof IntentSchemas;
