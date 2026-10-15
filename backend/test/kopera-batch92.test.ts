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
    payload: { email: 'b92@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b92@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('fee schedules', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates a fee schedule', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fee-schedules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionType: 'TRANSFER', feeType: 'FIXED', fixedAmount: '500', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().transactionType).toBe('TRANSFER');
    expect(res.json().fixedAmount).toBe('500');
  });

  it('rejects duplicate fee', async () => {
    await ctx.prisma.feeSchedule.create({
      data: { userId: ctx.user.id, transactionType: 'TRANSFER', feeType: 'FIXED', fixedAmount: BigInt(500), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fee-schedules/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionType: 'TRANSFER', feeType: 'FIXED', fixedAmount: '500', currency: 'USD' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('fee_already_exists');
  });

  it('lists fee schedules', async () => {
    await ctx.prisma.feeSchedule.create({
      data: { userId: ctx.user.id, transactionType: 'PAYMENT', feeType: 'PERCENTAGE', percentageRate: 0.025, currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fee-schedules/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('calculates a fixed fee', async () => {
    await ctx.prisma.feeSchedule.create({
      data: { userId: ctx.user.id, transactionType: 'TRANSFER', feeType: 'FIXED', fixedAmount: BigInt(100), currency: 'USD', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/fee-schedules/calculate',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { transactionType: 'TRANSFER', amount: '50000', currency: 'USD' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().feeApplied).toBe(true);
    expect(res.json().feeAmount).toBe('100');
  });

  it('updates a fee', async () => {
    const fee = await ctx.prisma.feeSchedule.create({
      data: { userId: ctx.user.id, transactionType: 'TRANSFER', feeType: 'FIXED', fixedAmount: BigInt(100), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/fee-schedules/${fee.id}/update`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { fixedAmount: '200' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().fixedAmount).toBe('200');
  });

  it('removes a fee', async () => {
    const fee = await ctx.prisma.feeSchedule.create({
      data: { userId: ctx.user.id, transactionType: 'TRANSFER', feeType: 'FIXED', fixedAmount: BigInt(100), currency: 'USD' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/fee-schedules/${fee.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data fee analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/fee-schedules/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalFees).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single fee by id', async () => {
    const fee = await ctx.prisma.feeSchedule.create({
      data: { userId: ctx.user.id, transactionType: 'WITHDRAWAL', feeType: 'PERCENTAGE', percentageRate: 0.01, currency: 'EUR' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/fee-schedules/${fee.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transactionType).toBe('WITHDRAWAL');
  });
});

describe('approval workflows', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('creates an approval request', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/approval-workflows/create',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { requestType: 'PAYMENT', resourceType: 'invoice', resourceId: 'inv-1', description: 'Pay vendor', amount: '100000', currency: 'USD' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().requestType).toBe('PAYMENT');
    expect(res.json().status).toBe('PENDING');
  });

  it('lists approval requests', async () => {
    await ctx.prisma.approvalRequest.create({
      data: { userId: ctx.user.id, requestType: 'PAYMENT', resourceType: 'invoice', resourceId: 'inv-1', description: 'test', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/approval-workflows/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('approves a request', async () => {
    const req = await ctx.prisma.approvalRequest.create({
      data: { userId: ctx.user.id, requestType: 'PAYMENT', resourceType: 'invoice', resourceId: 'inv-1', description: 'test', status: 'PENDING', requiredApprovals: 1, currentApprovals: 0 },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/approval-workflows/${req.id}/approve`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { notes: 'Looks good' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('APPROVED');
  });

  it('rejects a request', async () => {
    const req = await ctx.prisma.approvalRequest.create({
      data: { userId: ctx.user.id, requestType: 'PAYMENT', resourceType: 'invoice', resourceId: 'inv-1', description: 'test', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/approval-workflows/${req.id}/reject`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { reason: 'Too expensive' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('REJECTED');
  });

  it('cancels a request', async () => {
    const req = await ctx.prisma.approvalRequest.create({
      data: { userId: ctx.user.id, requestType: 'PAYMENT', resourceType: 'invoice', resourceId: 'inv-1', description: 'test', status: 'PENDING' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/approval-workflows/${req.id}/cancel`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CANCELLED');
  });

  it('returns no_data approval analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/approval-workflows/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalRequests).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single approval request by id', async () => {
    const req = await ctx.prisma.approvalRequest.create({
      data: { userId: ctx.user.id, requestType: 'TRANSFER', resourceType: 'wallet', resourceId: 'w-1', description: 'Transfer funds' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/approval-workflows/${req.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().requestType).toBe('TRANSFER');
  });
});

describe('document vault', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('stores a document', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/document-vault/store',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { documentType: 'ID_CARD', fileName: 'passport.pdf', fileSize: 204800, mimeType: 'application/pdf', storageUrl: 'https://storage.example.com/passport.pdf' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().documentType).toBe('ID_CARD');
    expect(res.json().status).toBe('ACTIVE');
  });

  it('lists documents', async () => {
    await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'ID_CARD', fileName: 'id.pdf', fileSize: 1024, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/id.pdf' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/document-vault/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets documents by category', async () => {
    await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'ID', fileName: 'a.pdf', fileSize: 100, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/a.pdf', category: 'KYC' },
    });
    await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'RECEIPT', fileName: 'b.pdf', fileSize: 200, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/b.pdf', category: 'FINANCE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/document-vault/category/KYC',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('archives a document', async () => {
    const doc = await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'ID', fileName: 'a.pdf', fileSize: 100, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/a.pdf', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/document-vault/${doc.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ARCHIVED');
  });

  it('rejects archiving already archived doc', async () => {
    const doc = await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'ID', fileName: 'a.pdf', fileSize: 100, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/a.pdf', status: 'ARCHIVED' },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/document-vault/${doc.id}/archive`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('document_already_archived');
  });

  it('verifies document integrity', async () => {
    const doc = await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'ID', fileName: 'a.pdf', fileSize: 100, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/a.pdf', contentHash: 'abc123', status: 'ACTIVE' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/document-vault/${doc.id}/integrity`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().integrityValid).toBe(true);
    expect(res.json().contentHash).toBe('abc123');
  });

  it('deletes a document', async () => {
    const doc = await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'ID', fileName: 'a.pdf', fileSize: 100, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/a.pdf' },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/document-vault/${doc.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data vault analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/document-vault/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalDocuments).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single document by id', async () => {
    const doc = await ctx.prisma.documentVault.create({
      data: { userId: ctx.user.id, documentType: 'CONTRACT', fileName: 'contract.pdf', fileSize: 5000, mimeType: 'application/pdf', storageUrl: 'https://s3.example.com/contract.pdf' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/document-vault/${doc.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().documentType).toBe('CONTRACT');
  });
});
