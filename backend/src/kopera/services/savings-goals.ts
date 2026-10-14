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

  async getDeadlineRisk(userId: string) {
    const goals = await this.prisma.savingsGoal.findMany({
      where: { userId, status: 'active' },
    });

    const goalsWithDeadline = goals.filter((g: any) => g.deadline);
    if (goalsWithDeadline.length === 0) {
      return {
        totalActiveGoals: goals.length,
        goalsWithDeadline: 0,
        atRisk: [] as Array<{ goalId: string; name: string; riskLevel: string; daysRemaining: number; progressPercent: number; requiredDailyAmount: string }>,
        onTrack: 0,
        summary: 'no_deadlines' as const,
      };
    }

    const now = Date.now();
    const atRisk: Array<{
      goalId: string; name: string; riskLevel: string;
      daysRemaining: number; progressPercent: number; requiredDailyAmount: string;
    }> = [];
    let onTrackCount = 0;

    for (const g of goalsWithDeadline) {
      const deadline = new Date(g.deadline!).getTime();
      const daysRemaining = Math.max(0, Math.ceil((deadline - now) / (24 * 60 * 60 * 1000)));
      const current = Number(g.currentAmount);
      const target = Number(g.targetAmount);
      const progressPercent = target > 0 ? Math.round((current / target) * 10000) / 100 : 0;
      const remaining = Math.max(0, target - current);
      const requiredDaily = daysRemaining > 0 ? remaining / daysRemaining : remaining;

      const createdAt = new Date(g.createdAt).getTime();
      const totalDays = Math.max(1, (deadline - createdAt) / (24 * 60 * 60 * 1000));
      const elapsedDays = Math.max(1, (now - createdAt) / (24 * 60 * 60 * 1000));
      const expectedProgress = (elapsedDays / totalDays) * 100;
      const progressGap = expectedProgress - progressPercent;

      let riskLevel: string;
      if (daysRemaining === 0 && progressPercent < 100) riskLevel = 'overdue';
      else if (progressGap > 30) riskLevel = 'high';
      else if (progressGap > 10) riskLevel = 'moderate';
      else { riskLevel = 'low'; onTrackCount++; continue; }

      atRisk.push({
        goalId: g.id,
        name: g.name,
        riskLevel,
        daysRemaining,
        progressPercent,
        requiredDailyAmount: Math.round(requiredDaily).toString(),
      });
    }

    onTrackCount += goalsWithDeadline.length - atRisk.length - onTrackCount;
    const summary = atRisk.length === 0 ? 'all_on_track' as const
      : atRisk.some(r => r.riskLevel === 'overdue' || r.riskLevel === 'high') ? 'needs_attention' as const
      : 'minor_risks' as const;

    return {
      totalActiveGoals: goals.length,
      goalsWithDeadline: goalsWithDeadline.length,
      atRisk,
      onTrack: onTrackCount,
      summary,
    };
  }

  async getSavingsConsistencyScore(userId: string) {
    const goals = await this.prisma.savingsGoal.findMany({
      where: { userId, status: 'active' },
    });

    if (goals.length === 0) {
      return {
        totalGoals: 0,
        overallScore: 0,
        consistencyLevel: 'none' as const,
        monthsWithContributions: 0,
        totalMonthsTracked: 0,
        goals: [],
      };
    }

    const goalDetails = [];
    let totalMonths = 0;
    let activeMonths = 0;

    for (const goal of goals) {
      const contributions = await this.prisma.savingsContribution.findMany({
        where: { savingsGoalId: goal.id },
        orderBy: { createdAt: 'asc' },
      });

      const monthSet = new Set<string>();
      const amounts: number[] = [];
      for (const c of contributions) {
        const d = new Date(c.createdAt);
        monthSet.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        amounts.push(Number(c.amount));
      }

      const firstDate = contributions.length > 0
        ? new Date(contributions[0]!.createdAt)
        : new Date(goal.createdAt);
      const monthsElapsed = Math.max(1, Math.ceil(
        (Date.now() - firstDate.getTime()) / (30 * 86400000),
      ));

      const contributionMonths = monthSet.size;
      const regularity = Math.round((contributionMonths / monthsElapsed) * 100);

      const avg = amounts.length > 0
        ? amounts.reduce((s, v) => s + v, 0) / amounts.length
        : 0;
      const variance = amounts.length > 1
        ? amounts.reduce((s, v) => s + (v - avg) ** 2, 0) / amounts.length
        : 0;
      const cv = avg > 0 ? Math.round((Math.sqrt(variance) / avg) * 100) : 0;

      totalMonths += monthsElapsed;
      activeMonths += contributionMonths;

      goalDetails.push({
        goalId: goal.id,
        goalName: goal.name,
        totalContributions: contributions.length,
        contributionMonths,
        monthsTracked: monthsElapsed,
        regularity,
        amountConsistency: Math.max(0, 100 - cv),
      });
    }

    const overallScore = totalMonths > 0
      ? Math.round((activeMonths / totalMonths) * 100)
      : 0;

    const consistencyLevel = overallScore >= 80 ? 'excellent' as const
      : overallScore >= 60 ? 'good' as const
      : overallScore >= 40 ? 'fair' as const
      : overallScore > 0 ? 'poor' as const
      : 'none' as const;

    return {
      totalGoals: goals.length,
      overallScore,
      consistencyLevel,
      monthsWithContributions: activeMonths,
      totalMonthsTracked: totalMonths,
      goals: goalDetails,
    };
  }
}
