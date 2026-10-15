import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class InvoiceCreditNoteService {
  constructor(private prisma: PrismaClient) {}

  async createCreditNote(userId: string, data: {
    invoiceId: string;
    amount: bigint;
    currency: string;
    reason: string;
  }) {
    return this.prisma.invoiceCreditNote.create({
      data: {
        userId,
        invoiceId: data.invoiceId,
        amount: data.amount,
        currency: data.currency.toUpperCase(),
        reason: data.reason,
        status: 'ISSUED',
        reference: `ICN-${Date.now()}-${randomUUID().slice(0, 8)}`,
        issuedAt: new Date(),
      },
    });
  }

  async getCreditNotes(userId: string) {
    return this.prisma.invoiceCreditNote.findMany({ where: { userId } });
  }

  async getCreditNote(userId: string, id: string) {
    const cn = await this.prisma.invoiceCreditNote.findUnique({ where: { id } });
    if (!cn) throw new Error('credit_note_not_found');
    if ((cn as any).userId !== userId) throw new Error('credit_note_not_found');
    return cn;
  }

  async applyCreditNote(userId: string, id: string) {
    const cn = await this.getCreditNote(userId, id);
    if ((cn as any).status !== 'ISSUED') throw new Error('credit_note_not_issued');

    return this.prisma.invoiceCreditNote.update({
      where: { id },
      data: { status: 'APPLIED', appliedAt: new Date() },
    });
  }

  async voidCreditNote(userId: string, id: string) {
    const cn = await this.getCreditNote(userId, id);
    if ((cn as any).status === 'VOIDED') throw new Error('credit_note_already_voided');

    return this.prisma.invoiceCreditNote.update({
      where: { id },
      data: { status: 'VOIDED', voidedAt: new Date() },
    });
  }

  async getCreditNoteAnalytics(userId: string) {
    const notes = await this.prisma.invoiceCreditNote.findMany({ where: { userId } });

    if (notes.length === 0) {
      return {
        totalNotes: 0,
        breakdown: { ISSUED: 0, APPLIED: 0, VOIDED: 0 },
        totalAmount: '0',
        analyticsLevel: 'no_data',
      };
    }

    const breakdown: Record<string, number> = { ISSUED: 0, APPLIED: 0, VOIDED: 0 };
    let totalAmount = BigInt(0);
    for (const n of notes as any[]) {
      const status = n.status as string;
      if (status in breakdown) breakdown[status]++;
      totalAmount += n.amount as bigint;
    }

    return {
      totalNotes: notes.length,
      breakdown,
      totalAmount: totalAmount.toString(),
      analyticsLevel: notes.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
