import type { PrismaClient } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';

export class DocumentVaultService {
  constructor(private prisma: PrismaClient) {}

  async storeDocument(userId: string, data: {
    documentType: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    storageUrl: string;
    category?: string;
    expiresAt?: Date;
  }) {
    const contentHash = createHash('sha256')
      .update(`${data.fileName}:${data.fileSize}:${Date.now()}`)
      .digest('hex');

    return this.prisma.documentVault.create({
      data: {
        userId,
        documentType: data.documentType,
        fileName: data.fileName,
        fileSize: data.fileSize,
        mimeType: data.mimeType,
        storageUrl: data.storageUrl,
        category: data.category || 'GENERAL',
        contentHash,
        status: 'ACTIVE',
        expiresAt: data.expiresAt || null,
        reference: `DOC-${Date.now()}-${randomUUID().slice(0, 8)}`,
        uploadedAt: new Date(),
      },
    });
  }

  async getDocuments(userId: string) {
    return this.prisma.documentVault.findMany({ where: { userId } });
  }

  async getDocument(userId: string, id: string) {
    const doc = await this.prisma.documentVault.findUnique({ where: { id } });
    if (!doc) throw new Error('document_not_found');
    if ((doc as any).userId !== userId) throw new Error('document_not_found');
    return doc;
  }

  async archiveDocument(userId: string, id: string) {
    const doc = await this.getDocument(userId, id);
    if ((doc as any).status === 'ARCHIVED') throw new Error('document_already_archived');

    return this.prisma.documentVault.update({
      where: { id },
      data: { status: 'ARCHIVED', archivedAt: new Date() },
    });
  }

  async deleteDocument(userId: string, id: string) {
    await this.getDocument(userId, id);
    return this.prisma.documentVault.delete({ where: { id } });
  }

  async getDocumentsByCategory(userId: string, category: string) {
    const docs = await this.prisma.documentVault.findMany({ where: { userId } });
    return (docs as any[]).filter((d) => d.category === category);
  }

  async verifyIntegrity(userId: string, id: string) {
    const doc = await this.getDocument(userId, id);
    return {
      id: (doc as any).id,
      integrityValid: !!(doc as any).contentHash,
      contentHash: (doc as any).contentHash,
      status: (doc as any).status,
    };
  }

  async getVaultAnalytics(userId: string) {
    const docs = await this.prisma.documentVault.findMany({ where: { userId } });

    if (docs.length === 0) {
      return {
        totalDocuments: 0,
        breakdown: { active: 0, archived: 0 },
        totalSize: 0,
        categories: {},
        analyticsLevel: 'no_data',
      };
    }

    const breakdown = { active: 0, archived: 0 };
    let totalSize = 0;
    const categories: Record<string, number> = {};
    const now = new Date();
    let expiringCount = 0;

    for (const d of docs as any[]) {
      if (d.status === 'ACTIVE') breakdown.active++;
      else breakdown.archived++;
      totalSize += d.fileSize || 0;
      categories[d.category] = (categories[d.category] || 0) + 1;
      if (d.expiresAt && new Date(d.expiresAt).getTime() - now.getTime() < 30 * 24 * 60 * 60 * 1000) {
        expiringCount++;
      }
    }

    return {
      totalDocuments: docs.length,
      breakdown,
      totalSize,
      categories,
      expiringDocuments: expiringCount,
      analyticsLevel: docs.length >= 5 ? 'sufficient' : 'limited',
    };
  }
}
