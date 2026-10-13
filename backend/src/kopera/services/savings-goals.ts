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

  async getContributionPatterns(userId: string) {
    const goals = await this.prisma.savingsGoal.findMany({ where: { userId } });
    const now = Date.now();

    let totalContributed = BigInt(0);
    let totalGoalsWithContributions = 0;
    const byCurrency: Record<string, { count: number; totalContributed: bigint }> = {};

    const goalPatterns: Array<{
      goalId: string; name: string; currency: string;
      contributed: string; dailyRate: number;
      velocity: number; status: string;
    }> = [];

    for (const g of goals) {
      if (g.currentAmount > BigInt(0)) {
        totalGoalsWithContributions++;
        totalContributed += g.currentAmount;
      }

      if (!byCurrency[g.currency]) byCurrency[g.currency] = { count: 0, totalContributed: BigInt(0) };
      byCurrency[g.currency].count++;
      byCurrency[g.currency].totalContributed += g.currentAmount;

      const ageDays = Math.max(1, (now - new Date(g.createdAt).getTime()) / (1000 * 60 * 60 * 24));
      const dailyRate = Number(g.currentAmount) / ageDays;
      const velocity = g.targetAmount > BigInt(0)
        ? Math.round(Number(g.currentAmount * BigInt(10000) / g.targetAmount) / ageDays) / 100
        : 0;

      goalPatterns.push({
        goalId: g.id,
        name: g.name,
        currency: g.currency,
        contributed: g.currentAmount.toString(),
        dailyRate: Math.round(dailyRate),
        velocity,
        status: g.status,
      });
    }

    goalPatterns.sort((a, b) => b.dailyRate - a.dailyRate);

    const avgContribution = goals.length > 0
      ? (totalContributed / BigInt(Math.max(1, goals.length))).toString()
      : '0';

    const currencyBreakdown = Object.entries(byCurrency).map(([currency, data]) => ({
      currency,
      goalCount: data.count,
      totalContributed: data.totalContributed.toString(),
    }));

    return {
      totalGoals: goals.length,
      goalsWithContributions: totalGoalsWithContributions,
      totalContributed: totalContributed.toString(),
      avgContribution,
      topPerformers: goalPatterns.filter(g => g.status === 'active').slice(0, 5),
      currencyBreakdown,
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

  async getMilestoneAnalysis(userId: string) {
    const goals = await this.prisma.savingsGoal.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });

    if (goals.length === 0) {
      return {
        totalGoals: 0,
        milestonesSummary: { reached25: 0, reached50: 0, reached75: 0, reached100: 0 },
        goals: [],
        avgMomentum: 0,
      };
    }

    const milestones = [25, 50, 75, 100];
    const reached = { reached25: 0, reached50: 0, reached75: 0, reached100: 0 };
    const goalDetails: any[] = [];

    for (const g of goals) {
      const target = Number(g.targetAmount);
      const current = Number(g.currentAmount);
      const progress = target > 0 ? Math.min(100, (current / target) * 100) : 0;

      const passedMilestones: number[] = [];
      for (const m of milestones) {
        if (progress >= m) {
          passedMilestones.push(m);
          if (m === 25) reached.reached25++;
          if (m === 50) reached.reached50++;
          if (m === 75) reached.reached75++;
          if (m === 100) reached.reached100++;
        }
      }

      const createdAt = new Date(g.createdAt).getTime();
      const now = Date.now();
      const daysElapsed = Math.max(1, (now - createdAt) / (24 * 60 * 60 * 1000));
      const dailyRate = current / daysElapsed;
      const remaining = Math.max(0, target - current);
      const estimatedDaysToComplete = dailyRate > 0 ? Math.round(remaining / dailyRate) : null;

      const momentum = progress > 0
        ? Math.round(Math.min(100, (progress / Math.max(1, daysElapsed)) * 30) * 100) / 100
        : 0;

      goalDetails.push({
        goalId: g.id,
        name: g.name,
        currency: g.currency,
        status: g.status,
        progress: Math.round(progress * 100) / 100,
        currentAmount: g.currentAmount.toString(),
        targetAmount: g.targetAmount.toString(),
        passedMilestones,
        nextMilestone: milestones.find(m => progress < m) ?? null,
        momentum,
        estimatedDaysToComplete,
      });
    }

    const avgMomentum = goalDetails.length > 0
      ? Math.round((goalDetails.reduce((s: number, g: any) => s + g.momentum, 0) / goalDetails.length) * 100) / 100
      : 0;

    return {
      totalGoals: goals.length,
      milestonesSummary: reached,
      goals: goalDetails,
      avgMomentum,
    };
  }
}
