import type Redis from 'ioredis';
import { randomDigits } from './crypto.js';

const TTL = Number(process.env.OTP_TTL_SECONDS ?? 300);
const MAX_ATTEMPTS = 5;

export interface OtpStore {
  setOtp(email: string, code: string): Promise<void>;
  verifyOtp(email: string, code: string): Promise<{ ok: boolean; reason?: string }>;
}

export function createOtpStore(redis: Redis): OtpStore {
  const codeKey = (email: string) => `otp:code:${email.toLowerCase()}`;
  const attemptsKey = (email: string) => `otp:attempts:${email.toLowerCase()}`;

  return {
    async setOtp(email, code) {
      await redis.set(codeKey(email), code, 'EX', TTL);
      await redis.del(attemptsKey(email));
    },
    async verifyOtp(email, code) {
      const stored = await redis.get(codeKey(email));
      if (!stored) return { ok: false, reason: 'expired_or_missing' };
      const attempts = await redis.incr(attemptsKey(email));
      if (attempts === 1) await redis.expire(attemptsKey(email), TTL);
      if (attempts > MAX_ATTEMPTS) {
        await redis.del(codeKey(email));
        return { ok: false, reason: 'too_many_attempts' };
      }
      if (stored !== code) return { ok: false, reason: 'mismatch' };
      await redis.del(codeKey(email));
      await redis.del(attemptsKey(email));
      return { ok: true };
    },
  };
}

export function generateOtp(): string {
  return randomDigits(4);
}
