import { describe, it, expect, beforeEach } from 'vitest';
import { buildApp } from '../src/app.js';
import { createInMemoryPrisma, createInMemoryRedis, createMockStripe } from './_mocks.js';

async function bootstrap() {
  const prisma = createInMemoryPrisma();
  const redis = createInMemoryRedis();
  const stripe = createMockStripe();
  const app = await buildApp({ prisma, redis, stripe: stripe as never });
  await app.ready();

  const reg = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email: 'agent-admin@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'agent-admin@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  // Create a test agent in the DB
  const tables = (prisma as any).__tables;
  tables.agent.push({
    id: 'agent-1',
    number: 1,
    name: 'Test Agent',
    category: 'SECURITY',
    description: 'Test agent for admin ops',
    isActive: true,
    version: '1.0.0',
    config: null,
    kpis: null,
    slaMs: 5000,
    lastHealthCheck: null,
    healthStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  // Create a test execution
  tables.agentExecution.push({
    id: 'exec-1',
    agentId: 'agent-1',
    input: { test: true },
    output: { result: 'ok' },
    status: 'completed',
    durationMs: 150,
    errorMsg: null,
    triggeredBy: user.id,
    traceId: 'trace-abc',
    parentExecId: null,
    createdAt: new Date(),
    completedAt: new Date(),
    updatedAt: new Date(),
  });
  tables.agentExecution.push({
    id: 'exec-2',
    agentId: 'agent-1',
    input: { test: true },
    output: null,
    status: 'failed',
    durationMs: 50,
    errorMsg: 'timeout',
    triggeredBy: user.id,
    traceId: 'trace-abc',
    parentExecId: 'exec-1',
    createdAt: new Date(),
    completedAt: new Date(),
    updatedAt: new Date(),
  });

  return { app, prisma, accessToken, user };
}

describe('kopera agent admin and execution history', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('lists execution history', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/executions',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(2);
    expect(body[0].id).toBeTruthy();
    expect(body[0].status).toBeTruthy();
  });

  it('filters executions by status', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/executions?status=failed',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(1);
    expect(body[0].status).toBe('failed');
    expect(body[0].errorMsg).toBe('timeout');
  });

  it('filters executions by traceId', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/executions?traceId=trace-abc',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('filters executions by agentId', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/executions?agentId=agent-1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('gets single execution by ID', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/executions/exec-1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe('exec-1');
    expect(res.json().status).toBe('completed');
    expect(res.json().durationMs).toBe(150);
  });

  it('returns 404 for non-existent execution', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/executions/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('execution_not_found');
  });

  it('gets agent details', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/agent-1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('Test Agent');
    expect(res.json().isActive).toBe(true);
    expect(res.json().slaMs).toBe(5000);
  });

  it('returns 404 for non-existent agent', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/agents/nonexistent',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('agent_not_found');
  });

  it('disables an agent', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/agents/agent-1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('updates agent config', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/agents/agent-1',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { config: { threshold: 0.8, maxRetries: 3 } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().config).toEqual({ threshold: 0.8, maxRetries: 3 });
  });

  it('updates agent health status', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/agents/agent-1/health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { status: 'healthy' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().healthStatus).toBe('healthy');
    expect(res.json().lastHealthCheck).toBeTruthy();
  });

  it('sets agent health to degraded', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/agents/agent-1/health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { status: 'degraded' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().healthStatus).toBe('degraded');
  });

  it('returns 404 for health check on non-existent agent', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/agents/nonexistent/health',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { status: 'healthy' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('requires auth for executions', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/agents/executions' });
    expect(res.statusCode).toBe(401);
  });

  it('requires auth for agent patch', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH', url: '/api/agents/agent-1',
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(401);
  });
});
