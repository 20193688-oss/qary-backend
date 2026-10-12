import type { PrismaClient } from '@prisma/client';
import { createHash } from 'node:crypto';

interface CreateInvoiceParams {
  senderId: string;
  receiverId?: string;
  type: string;
  currency: string;
  subtotal: bigint;
  taxRate?: number;
  country: string;
  senderTaxId?: string;
  senderName?: string;
  receiverTaxId?: string;
  receiverName?: string;
  lineItems?: unknown[];
  notes?: string;
  transactionId?: string;
}

export class InvoiceService {
  constructor(private prisma: PrismaClient) {}

  async create(params: CreateInvoiceParams) {
    const taxRate = params.taxRate ?? this.getDefaultTaxRate(params.country);
    const taxAmount = BigInt(Math.round(Number(params.subtotal) * taxRate));
    const totalAmount = params.subtotal + taxAmount;

    const series = this.getSeriesPrefix(params.country, params.type);
    const count = await this.prisma.invoice.count({
      where: { senderId: params.senderId, type: params.type as any, country: params.country },
    });
    const number = `${series}-${String(count + 1).padStart(8, '0')}`;

    const xmlPayload = this.generateXml(params, { taxAmount, totalAmount, number, taxRate });
    const xmlHash = createHash('sha256').update(xmlPayload).digest('hex');

    return this.prisma.invoice.create({
      data: {
        senderId: params.senderId,
        receiverId: params.receiverId,
        transactionId: params.transactionId,
        type: params.type as any,
        status: 'ISSUED',
        series,
        number,
        currency: params.currency.toUpperCase(),
        subtotal: params.subtotal,
        taxAmount,
        taxRate,
        totalAmount,
        senderTaxId: params.senderTaxId,
        senderName: params.senderName,
        receiverTaxId: params.receiverTaxId,
        receiverName: params.receiverName,
        country: params.country.toUpperCase(),
        xmlPayload,
        xmlHash,
        lineItems: (params.lineItems ?? []) as object[],
        notes: params.notes,
      },
    });
  }

  async getById(invoiceId: string) {
    return this.prisma.invoice.findUnique({ where: { id: invoiceId } });
  }

