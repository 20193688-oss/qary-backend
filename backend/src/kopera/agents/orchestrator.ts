import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { getAgent, getAllAgents, type AgentContext, type AgentResult } from './registry.js';

export class AgentOrchestrator {
  constructor(private prisma: PrismaClient) {}

  async execute(
    agentNumber: number,
    input: Record<string, unknown>,
    opts?: { userId?: string; traceId?: string; parentExecId?: string },
  ): Promise<AgentResult> {
    const def = getAgent(agentNumber);
    if (!def) return { success: false, error: `Agent #${agentNumber} not registered` };

    const traceId = opts?.traceId ?? randomUUID();
    const start = Date.now();

    const exec = await this.prisma.agentExecution.create({
      data: {
        agentId: `agent-${def.number}`,
        input: input as object,
        status: 'running',
        triggeredBy: opts?.userId ?? 'system',
        traceId,
        parentExecId: opts?.parentExecId,
      },
    }).catch(() => null);

    const ctx: AgentContext = {
      input,
      userId: opts?.userId,
      traceId,
      prisma: this.prisma,
      parentExecId: opts?.parentExecId,
    };

    try {
      const timeoutMs = def.slaMs * 2;
      const result = await Promise.race([
        def.handler(ctx),
        new Promise<AgentResult>((_, reject) =>
          setTimeout(() => reject(new Error('agent_timeout')), timeoutMs),
        ),
      ]);

      const durationMs = Date.now() - start;

      if (exec) {
        await this.prisma.agentExecution.update({
          where: { id: exec.id },
          data: {
            status: result.success ? 'completed' : 'failed',
            output: (result.data ?? {}) as object,
            durationMs,
            errorMsg: result.error,
            completedAt: new Date(),
          },
        }).catch(() => {});
      }

      return { ...result, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : 'unknown_error';

      if (exec) {
        await this.prisma.agentExecution.update({
          where: { id: exec.id },
          data: { status: 'failed', errorMsg, durationMs, completedAt: new Date() },
        }).catch(() => {});
      }

      return { success: false, error: errorMsg, durationMs };
    }
  }

  async executeChain(
    agentNumbers: number[],
    input: Record<string, unknown>,
    opts?: { userId?: string; traceId?: string },
  ): Promise<AgentResult[]> {
    const traceId = opts?.traceId ?? randomUUID();
    const results: AgentResult[] = [];
    let currentInput = { ...input };

    for (const num of agentNumbers) {
      const result = await this.execute(num, currentInput, { ...opts, traceId });
      results.push(result);
      if (!result.success) break;
      currentInput = { ...currentInput, ...result.data };
    }
    return results;
  }

  async executeParallel(
    agentNumbers: number[],
    input: Record<string, unknown>,
    opts?: { userId?: string; traceId?: string },
  ): Promise<AgentResult[]> {
    const traceId = opts?.traceId ?? randomUUID();
    return Promise.all(
      agentNumbers.map((num) => this.execute(num, input, { ...opts, traceId })),
    );
  }

  listAgents() {
    return getAllAgents().map((a) => ({
      number: a.number,
      name: a.name,
      category: a.category,
      description: a.description,
      slaMs: a.slaMs,
    }));
  }
}
