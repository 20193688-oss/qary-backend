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

  async update(id: string, userId: string, data: { name?: string; targetAmount?: bigint; deadline?: Date | null }) {
    const goal = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!goal) throw new Error('goal_not_found');
    if (goal.userId !== userId) throw new Error('forbidden');
    if (goal.status === 'archived') throw new Error('goal_archived');

    const updateData: Record<string, unknown> = {};
    if (data.name !== undefined) updateData.name = data.name;
    if (data.targetAmount !== undefined) {
      updateData.targetAmount = data.targetAmount;
      const reached = goal.currentAmount >= data.targetAmount;
      if (reached && goal.status === 'active') {
        updateData.status = 'completed';
        updateData.completedAt = new Date();
      } else if (!reached && goal.status === 'completed') {
        updateData.status = 'active';
        updateData.completedAt = null;
      }
    }
    if (data.deadline !== undefined) updateData.deadline = data.deadline;

    return this.prisma.savingsGoal.update({ where: { id }, data: updateData });
  }

  async getSummary(userId: string) {
    const goals = await this.prisma.savingsGoal.findMany({ where: { userId } });

    let totalTarget = BigInt(0);
    let totalSaved = BigInt(0);
    const byStatus: Record<string, number> = { active: 0, completed: 0, archived: 0 };
    let nearestDeadline: Date | null = null;

    for (const g of goals) {
      totalTarget += g.targetAmount;
      totalSaved += g.currentAmount;
      byStatus[g.status] = (byStatus[g.status] ?? 0) + 1;
      if (g.status === 'active' && g.deadline) {
        if (!nearestDeadline || g.deadline < nearestDeadline) {
          nearestDeadline = g.deadline;
        }
      }
    }

    return {
      totalGoals: goals.length,
      totalTarget,
      totalSaved,
      overallProgress: totalTarget > BigInt(0)
        ? Math.min(100, Math.round(Number(totalSaved * BigInt(10000) / totalTarget)) / 100)
        : 0,
      byStatus,
      nearestDeadline,
    };
  }

  async getGoalProgress(id: string, userId: string) {
    const goal = await this.prisma.savingsGoal.findUnique({ where: { id } });
    if (!goal) throw new Error('goal_not_found');
    if (goal.userId !== userId) throw new Error('forbidden');

    const progressPercent = goal.targetAmount > BigInt(0)
      ? Math.min(100, Math.round(Number(goal.currentAmount * BigInt(10000) / goal.targetAmount)) / 100)
      : 0;

    const remaining = goal.targetAmount - goal.currentAmount;
    let daysRemaining: number | null = null;
    if (goal.deadline) {
      daysRemaining = Math.max(0, Math.ceil((goal.deadline.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
    }

    return {
      goalId: goal.id,
      name: goal.name,
      currentAmount: goal.currentAmount,
      targetAmount: goal.targetAmount,
      remaining: remaining > BigInt(0) ? remaining : BigInt(0),
      currency: goal.currency,
      progressPercent,
      status: goal.status,
      deadline: goal.deadline,
      daysRemaining,
    };
  }

  async getCompletionForecast(userId: string) {
    const goals = await this.prisma.savingsGoal.findMany({ where: { userId } });
    const activeGoals = goals.filter((g: any) => g.status === 'active');
    const now = Date.now();

    const forecasts = activeGoals.map((g: any) => {
      const ageMs = now - new Date(g.createdAt).getTime();
      const ageDays = Math.max(1, ageMs / (1000 * 60 * 60 * 24));
      const remaining = g.targetAmount - g.currentAmount;
      const dailyRate = Number(g.currentAmount) / ageDays;

      let projectedCompletionDate: string | null = null;
      let daysToCompletion: number | null = null;
      let atRisk = false;

      if (dailyRate > 0 && remaining > BigInt(0)) {
        daysToCompletion = Math.ceil(Number(remaining) / dailyRate);
        projectedCompletionDate = new Date(now + daysToCompletion * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        if (g.deadline && new Date(projectedCompletionDate) > g.deadline) {
          atRisk = true;
        }
      } else if (remaining > BigInt(0)) {
        atRisk = g.deadline ? true : false;
      }

      return {
        goalId: g.id,
        name: g.name,
        currency: g.currency,
        currentAmount: g.currentAmount,
        targetAmount: g.targetAmount,
        dailyContributionRate: Math.round(dailyRate),
        projectedCompletionDate,
        daysToCompletion,
        deadline: g.deadline,
        atRisk,
      };
    });

    const atRiskCount = forecasts.filter(f => f.atRisk).length;

    return {
      totalActiveGoals: activeGoals.length,
      atRiskCount,
      forecasts,
    };
  }

  async getSavingsHealth(userId: string) {
    const goals = await this.prisma.savingsGoal.findMany({ where: { userId } });
    const now = Date.now();
    const activeGoals = goals.filter((g: any) => g.status === 'active');

    let onTrackCount = 0;
    let behindCount = 0;
    let aheadCount = 0;
    let noDeadlineCount = 0;
    let totalSaved = BigInt(0);
    let totalTarget = BigInt(0);

    const goalStatuses: Array<{
      goalId: string; name: string; currency: string; status: string;
      progressPercent: number; trackingStatus: string;
    }> = [];

    for (const g of activeGoals) {
      totalSaved += g.currentAmount;
      totalTarget += g.targetAmount;

      const progressPercent = g.targetAmount > BigInt(0)
        ? Math.min(100, Math.round(Number(g.currentAmount * BigInt(10000) / g.targetAmount)) / 100)
        : 0;

      let trackingStatus = 'no_deadline';

      if (g.deadline) {
        const totalDurationMs = g.deadline.getTime() - new Date(g.createdAt).getTime();
        const elapsedMs = now - new Date(g.createdAt).getTime();
        const timeProgressPercent = totalDurationMs > 0 ? (elapsedMs / totalDurationMs) * 100 : 100;

        if (progressPercent >= timeProgressPercent + 10) {
          trackingStatus = 'ahead';
          aheadCount++;
        } else if (progressPercent < timeProgressPercent - 10) {
          trackingStatus = 'behind';
          behindCount++;
        } else {
          trackingStatus = 'on_track';
          onTrackCount++;
        }
      } else {
        noDeadlineCount++;
      }

      goalStatuses.push({
        goalId: g.id, name: g.name, currency: g.currency,
        status: g.status, progressPercent, trackingStatus,
      });
    }

    const completedCount = goals.filter((g: any) => g.status === 'completed').length;
    const healthScore = activeGoals.length > 0
      ? Math.round(((onTrackCount + aheadCount + noDeadlineCount) / activeGoals.length) * 100)
      : (completedCount > 0 ? 100 : 0);

    const overallProgress = totalTarget > BigInt(0)
      ? Math.min(100, Math.round(Number(totalSaved * BigInt(10000) / totalTarget)) / 100)
      : 0;

    return {
      totalGoals: goals.length,
      activeGoals: activeGoals.length,
      completedGoals: completedCount,
      healthScore,
      overallProgress,
      onTrackCount,
      behindCount,
      aheadCount,
      noDeadlineCount,
      totalSaved,
      totalTarget,
      goals: goalStatuses,
    };
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
