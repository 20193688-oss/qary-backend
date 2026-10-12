import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { AgentOrchestrator } from '../../kopera/agents/orchestrator.js';
import '../../kopera/agents/definitions.js';

export async function registerAgentRoutes(app: FastifyInstance, prisma: PrismaClient) {
  const orchestrator = new AgentOrchestrator(prisma);

  app.get('/api/agents', async () => {
    return orchestrator.listAgents();
  });

  app.post('/api/agents/execute', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      agentNumber: z.number().int().min(1).max(51),
      input: z.record(z.unknown()),
    }).parse(req.body);

    const result = await orchestrator.execute(
      body.agentNumber,
      body.input,
      { userId: req.auth!.userId },
    );

    if (!result.success) {
      return reply.code(400).send({ error: result.error, durationMs: result.durationMs });
    }
    return reply.send(result);
  });

  app.post('/api/agents/chain', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      agents: z.array(z.number().int().min(1).max(51)).min(1).max(10),
      input: z.record(z.unknown()),
    }).parse(req.body);

    const results = await orchestrator.executeChain(
      body.agents,
      body.input,
      { userId: req.auth!.userId },
    );
    return reply.send({ results });
  });

  app.post('/api/agents/parallel', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const body = z.object({
      agents: z.array(z.number().int().min(1).max(51)).min(1).max(10),
      input: z.record(z.unknown()),
    }).parse(req.body);

    const results = await orchestrator.executeParallel(
      body.agents,
      body.input,
      { userId: req.auth!.userId },
    );
    return reply.send({ results });
  });

  // Bank detection convenience endpoint
  app.post('/api/detect-bank', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      accountNumber: z.string().min(1),
    }).parse(req.body);

    const result = await orchestrator.execute(
      7,
      { accountNumber: body.accountNumber },
      { userId: req.auth!.userId },
    );
    return result.data ?? { rail: 'UNKNOWN', valid: false };
  });

  // Business validation chain (agents 41 → 42 → 43 → 44)
  app.post('/api/validate-business', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      taxId: z.string().min(1),
      country: z.string().length(2).default('PE'),
    }).parse(req.body);

    const results = await orchestrator.executeChain(
      [41, 42, 43, 44],
      { taxId: body.taxId, country: body.country },
      { userId: req.auth!.userId },
    );

    return {
      steps: results.map((r, i) => ({
        agent: [41, 42, 43, 44][i],
        success: r.success,
        data: r.data,
        durationMs: r.durationMs,
      })),
      allPassed: results.every((r) => r.success),
    };
  });

  // Antifraud check (agents 2 + 3 + 26 in parallel)
  app.post('/api/security-check', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      amount: z.number().optional(),
      currency: z.string().length(3).optional(),
      country: z.string().length(2).optional(),
      content: z.string().optional(),
    }).parse(req.body);

    const results = await orchestrator.executeParallel(
      [2, 3, 26],
      body,
      { userId: req.auth!.userId },
    );

    return {
      cybersecurity: results[0]?.data,
      antifraud: results[1]?.data,
      dlp: results[2]?.data,
      overallSafe: results.every((r) => r.success && r.data?.['safe'] !== false && r.data?.['piiDetected'] !== true),
    };
  });

  // Agent execution history
  app.get('/api/agents/executions', { preHandler: [app.requireAuth] }, async (req) => {
    const query = req.query as { agentId?: string; status?: string; traceId?: string; limit?: string; offset?: string };
    const where: Record<string, unknown> = {};
    if (query.agentId) where.agentId = query.agentId;
    if (query.status) where.status = query.status;
    if (query.traceId) where.traceId = query.traceId;

    const executions = await prisma.agentExecution.findMany({
      where,
      take: Math.min(Number(query.limit ?? 20), 100),
      skip: Number(query.offset ?? 0),
      orderBy: { createdAt: 'desc' },
    });
    return executions.map(serializeExecution);
  });

  // Get single execution by ID
  app.get('/api/agents/executions/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const exec = await prisma.agentExecution.findUnique({ where: { id } });
    if (!exec) return reply.code(404).send({ error: 'execution_not_found' });
    return serializeExecution(exec);
  });

  // Agent admin: get single agent details
  app.get('/api/agents/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });
    return serializeAgent(agent);
  });

  // Agent admin: enable/disable and update config
  app.patch('/api/agents/:id', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      isActive: z.boolean().optional(),
      config: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });

    const updated = await prisma.agent.update({
      where: { id },
      data: {
        ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
        ...(body.config ? { config: body.config as object } : {}),
      },
    });

    return serializeAgent(updated);
  });

  // Agent admin: health check
  app.post('/api/agents/:id/health', { preHandler: [app.requireAuth] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = z.object({
      status: z.enum(['healthy', 'degraded', 'down']),
    }).parse(req.body);

    const agent = await prisma.agent.findUnique({ where: { id } });
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' });

    const updated = await prisma.agent.update({
      where: { id },
      data: {
        healthStatus: body.status,
        lastHealthCheck: new Date(),
      },
    });

    return serializeAgent(updated);
  });

  // Financial health check
  app.get('/api/financial-health', { preHandler: [app.requireAuth] }, async (req) => {
    const result = await orchestrator.execute(
      47,
      { userId: req.auth!.userId },
      { userId: req.auth!.userId },
    );
    return result.data ?? {};
  });

  // What-if simulator
  app.post('/api/simulate', { preHandler: [app.requireAuth] }, async (req) => {
    const body = z.object({
      scenario: z.string().min(1),
      params: z.record(z.unknown()).optional(),
    }).parse(req.body);

    const result = await orchestrator.execute(
      49,
      { scenario: body.scenario, ...body.params },
      { userId: req.auth!.userId },
    );
    return result.data ?? {};
  });
}

function serializeExecution(e: any) {
  return {
    id: e.id,
    agentId: e.agentId,
    status: e.status,
    durationMs: e.durationMs,
    errorMsg: e.errorMsg,
    triggeredBy: e.triggeredBy,
    traceId: e.traceId,
    parentExecId: e.parentExecId,
    createdAt: e.createdAt,
    completedAt: e.completedAt,
  };
}

function serializeAgent(a: any) {
  return {
    id: a.id,
    number: a.number,
    name: a.name,
    category: a.category,
    description: a.description,
    isActive: a.isActive,
    version: a.version,
    config: a.config,
    slaMs: a.slaMs,
    healthStatus: a.healthStatus,
    lastHealthCheck: a.lastHealthCheck,
  };
}
