import type { PrismaClient } from '@prisma/client';

export class SavingsGoalService {
  constructor(private prisma: PrismaClient) {}

  async create(params: {
    userId: string;
    name: string;
    targetAmount: bigint;
    currency: string;
    deadline?: Date;
  }) {
    return this.prisma.savingsGoal.create({
      data: {
        userId: params.userId,
        name: params.name,
        targetAmount: params.targetAmount,
        currentAmount: BigInt(0),
        currency: params.currency.toUpperCase(),
        status: 'active',
        deadline: params.deadline ?? null,
      },
    });
  }

  async listByUser(userId: string) {
    return this.prisma.savingsGoal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getById(id: string) {
    return this.prisma.savingsGoal.findUnique({ where: { id } });
  }

  async contribute(id: string, userId: string, amount: bigint) {
    const goal = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!goal) throw new Error('goal_not_found');
    if (goal.userId !== userId) throw new Error('forbidden');
    if (goal.status !== 'active') throw new Error('goal_not_active');

    const newAmount = goal.currentAmount + amount;
    const reached = newAmount >= goal.targetAmount;

    return this.prisma.savingsGoal.update({
      where: { id },
      data: {
        currentAmount: newAmount,
        status: reached ? 'completed' : 'active',
        completedAt: reached ? new Date() : null,
      },
    });
  }

  async withdraw(id: string, userId: string, amount: bigint) {
    const goal = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!goal) throw new Error('goal_not_found');
    if (goal.userId !== userId) throw new Error('forbidden');
    if (goal.currentAmount < amount) throw new Error('insufficient_savings');

    const newAmount = goal.currentAmount - amount;

    return this.prisma.savingsGoal.update({
      where: { id },
      data: {
        currentAmount: newAmount,
        status: newAmount === BigInt(0) && goal.status === 'completed' ? 'active' : goal.status,
      },
    });
  }

  async archive(id: string, userId: string) {
    const goal = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!goal) throw new Error('goal_not_found');
    if (goal.userId !== userId) throw new Error('forbidden');
    if (goal.status === 'archived') throw new Error('already_archived');

    return this.prisma.savingsGoal.update({
      where: { id },
      data: { status: 'archived' },
    });
  }
}
