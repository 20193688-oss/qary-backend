import type { PrismaClient } from '@prisma/client';

export interface AgentDefinition {
  number: number;
  name: string;
  category: string;
  description: string;
  slaMs: number;
  handler: (ctx: AgentContext) => Promise<AgentResult>;
}

export interface AgentContext {
  input: Record<string, unknown>;
  userId?: string;
  traceId: string;
  prisma: PrismaClient;
  parentExecId?: string;
}

export interface AgentResult {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
}

const agents = new Map<number, AgentDefinition>();

export function registerAgent(def: AgentDefinition) {
  agents.set(def.number, def);
}

export function getAgent(number: number): AgentDefinition | undefined {
  return agents.get(number);
}

export function getAllAgents(): AgentDefinition[] {
  return Array.from(agents.values()).sort((a, b) => a.number - b.number);
}

export function getAgentByName(name: string): AgentDefinition | undefined {
  for (const a of agents.values()) {
    if (a.name === name) return a;
  }
  return undefined;
}
