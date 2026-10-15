import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export class AccountGroupService {
  constructor(private prisma: PrismaClient) {}

  async createGroup(userId: string, data: {
    name: string;
    description?: string;
    groupType: string;
  }) {
    const existing = await this.prisma.accountGroup.findFirst({
      where: { userId, name: data.name },
    });
    if (existing) throw new Error('group_name_exists');

    return this.prisma.accountGroup.create({
      data: {
        userId,
        name: data.name,
        description: data.description || null,
        groupType: data.groupType.toUpperCase(),
        memberCount: 0,
        isActive: true,
        reference: `AGR-${Date.now()}-${randomUUID().slice(0, 8)}`,
      },
    });
  }

  async getGroups(userId: string) {
    return this.prisma.accountGroup.findMany({ where: { userId } });
  }

  async getGroup(userId: string, id: string) {
    const group = await this.prisma.accountGroup.findUnique({ where: { id } });
    if (!group) throw new Error('group_not_found');
    if ((group as any).userId !== userId) throw new Error('group_not_found');
    return group;
  }

  async updateGroup(userId: string, id: string, data: {
    name?: string;
    description?: string;
  }) {
    await this.getGroup(userId, id);
    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.description !== undefined) updateData.description = data.description;
    return this.prisma.accountGroup.update({ where: { id }, data: updateData });
  }

  async addMember(userId: string, groupId: string, data: {
    accountId: string;
    role?: string;
  }) {
    const group = await this.getGroup(userId, groupId);

    const existingMembers = await this.prisma.accountGroupMember.findMany({ where: { groupId } });
    const alreadyMember = (existingMembers as any[]).some((m) => m.accountId === data.accountId);
    if (alreadyMember) throw new Error('member_already_exists');

    const member = await this.prisma.accountGroupMember.create({
      data: {
        groupId,
        accountId: data.accountId,
        role: data.role || 'MEMBER',
        joinedAt: new Date(),
      },
    });

    await this.prisma.accountGroup.update({
      where: { id: groupId },
      data: { memberCount: ((group as any).memberCount || 0) + 1 },
    });

    return member;
  }

  async removeMember(userId: string, groupId: string, memberId: string) {
    const group = await this.getGroup(userId, groupId);
    const member = await this.prisma.accountGroupMember.findUnique({ where: { id: memberId } });
    if (!member || (member as any).groupId !== groupId) throw new Error('member_not_found');

    await this.prisma.accountGroupMember.delete({ where: { id: memberId } });
    await this.prisma.accountGroup.update({
      where: { id: groupId },
      data: { memberCount: Math.max(0, ((group as any).memberCount || 1) - 1) },
    });

    return { removed: true };
  }

  async getMembers(userId: string, groupId: string) {
    await this.getGroup(userId, groupId);
    return this.prisma.accountGroupMember.findMany({ where: { groupId } });
  }

  async deleteGroup(userId: string, id: string) {
    await this.getGroup(userId, id);
    await this.prisma.accountGroupMember.deleteMany({ where: { groupId: id } });
    return this.prisma.accountGroup.delete({ where: { id } });
  }

  async getGroupAnalytics(userId: string) {
    const groups = await this.prisma.accountGroup.findMany({ where: { userId } });

    if (groups.length === 0) {
      return {
        totalGroups: 0,
        activeGroups: 0,
        groupTypes: {},
        totalMembers: 0,
        analyticsLevel: 'no_data',
      };
    }

    const active = (groups as any[]).filter((g) => g.isActive).length;
    const groupTypes: Record<string, number> = {};
    let totalMembers = 0;
    for (const g of groups as any[]) {
      groupTypes[g.groupType] = (groupTypes[g.groupType] || 0) + 1;
      totalMembers += g.memberCount || 0;
    }

    return {
      totalGroups: groups.length,
      activeGroups: active,
      groupTypes,
      totalMembers,
      analyticsLevel: groups.length >= 3 ? 'sufficient' : 'limited',
    };
  }
}
