import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { SavingsGoalService } from '../../kopera/services/savings-goals.js';
import { audit } from '../../lib/audit.js';

function serialize(g: any) {
  return {
    id: g.id,
    name: g.name,
    targetAmount: g.targetAmount.toString(),
    currentAmount: g.currentAmount.toString(),
    currency: g.currency,
    status: g.status,
    progress: g.targetAmount > 0
      ? Math.min(100, Math.round(Number(g.currentAmount * BigInt(10000) / g.targetAmount)) / 100)
      : 0,
    deadline: g.deadline,
    completedAt: g.completedAt,
    createdAt: g.createdAt,
  };
}

export async function registerSavingsGoalRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const svc = new SavingsGoalService(prisma);

  app.post('/api/savings-goals', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      name: z.string().min(1).max(200),
      targetAmount: z.number().positive(),
      currency: z.string().length(3),
      deadline: z.string().datetime().optional(),
    }).parse(req.body);

    const targetCents = BigInt(Math.round(body.targetAmount * 100));
    const goal = await svc.create({
      userId: req.auth!.userId,
      name: body.name,
      targetAmount: targetCents,
      currency: body.currency,
      deadline: body.deadline ? new Date(body.deadline) : undefined,
    });
    await audit(prisma, {
      userId: req.auth!.userId, actor: 'user', eventType: 'savings_goal.created',
      payload: { name: body.name, targetAmount: body.targetAmount, currency: body.currency },
      requestId: String(req.id), ip: req.ip,
    });
    return reply.code(201).send(serialize(goal));
  });

  app.get('/api/savings-goals', { preHandler: [app.requireAuth] }, async (req) => {
    const list = await svc.listByUser(req.auth!.userId);
    return list.map(serialize);
  });

  app.get('/api/savings-goals/summary', { preHandler: [app.requireAuth] }, async (req) => {
    const summary = await svc.getSummary(req.auth!.userId);
    return {
      totalGoals: summary.totalGoals,
      totalTarget: summary.totalTarget.toString(),
      totalSaved: summary.totalSaved.toString(),
      overallProgress: summary.overallProgress,
      byStatus: summary.byStatus,
      nearestDeadline: summary.nearestDeadline,
    };
  });

  app.get('/api/savings-goals/health', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getSavingsHealth(req.auth!.userId);
    return {
      ...result,
      totalSaved: result.totalSaved.toString(),
      totalTarget: result.totalTarget.toString(),
    };
  });

  app.get('/api/savings-goals/contribution-patterns', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getContributionPatterns(req.auth!.userId);
  });

  app.get('/api/savings-goals/completion-forecast', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await svc.getCompletionForecast(req.auth!.userId);
    return {
      totalActiveGoals: result.totalActiveGoals,
      atRiskCount: result.atRiskCount,
      forecasts: result.forecasts.map((f: any) => ({
        ...f,
        currentAmount: f.currentAmount.toString(),
        targetAmount: f.targetAmount.toString(),
      })),
    };
  });

  app.get('/api/savings-goals/milestone-analysis', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getMilestoneAnalysis(req.auth!.userId);
  });

  app.get('/api/savings-goals/deadline-risk', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getDeadlineRisk(req.auth!.userId);
  });

  app.get('/api/savings-goals/consistency-score', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSavingsConsistencyScore(req.auth!.userId);
  });

  app.get('/api/savings-goals/goal-correlation', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSavingsGoalCorrelation(req.auth!.userId);
  });

  app.get('/api/savings-goals/velocity-trend', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSavingsVelocityTrend(req.auth!.userId);
  });

  app.get('/api/savings-goals/prioritization', { preHandler: [app.requireAuth] }, async (req) => {
    return svc.getSavingsGoalPrioritization(req.auth!.userId);
  });

  app.get('/api/savings-goals/:id/progress', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const progress = await svc.getGoalProgress(id, req.auth!.userId);
      return {
        ...progress,
        currentAmount: progress.currentAmount.toString(),
        targetAmount: progress.targetAmount.toString(),
        remaining: progress.remaining.toString(),
      };
    } catch (err: any) {
      if (err.message === 'goal_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      throw err;
    }
  });

  app.get('/api/savings-goals/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const goal = await svc.getById(id);
    if (!goal || goal.userId !== req.auth!.userId) return reply.code(404).send({ error: 'not_found' });
    return serialize(goal);
  });

  app.patch('/api/savings-goals/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      name: z.string().min(1).max(200).optional(),
      targetAmount: z.number().positive().optional(),
      deadline: z.string().datetime().nullable().optional(),
    }).parse(req.body);

    try {
      const goal = await svc.update(id, req.auth!.userId, {
        name: body.name,
        targetAmount: body.targetAmount !== undefined ? BigInt(Math.round(body.targetAmount * 100)) : undefined,
        deadline: body.deadline === null ? null : body.deadline ? new Date(body.deadline) : undefined,
      });
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'savings_goal.updated',
        payload: { goalId: id, ...body },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(goal);
    } catch (err: any) {
      if (err.message === 'goal_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'goal_archived') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/savings-goals/:id/contribute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ amount: z.number().positive() }).parse(req.body);
    const amountCents = BigInt(Math.round(body.amount * 100));

    try {
      const goal = await svc.contribute(id, req.auth!.userId, amountCents);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'savings_goal.contribution',
        payload: { goalId: id, amount: body.amount },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(goal);
    } catch (err: any) {
      if (err.message === 'goal_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'goal_not_active') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/savings-goals/:id/withdraw', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ amount: z.number().positive() }).parse(req.body);
    const amountCents = BigInt(Math.round(body.amount * 100));

    try {
      const goal = await svc.withdraw(id, req.auth!.userId, amountCents);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'savings_goal.withdrawal',
        payload: { goalId: id, amount: body.amount },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(goal);
    } catch (err: any) {
      if (err.message === 'goal_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'insufficient_savings') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/savings-goals/:id/fund', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({ amount: z.number().positive() }).parse(req.body);
    const amountCents = BigInt(Math.round(body.amount * 100));

    try {
      const goal = await svc.getById(id);
      if (!goal) return reply.code(404).send({ error: 'goal_not_found' });
      if (goal.userId !== req.auth!.userId) return reply.code(403).send({ error: 'forbidden' });
      if (goal.status !== 'active') return reply.code(400).send({ error: 'goal_not_active' });

      const wallet = await prisma.wallet.findFirst({
        where: { userId: req.auth!.userId, currency: goal.currency, status: 'ACTIVE' },
      } as any);
      if (!wallet) return reply.code(400).send({ error: 'wallet_not_found' });
      if (wallet.balance < amountCents) return reply.code(400).send({ error: 'insufficient_funds' });

      await prisma.wallet.update({
        where: { id: wallet.id },
        data: { balance: wallet.balance - amountCents },
      });

      const updated = await svc.contribute(id, req.auth!.userId, amountCents);

      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'savings_goal.funded',
        payload: { goalId: id, amount: body.amount, walletId: wallet.id },
        requestId: String(req.id), ip: req.ip,
      });

      return serialize(updated);
    } catch (err: any) {
      if (err.message === 'goal_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'goal_not_active') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.post('/api/savings-goals/:id/archive', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      const goal = await svc.archive(id, req.auth!.userId);
      await audit(prisma, {
        userId: req.auth!.userId, actor: 'user', eventType: 'savings_goal.archived',
        payload: { goalId: id },
        requestId: String(req.id), ip: req.ip,
      });
      return serialize(goal);
    } catch (err: any) {
      if (err.message === 'goal_not_found') return reply.code(404).send({ error: err.message });
      if (err.message === 'forbidden') return reply.code(403).send({ error: err.message });
      if (err.message === 'already_archived') return reply.code(400).send({ error: err.message });
      throw err;
    }
  });
}
