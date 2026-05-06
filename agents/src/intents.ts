import { z } from 'zod';

// Intents mínimos de la super-app. Cada intent define sus slots requeridos.
// PR 6 cablea esto al clasificador y al ejecutor real.

export const IntentSchemas = {
  request_ride: z.object({
    pickup: z.string(),
    dropoff: z.string(),
    payment_method: z.enum(['card', 'cash', 'wallet']).optional(),
  }),
  cancel_ride: z.object({
    orderId: z.string(),
    reason: z.string().optional(),
  }),
  confirm_payment: z.object({
    orderId: z.string(),
    amount: z.number(),
    confirm_pin: z.string().length(4),
  }),
  send_location: z.object({
    orderId: z.string(),
    recipient: z.string(),
    channel: z.enum(['sms', 'whatsapp', 'email']),
  }),
  report_incident: z.object({
    orderId: z.string().optional(),
    type: z.enum(['SAFETY', 'PAYMENT', 'SERVICE', 'OTHER']),
    description: z.string(),
  }),
  call_driver: z.object({ orderId: z.string() }),
  call_user: z.object({ orderId: z.string() }),
  toggle_flash: z.object({ on: z.boolean() }),
  schedule_pickup: z.object({
    datetime: z.string(),
    location: z.string(),
  }),
} as const;

export type IntentName = keyof typeof IntentSchemas;