  async listBySender(senderId: string, opts?: { status?: string; limit?: number; offset?: number }) {
    return this.prisma.invoice.findMany({
      where: {
        senderId,
        ...(opts?.status ? { status: opts.status as any } : {}),
      },
      take: opts?.limit ?? 20,
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async listByReceiver(receiverId: string, opts?: { status?: string; limit?: number; offset?: number }) {
    return this.prisma.invoice.findMany({
      where: {
        receiverId,
        ...(opts?.status ? { status: opts.status as any } : {}),
      },
      take: opts?.limit ?? 20,
      skip: opts?.offset ?? 0,
      orderBy: { createdAt: 'desc' },
    });
  }

  async update(invoiceId: string, senderId: string, data: {
    notes?: string;
    receiverTaxId?: string;
    receiverName?: string;
    dueDate?: Date | null;
    lineItems?: unknown[];
  }) {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new Error('invoice_not_found');
    if (inv.senderId !== senderId) throw new Error('forbidden');
    if (inv.status !== 'ISSUED') throw new Error('invoice_not_editable');

    const updateData: Record<string, unknown> = {};
    if (data.notes !== undefined) updateData.notes = data.notes;
    if (data.receiverTaxId !== undefined) updateData.receiverTaxId = data.receiverTaxId;
    if (data.receiverName !== undefined) updateData.receiverName = data.receiverName;
    if (data.dueDate !== undefined) updateData.dueDate = data.dueDate;
    if (data.lineItems !== undefined) updateData.lineItems = data.lineItems as object[];

    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: updateData,
    });
  }

  async markAsPaid(invoiceId: string, senderId: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new Error('invoice_not_found');
    if (inv.senderId !== senderId) throw new Error('forbidden');
    if (inv.status === 'PAID') throw new Error('already_paid');
    if (inv.status === 'CANCELLED' || inv.status === 'VOIDED') throw new Error('invalid_status');

    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'PAID' },
    });
  }

  async markAsSent(invoiceId: string) {
    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'SENT', sentAt: new Date() },
    });
  }

  async voidInvoice(invoiceId: string, senderId: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new Error('invoice_not_found');
    if (inv.senderId !== senderId) throw new Error('forbidden');
    if (inv.status === 'VOIDED') throw new Error('already_voided');
    if (inv.status === 'CANCELLED') throw new Error('invalid_status');

    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'VOIDED' },
    });
  }

  async cancelInvoice(invoiceId: string, senderId: string) {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (!inv) throw new Error('invoice_not_found');
    if (inv.senderId !== senderId) throw new Error('forbidden');
    if (inv.status === 'CANCELLED') throw new Error('already_cancelled');
    if (inv.status === 'VOIDED' || inv.status === 'PAID') throw new Error('invalid_status');

    return this.prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'CANCELLED' },
    });
  }

  async checkOverdue(senderId: string) {
    const now = new Date();
    const overdue = await this.prisma.invoice.findMany({
      where: {
        senderId,
        status: { in: ['ISSUED', 'SENT'] },
        dueDate: { lt: now },
      },
    });

    let count = 0;
    for (const inv of overdue) {
      await this.prisma.invoice.update({
        where: { id: inv.id },
        data: { status: 'OVERDUE' },
      });
      count++;
    }
    return { updated: count };
  }

  private getDefaultTaxRate(country: string): number {
    const rates: Record<string, number> = {
      PE: 0.18, // IGV
      MX: 0.16, // IVA
      BR: 0.12, // ICMS average
      CL: 0.19, // IVA
      CO: 0.19, // IVA
      AR: 0.21, // IVA
      ES: 0.21, // IVA
      US: 0.0,  // varies by state
      GB: 0.20, // VAT
      SG: 0.09, // GST
      AU: 0.10, // GST
      IN: 0.18, // GST
    };
    return rates[country.toUpperCase()] ?? 0;
  }

  private getSeriesPrefix(country: string, type: string): string {
    const prefixes: Record<string, Record<string, string>> = {
      PE: { BOLETA: 'B001', FACTURA: 'F001', NOTA_CREDITO: 'BC01', NOTA_DEBITO: 'BD01' },
      MX: { FACTURA: 'A', NOTA_CREDITO: 'NC' },
      BR: { FACTURA: 'NF', NOTA_CREDITO: 'NFC' },
    };
    return prefixes[country.toUpperCase()]?.[type] ?? 'INV';
  }

  private generateXml(
    params: CreateInvoiceParams,
    computed: { taxAmount: bigint; totalAmount: bigint; number: string; taxRate: number },
  ): string {
    const now = new Date().toISOString();
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<Invoice xmlns="urn:kopera:invoice:1.0" country="${params.country}">`,
      `  <IssueDate>${now}</IssueDate>`,
      `  <InvoiceNumber>${computed.number}</InvoiceNumber>`,
      `  <InvoiceType>${params.type}</InvoiceType>`,
      `  <Sender>`,
      `    <TaxId>${params.senderTaxId ?? ''}</TaxId>`,
      `    <Name>${params.senderName ?? ''}</Name>`,
      `  </Sender>`,
      `  <Receiver>`,
      `    <TaxId>${params.receiverTaxId ?? ''}</TaxId>`,
      `    <Name>${params.receiverName ?? ''}</Name>`,
      `  </Receiver>`,
      `  <Currency>${params.currency}</Currency>`,
      `  <Subtotal>${params.subtotal.toString()}</Subtotal>`,
      `  <TaxRate>${computed.taxRate}</TaxRate>`,
      `  <TaxAmount>${computed.taxAmount.toString()}</TaxAmount>`,
      `  <TotalAmount>${computed.totalAmount.toString()}</TotalAmount>`,
      `</Invoice>`,
    ].join('\n');
  }
}
