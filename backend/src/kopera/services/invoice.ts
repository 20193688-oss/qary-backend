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

  async getInvoiceSummary(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });
    let totalBilled = BigInt(0);
    let totalCollected = BigInt(0);
    const byStatus: Record<string, number> = {};

    for (const inv of invoices) {
      totalBilled += inv.totalAmount;
      if (inv.status === 'PAID') totalCollected += inv.totalAmount;
      byStatus[inv.status] = (byStatus[inv.status] ?? 0) + 1;
    }

    return {
      totalInvoices: invoices.length,
      totalBilled,
      totalCollected,
      totalOutstanding: totalBilled - totalCollected,
      byStatus,
    };
  }

  async getCollectionEfficiency(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });

    let totalIssued = 0;
    let paidCount = 0;
    let overdueCount = 0;
    let totalRevenue = BigInt(0);
    let totalPaidMs = 0;
    const revenueByStatus: Record<string, bigint> = {};

    for (const inv of invoices) {
      totalIssued++;
      revenueByStatus[inv.status] = (revenueByStatus[inv.status] ?? BigInt(0)) + inv.totalAmount;

      if (inv.status === 'PAID') {
        paidCount++;
        totalRevenue += inv.totalAmount;
        if ((inv as any).sentAt) {
          totalPaidMs += new Date(inv.createdAt).getTime() - new Date((inv as any).sentAt).getTime();
        }
      } else if (inv.status === 'OVERDUE') {
        overdueCount++;
      }
    }

    const collectionRate = totalIssued > 0
      ? Math.round(paidCount / totalIssued * 10000) / 100
      : 0;
    const overdueRate = totalIssued > 0
      ? Math.round(overdueCount / totalIssued * 10000) / 100
      : 0;

    return {
      totalIssued,
      paidCount,
      overdueCount,
      collectionRate,
      overdueRate,
      totalRevenue,
      revenueByStatus,
    };
  }

  async getAgingReport(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });
    const now = new Date();
    const buckets = { current: [] as any[], overdue1to30: [] as any[], overdue31to60: [] as any[], overdue61to90: [] as any[], overdue90plus: [] as any[] };
    let totalOutstanding = BigInt(0);

    for (const inv of invoices) {
      if (inv.status === 'PAID' || inv.status === 'CANCELLED' || inv.status === 'VOIDED') continue;
      totalOutstanding += inv.totalAmount;
      const entry = { id: inv.id, number: inv.number, currency: inv.currency, totalAmount: inv.totalAmount, status: inv.status, dueDate: inv.dueDate, createdAt: inv.createdAt };

      if (!inv.dueDate || inv.dueDate >= now) {
        buckets.current.push(entry);
      } else {
        const daysOverdue = Math.floor((now.getTime() - inv.dueDate.getTime()) / (1000 * 60 * 60 * 24));
        if (daysOverdue <= 30) buckets.overdue1to30.push(entry);
        else if (daysOverdue <= 60) buckets.overdue31to60.push(entry);
        else if (daysOverdue <= 90) buckets.overdue61to90.push(entry);
        else buckets.overdue90plus.push(entry);
      }
    }

    return {
      totalOutstanding,
      buckets: {
        current: { count: buckets.current.length, items: buckets.current },
        overdue1to30: { count: buckets.overdue1to30.length, items: buckets.overdue1to30 },
        overdue31to60: { count: buckets.overdue31to60.length, items: buckets.overdue31to60 },
        overdue61to90: { count: buckets.overdue61to90.length, items: buckets.overdue61to90 },
        overdue90plus: { count: buckets.overdue90plus.length, items: buckets.overdue90plus },
      },
    };
  }

  async getTaxSummary(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });

    const byCountry: Record<string, { invoiceCount: number; subtotal: bigint; taxAmount: bigint; totalAmount: bigint; totalRate: number; avgTaxRate: number }> = {};
    const byType: Record<string, { invoiceCount: number; subtotal: bigint; taxAmount: bigint; totalAmount: bigint }> = {};
    let totalSubtotal = BigInt(0);
    let totalTax = BigInt(0);
    let totalAmount = BigInt(0);
    let validCount = 0;

    for (const inv of invoices) {
      if (inv.status === 'CANCELLED' || inv.status === 'VOIDED') continue;
      validCount++;

      const country = inv.country;
      if (!byCountry[country]) byCountry[country] = { invoiceCount: 0, subtotal: BigInt(0), taxAmount: BigInt(0), totalAmount: BigInt(0), totalRate: 0, avgTaxRate: 0 };
      byCountry[country].invoiceCount++;
      byCountry[country].subtotal += inv.subtotal;
      byCountry[country].taxAmount += inv.taxAmount;
      byCountry[country].totalAmount += inv.totalAmount;
      byCountry[country].totalRate += inv.taxRate;

      const type = inv.type;
      if (!byType[type]) byType[type] = { invoiceCount: 0, subtotal: BigInt(0), taxAmount: BigInt(0), totalAmount: BigInt(0) };
      byType[type].invoiceCount++;
      byType[type].subtotal += inv.subtotal;
      byType[type].taxAmount += inv.taxAmount;
      byType[type].totalAmount += inv.totalAmount;

      totalSubtotal += inv.subtotal;
      totalTax += inv.taxAmount;
      totalAmount += inv.totalAmount;
    }

    for (const data of Object.values(byCountry)) {
      data.avgTaxRate = data.invoiceCount > 0 ? Math.round((data.totalRate / data.invoiceCount) * 10000) / 10000 : 0;
    }

    const effectiveTaxRate = totalSubtotal > BigInt(0)
      ? Math.round(Number(totalTax * BigInt(10000) / totalSubtotal)) / 100
      : 0;

    return {
      totalInvoices: validCount,
      totalSubtotal,
      totalTax,
      totalAmount,
      effectiveTaxRate,
      byCountry,
      byType,
    };
  }

  async getReceiverAnalysis(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });

    const byReceiver: Record<string, {
      receiverName: string | null;
      invoiceCount: number;
      totalBilled: bigint;
      paidCount: number;
      totalPaid: bigint;
      currencies: Set<string>;
    }> = {};

    for (const inv of invoices) {
      const key = inv.receiverId ?? inv.receiverName ?? 'unknown';
      if (!byReceiver[key]) {
        byReceiver[key] = { receiverName: inv.receiverName, invoiceCount: 0, totalBilled: BigInt(0), paidCount: 0, totalPaid: BigInt(0), currencies: new Set() };
      }
      byReceiver[key].invoiceCount++;
      byReceiver[key].totalBilled += inv.totalAmount;
      byReceiver[key].currencies.add(inv.currency);
      if (inv.status === 'PAID') {
        byReceiver[key].paidCount++;
        byReceiver[key].totalPaid += inv.totalAmount;
      }
    }

    const receivers = Object.entries(byReceiver).map(([receiverId, data]) => ({
      receiverId,
      receiverName: data.receiverName,
      invoiceCount: data.invoiceCount,
      totalBilled: data.totalBilled.toString(),
      paidCount: data.paidCount,
      totalPaid: data.totalPaid.toString(),
      paymentRate: data.invoiceCount > 0
        ? Math.round(data.paidCount / data.invoiceCount * 10000) / 100
        : 0,
      currencies: [...data.currencies],
    })).sort((a, b) => Number(BigInt(b.totalBilled) - BigInt(a.totalBilled)));

    const topReceiver = receivers[0] ?? null;

    return {
      totalInvoices: invoices.length,
      uniqueReceivers: receivers.length,
      receivers,
      topReceiver: topReceiver ? {
        receiverId: topReceiver.receiverId,
        receiverName: topReceiver.receiverName,
        invoiceCount: topReceiver.invoiceCount,
        totalBilled: topReceiver.totalBilled,
        paymentRate: topReceiver.paymentRate,
      } : null,
    };
  }

  async getCashFlowProjection(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });

    const unpaid = invoices.filter((inv: any) => inv.status === 'SENT' || inv.status === 'DRAFT' || inv.status === 'OVERDUE');
    const paid = invoices.filter((inv: any) => inv.status === 'PAID');

    let upcomingTotal = BigInt(0);
    let overdueTotal = BigInt(0);
    const now = new Date();

    const upcoming: Array<{ invoiceId: string; receiverName: string | null; amount: string; currency: string; dueDate: Date | null; daysUntilDue: number | null }> = [];

    for (const inv of unpaid) {
      upcomingTotal += inv.totalAmount;
      const daysUntilDue = inv.dueDate
        ? Math.ceil((inv.dueDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
        : null;
      if (daysUntilDue !== null && daysUntilDue < 0) overdueTotal += inv.totalAmount;
      upcoming.push({
        invoiceId: inv.id,
        receiverName: inv.receiverName,
        amount: inv.totalAmount.toString(),
        currency: inv.currency,
        dueDate: inv.dueDate,
        daysUntilDue,
      });
    }

    upcoming.sort((a, b) => (a.daysUntilDue ?? 999) - (b.daysUntilDue ?? 999));

    let totalPaid = BigInt(0);
    let totalPaidCount = 0;
    for (const inv of paid) {
      totalPaid += inv.totalAmount;
      totalPaidCount++;
    }

    const collectionRate = invoices.length > 0
      ? Math.round((totalPaidCount / invoices.length) * 10000) / 100
      : 0;

    return {
      totalInvoices: invoices.length,
      unpaidCount: unpaid.length,
      paidCount: paid.length,
      upcomingTotal: upcomingTotal.toString(),
      overdueTotal: overdueTotal.toString(),
      historicalCollectionRate: collectionRate,
      expectedCollection: BigInt(Math.round(Number(upcomingTotal) * collectionRate / 100)).toString(),
      upcoming,
    };
  }

  async getInvoiceVolumeAnalysis(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });

    if (invoices.length === 0) {
      return {
        totalInvoices: 0,
        avgInvoiceValue: '0',
        monthlyVolume: [],
        peakMonth: null,
        currencyDistribution: [],
        typeDistribution: [],
        monthOverMonthGrowth: 0,
      };
    }

    const monthMap = new Map<string, { count: number; totalAmount: bigint }>();
    const currencyMap = new Map<string, number>();
    const typeMap = new Map<string, number>();
    let totalAmount = BigInt(0);

    for (const inv of invoices) {
      const d = new Date(inv.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const entry = monthMap.get(key) ?? { count: 0, totalAmount: BigInt(0) };
      entry.count++;
      entry.totalAmount += inv.totalAmount;
      monthMap.set(key, entry);
      totalAmount += inv.totalAmount;

      currencyMap.set(inv.currency, (currencyMap.get(inv.currency) ?? 0) + 1);
      const invType = (inv as any).type ?? 'STANDARD';
      typeMap.set(invType, (typeMap.get(invType) ?? 0) + 1);
    }

    const avgInvoiceValue = (totalAmount / BigInt(invoices.length)).toString();

    const monthlyVolume = Array.from(monthMap.entries())
      .map(([month, data]) => ({
        month,
        count: data.count,
        totalAmount: data.totalAmount.toString(),
      }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const peakMonth = monthlyVolume.reduce((best, m) => m.count > best.count ? m : best, monthlyVolume[0]);

    let monthOverMonthGrowth = 0;
    if (monthlyVolume.length >= 2) {
      const last = monthlyVolume[monthlyVolume.length - 1].count;
      const prev = monthlyVolume[monthlyVolume.length - 2].count;
      monthOverMonthGrowth = prev > 0 ? Math.round(((last - prev) / prev) * 10000) / 100 : 0;
    }

    const currencyDistribution = Array.from(currencyMap.entries())
      .map(([currency, count]) => ({
        currency,
        count,
        share: Math.round((count / invoices.length) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    const typeDistribution = Array.from(typeMap.entries())
      .map(([type, count]) => ({
        type,
        count,
        share: Math.round((count / invoices.length) * 10000) / 100,
      }))
      .sort((a, b) => b.count - a.count);

    return {
      totalInvoices: invoices.length,
      avgInvoiceValue,
      monthlyVolume,
      peakMonth: peakMonth.month,
      currencyDistribution,
      typeDistribution,
      monthOverMonthGrowth,
    };
  }

  async getPaymentBehaviorAnalysis(senderId: string) {
    const invoices = await this.prisma.invoice.findMany({ where: { senderId } });

    if (invoices.length === 0) {
      return {
        totalInvoices: 0,
        paidCount: 0,
        unpaidCount: 0,
        avgDaysToPay: 0,
        medianDaysToPay: 0,
        onTimeRate: 0,
        byPaymentSpeed: [],
        overdueAmount: '0',
      };
    }

    const paid = invoices.filter((inv) => inv.status === 'PAID' && inv.paidAt);
    const unpaid = invoices.filter((inv) => inv.status !== 'PAID' && inv.status !== 'CANCELLED');

    const daysToPay = paid.map((inv) => {
      const ms = new Date(inv.paidAt!).getTime() - new Date(inv.createdAt).getTime();
      return Math.max(0, Math.round(ms / 86400000));
    }).sort((a, b) => a - b);

    const avgDays = daysToPay.length > 0
      ? Math.round(daysToPay.reduce((s, d) => s + d, 0) / daysToPay.length)
      : 0;
    const medianDays = daysToPay.length > 0
      ? daysToPay[Math.floor(daysToPay.length / 2)]
      : 0;

    const onTime = paid.filter((inv) => {
      if (!inv.dueDate) return true;
      return new Date(inv.paidAt!).getTime() <= new Date(inv.dueDate).getTime();
    });
    const onTimeRate = paid.length > 0
      ? Math.round((onTime.length / paid.length) * 10000) / 100
      : 0;

    const speedBuckets = [
      { bucket: 'immediate', label: '0-3 days', min: 0, max: 3 },
      { bucket: 'prompt', label: '4-14 days', min: 4, max: 14 },
      { bucket: 'standard', label: '15-30 days', min: 15, max: 30 },
      { bucket: 'slow', label: '31-60 days', min: 31, max: 60 },
      { bucket: 'very_slow', label: '60+ days', min: 61, max: Infinity },
    ];

    const byPaymentSpeed = speedBuckets.map((b) => {
      const inBucket = daysToPay.filter((d) => d >= b.min && d <= b.max);
      return {
        bucket: b.bucket,
        label: b.label,
        count: inBucket.length,
        percent: daysToPay.length > 0 ? Math.round((inBucket.length / daysToPay.length) * 10000) / 100 : 0,
      };
    }).filter((b) => b.count > 0);

    let overdueAmount = BigInt(0);
    for (const inv of unpaid) {
      if (inv.dueDate && new Date(inv.dueDate).getTime() < Date.now()) {
        overdueAmount += inv.totalAmount;
      }
    }

    return {
      totalInvoices: invoices.length,
      paidCount: paid.length,
      unpaidCount: unpaid.length,
      avgDaysToPay: avgDays,
      medianDaysToPay: medianDays,
      onTimeRate,
      byPaymentSpeed,
      overdueAmount: overdueAmount.toString(),
    };
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
