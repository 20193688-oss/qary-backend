import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { InvoiceService } from '../../kopera/services/invoice.js';
import { audit } from '../../lib/audit.js';

export async function registerInvoiceRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const invoices = new InvoiceService(prisma);

  app.post('/api/invoices', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      type: z.enum(['BOLETA', 'FACTURA', 'NOTA_CREDITO', 'NOTA_DEBITO', 'RECIBO']),
      currency: z.string().length(3),
      subtotal: z.number().positive(),
      taxRate: z.number().min(0).max(1).optional(),
      country: z.string().length(2),
      receiverId: z.string().optional(),
      senderTaxId: z.string().optional(),
      senderName: z.string().optional(),
      receiverTaxId: z.string().optional(),
      receiverName: z.string().optional(),
      lineItems: z.array(z.object({
        description: z.string(),
        quantity: z.number().positive(),
        unitPrice: z.number().positive(),
        total: z.number().positive(),
      })).optional(),
      notes: z.string().optional(),
    }).parse(req.body);

    const invoice = await invoices.create({
      senderId: req.auth!.userId,
      receiverId: body.receiverId,
      type: body.type,
      currency: body.currency,
      subtotal: BigInt(Math.round(body.subtotal * 100)),
      taxRate: body.taxRate,
      country: body.country,
      senderTaxId: body.senderTaxId,
      senderName: body.senderName,
      receiverTaxId: body.receiverTaxId,
      receiverName: body.receiverName,
      lineItems: body.lineItems,
      notes: body.notes,
    });

    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'invoice.created',
      payload: { invoiceId: invoice.id, type: body.type, country: body.country },
      requestId: String(req.id), ip: req.ip,
    });

    return reply.code(201).send(serializeInvoice(invoice));
  });

  app.get('/api/invoices/summary', { preHandler: [app.requireAuth] }, async (req) => {
    const summary = await invoices.getInvoiceSummary(req.auth!.userId);
    return {
      totalInvoices: summary.totalInvoices,
      totalBilled: summary.totalBilled.toString(),
      totalCollected: summary.totalCollected.toString(),
      totalOutstanding: summary.totalOutstanding.toString(),
      byStatus: summary.byStatus,
    };
  });

  app.get('/api/invoices/collection-efficiency', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await invoices.getCollectionEfficiency(req.auth!.userId);
    const revenueByStatus: Record<string, string> = {};
    for (const [status, amt] of Object.entries(result.revenueByStatus)) {
      revenueByStatus[status] = amt.toString();
    }
    return {
      totalIssued: result.totalIssued,
      paidCount: result.paidCount,
      overdueCount: result.overdueCount,
      collectionRate: result.collectionRate,
      overdueRate: result.overdueRate,
      totalRevenue: result.totalRevenue.toString(),
      revenueByStatus,
    };
  });

  app.get('/api/invoices/aging', { preHandler: [app.requireAuth] }, async (req) => {
    const report = await invoices.getAgingReport(req.auth!.userId);
    const serializeBucket = (bucket: any) => ({
      count: bucket.count,
      items: bucket.items.map((i: any) => ({ ...i, totalAmount: i.totalAmount.toString() })),
    });
    return {
      totalOutstanding: report.totalOutstanding.toString(),
      buckets: {
        current: serializeBucket(report.buckets.current),
        overdue1to30: serializeBucket(report.buckets.overdue1to30),
        overdue31to60: serializeBucket(report.buckets.overdue31to60),
        overdue61to90: serializeBucket(report.buckets.overdue61to90),
        overdue90plus: serializeBucket(report.buckets.overdue90plus),
      },
    };
  });

  app.get('/api/invoices/tax-summary', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await invoices.getTaxSummary(req.auth!.userId);
    const byCountry: Record<string, any> = {};
    for (const [country, data] of Object.entries(result.byCountry)) {
      byCountry[country] = {
        invoiceCount: data.invoiceCount,
        subtotal: data.subtotal.toString(),
        taxAmount: data.taxAmount.toString(),
        totalAmount: data.totalAmount.toString(),
        avgTaxRate: data.avgTaxRate,
      };
    }
    const byType: Record<string, any> = {};
    for (const [type, data] of Object.entries(result.byType)) {
      byType[type] = {
        invoiceCount: data.invoiceCount,
        subtotal: data.subtotal.toString(),
        taxAmount: data.taxAmount.toString(),
        totalAmount: data.totalAmount.toString(),
      };
    }
    return {
      totalInvoices: result.totalInvoices,
      totalSubtotal: result.totalSubtotal.toString(),
      totalTax: result.totalTax.toString(),
      totalAmount: result.totalAmount.toString(),
      effectiveTaxRate: result.effectiveTaxRate,
      byCountry,
      byType,
    };
  });

  app.get('/api/invoices/receiver-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return invoices.getReceiverAnalysis(req.auth!.userId);
  });

  app.get('/api/invoices/cash-flow-projection', { preHandler: [app.requireAuth] }, async (req) => {
    return invoices.getCashFlowProjection(req.auth!.userId);
  });

  app.get('/api/invoices/volume-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return invoices.getInvoiceVolumeAnalysis(req.auth!.userId);
  });

  app.get('/api/invoices/payment-behavior', { preHandler: [app.requireAuth] }, async (req) => {
    return invoices.getPaymentBehaviorAnalysis(req.auth!.userId);
  });

  app.get('/api/invoices/revenue-concentration', { preHandler: [app.requireAuth] }, async (req) => {
    return invoices.getRevenueConcentrationAnalysis(req.auth!.userId);
  });

  app.get('/api/invoices/dispute-risk', { preHandler: [app.requireAuth] }, async (req) => {
    return invoices.getInvoiceDisputeRiskAnalysis(req.auth!.userId);
  });

  app.get('/api/invoices/cashflow-impact', { preHandler: [app.requireAuth] }, async (req) => {
    return invoices.getInvoiceCashflowImpact(req.auth!.userId);
  });

  app.get('/api/invoices', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { status?: string; limit?: string; offset?: string };
    const list = await invoices.listBySender(req.auth!.userId, {
      status: query.status,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return list.map(serializeInvoice);
  });

  app.get('/api/invoices/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const invoice = await invoices.getById(id);
    if (!invoice) return reply.code(404).send({ error: 'not_found' });
    if (invoice.senderId !== req.auth!.userId && invoice.receiverId !== req.auth!.userId) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    return serializeInvoice(invoice);
  });

  app.patch('/api/invoices/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      notes: z.string().optional(),
      receiverTaxId: z.string().optional(),
      receiverName: z.string().optional(),
      dueDate: z.string().datetime().nullable().optional(),
      lineItems: z.array(z.object({
        description: z.string(),
        quantity: z.number().positive(),
        unitPrice: z.number().positive(),
        total: z.number().positive(),
      })).optional(),
    }).parse(req.body);

    try {
      const updated = await invoices.update(id, req.auth!.userId, {
        notes: body.notes,
        receiverTaxId: body.receiverTaxId,
        receiverName: body.receiverName,
        dueDate: body.dueDate === null ? null : body.dueDate ? new Date(body.dueDate) : undefined,
        lineItems: body.lineItems,
      });
      return reply.send(serializeInvoice(updated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'invoice_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'invoice_not_editable') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/invoices/:id/send', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const invoice = await invoices.getById(id);
    if (!invoice) return reply.code(404).send({ error: 'not_found' });
    if (invoice.senderId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
    const updated = await invoices.markAsSent(id);
    return serializeInvoice(updated);
  });

  app.get('/api/invoices/received', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { status?: string; limit?: string; offset?: string };
    const list = await invoices.listByReceiver(req.auth!.userId, {
      status: query.status,
      limit: Math.min(Number(query.limit ?? 20), 100),
      offset: Number(query.offset ?? 0),
    });
    return list.map(serializeInvoice);
  });

  app.post('/api/invoices/:id/pay', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const updated = await invoices.markAsPaid(id, req.auth!.userId);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'invoice.paid',
        payload: { invoiceId: id },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.send(serializeInvoice(updated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'invoice_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'already_paid' || msg === 'invalid_status') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/invoices/:id/void', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const updated = await invoices.voidInvoice(id, req.auth!.userId);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'invoice.voided',
        payload: { invoiceId: id },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.send(serializeInvoice(updated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'invoice_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'already_voided' || msg === 'invalid_status') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/invoices/:id/cancel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const updated = await invoices.cancelInvoice(id, req.auth!.userId);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'invoice.cancelled',
        payload: { invoiceId: id },
        requestId: String(req.id), ip: req.ip,
      });

      return reply.send(serializeInvoice(updated));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'unknown';
      if (msg === 'invoice_not_found') return reply.code(404).send({ error: msg });
      if (msg === 'forbidden') return reply.code(403).send({ error: msg });
      if (msg === 'already_cancelled' || msg === 'invalid_status') return reply.code(400).send({ error: msg });
      throw err;
    }
  });

  app.post('/api/invoices/check-overdue', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await invoices.checkOverdue(req.auth!.userId);
    return result;
  });
}

function serializeInvoice(inv: any) {
  return {
    id: inv.id,
    type: inv.type,
    status: inv.status,
    series: inv.series,
    number: inv.number,
    currency: inv.currency,
    subtotal: inv.subtotal.toString(),
    taxAmount: inv.taxAmount.toString(),
    taxRate: inv.taxRate,
    totalAmount: inv.totalAmount.toString(),
    country: inv.country,
    senderTaxId: inv.senderTaxId,
    senderName: inv.senderName,
    receiverTaxId: inv.receiverTaxId,
    receiverName: inv.receiverName,
    lineItems: inv.lineItems,
    notes: inv.notes,
    dueDate: inv.dueDate ?? null,
    xmlHash: inv.xmlHash,
    sentAt: inv.sentAt,
    createdAt: inv.createdAt,
  };
}
