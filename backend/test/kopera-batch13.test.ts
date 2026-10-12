import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryPrisma, createInMemoryRedis, createMockStripe } from './_mocks.js';

async function bootstrap() {
  const prisma = createInMemoryPrisma();
  const redis = createInMemoryRedis();
  const stripe = createMockStripe();
  const app = await buildApp({ prisma, redis, stripe: stripe as never });
  await app.ready();

  const reg = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'b13@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b13@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('loan repayment processing engine', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function setupLoanWithRepayment(opts: { walletBalance?: number; dueInPast?: boolean } = {}) {
    const prisma = ctx.prisma as any;

    await ctx.app.inject({
      method: 'POST', url: '/api/wallets',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD' },
    });
    if (opts.walletBalance) {
      await ctx.app.inject({
        method: 'POST', url: '/api/wallets/deposit',
        headers: { authorization: `Bearer ${ctx.accessToken}` },
        payload: { amount: opts.walletBalance, currency: 'USD' },
      });
    }

    const loan = await prisma.loan.create({
      data: {
        userId: ctx.user.id,
        currency: 'USD',
        amount: BigInt(100000),
        outstandingBalance: BigInt(100000),
        status: 'DISBURSED',
        termMonths: 12,
        interestRate: 0.12,
        missedPayments: 0,
      },
    });

    const dueDate = opts.dueInPast !== false
      ? new Date(Date.now() - 86400000)
      : new Date(Date.now() + 86400000 * 30);

    const repayment = await prisma.loanRepayment.create({
      data: {
        loanId: loan.id,
        installment: 1,
        dueDate,
        amount: BigInt(10000),
        principal: BigInt(8000),
        interest: BigInt(2000),
        paidAmount: BigInt(0),
        status: 'PENDING',
      },
    });

    return { loan, repayment };
  }

  it('processes due repayments with sufficient funds', async () => {
    await setupLoanWithRepayment({ walletBalance: 500 });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loan-repayments/process-due',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.processed).toBe(1);
    expect(body.results[0].success).toBe(true);
  });

  it('marks overdue with insufficient funds', async () => {
    const { repayment, loan } = await setupLoanWithRepayment({ walletBalance: 0 });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loan-repayments/process-due',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().results[0].success).toBe(false);
    expect(res.json().results[0].reason).toBe('insufficient_funds');

    const prisma = ctx.prisma as any;
    const updated = await prisma.loanRepayment.findUnique({ where: { id: repayment.id } });
    expect(updated.status).toBe('OVERDUE');

    const updatedLoan = await prisma.loan.findUnique({ where: { id: loan.id } });
    expect(updatedLoan.missedPayments).toBe(1);
  });

  it('skips future repayments', async () => {
    await setupLoanWithRepayment({ walletBalance: 500, dueInPast: false });

    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loan-repayments/process-due',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(0);
  });

  it('returns empty when nothing due', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/loan-repayments/process-due',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().processed).toBe(0);
  });
});

describe('bank account verification flow', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function addBankAccount() {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/bank-accounts',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        bankName: 'Test Bank',
        accountNumber: '1234567890',
        rail: 'ACH',
        country: 'US',
        currency: 'USD',
        holderName: 'Test User',
      },
    });
    return res.json();
  }

  it('initiates micro-deposit verification', async () => {
    const acct = await addBankAccount();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/initiate-verification`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().message).toBe('micro_deposits_sent');
    expect(res.json().microDeposit1).toBeGreaterThan(0);
    expect(res.json().microDeposit2).toBeGreaterThan(0);
  });

  it('confirms verification with correct amounts', async () => {
    const acct = await addBankAccount();

    const initRes = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/initiate-verification`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    const { microDeposit1, microDeposit2 } = initRes.json();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/confirm-verification`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount1: microDeposit1, amount2: microDeposit2 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isVerified).toBe(true);
  });

  it('rejects wrong micro-deposit amounts', async () => {
    const acct = await addBankAccount();

    await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/initiate-verification`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/confirm-verification`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount1: 999, amount2: 999 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('amounts_mismatch');
  });

  it('rejects confirm without initiation', async () => {
    const acct = await addBankAccount();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/confirm-verification`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { amount1: 10, amount2: 20 },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('verification_not_initiated');
  });

  it('rejects initiation on already-verified account', async () => {
    const acct = await addBankAccount();

    await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/verify`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/bank-accounts/${acct.id}/initiate-verification`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_verified');
  });
});

describe('tokenized card management', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  async function addCard(overrides: Record<string, unknown> = {}) {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/cards',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        vaultToken: 'tok_test_123',
        last4: '4242',
        network: 'VISA',
        expiryMonth: 12,
        expiryYear: 2027,
        holderName: 'Test User',
        ...overrides,
      },
    });
    return res.json();
  }

  it('updates card expiry', async () => {
    const card = await addCard();

    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/cards/${card.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { expiryMonth: 6, expiryYear: 2028 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().expiryMonth).toBe(6);
    expect(res.json().expiryYear).toBe(2028);
  });

  it('updates card holder name', async () => {
    const card = await addCard();

    const res = await ctx.app.inject({
      method: 'PUT', url: `/api/cards/${card.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { holderName: 'New Name' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().holderName).toBe('New Name');
  });

  it('freezes a card', async () => {
    const card = await addCard();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cards/${card.id}/freeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().frozen).toBe(true);
  });

  it('prevents double freeze', async () => {
    const card = await addCard();

    await ctx.app.inject({
      method: 'POST', url: `/api/cards/${card.id}/freeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cards/${card.id}/freeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('already_frozen');
  });

  it('unfreezes a frozen card', async () => {
    const card = await addCard();

    await ctx.app.inject({
      method: 'POST', url: `/api/cards/${card.id}/freeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cards/${card.id}/unfreeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().frozen).toBe(false);
  });

  it('rejects unfreeze on non-frozen card', async () => {
    const card = await addCard();

    const res = await ctx.app.inject({
      method: 'POST', url: `/api/cards/${card.id}/unfreeze`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('not_frozen');
  });

  it('detects expiring cards', async () => {
    const now = new Date();
    await addCard({ expiryMonth: now.getMonth() + 1, expiryYear: now.getFullYear(), fingerprint: 'fp1' });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/expiring?months=2',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty when no cards expiring', async () => {
    await addCard({ expiryMonth: 12, expiryYear: 2030, fingerprint: 'fp2' });

    const res = await ctx.app.inject({
      method: 'GET', url: '/api/cards/expiring?months=2',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(0);
  });

  it('update returns 404 for missing card', async () => {
    const res = await ctx.app.inject({
      method: 'PUT', url: '/api/cards/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { holderName: 'No One' },
    });
    expect(res.statusCode).toBe(404);
  });
});
