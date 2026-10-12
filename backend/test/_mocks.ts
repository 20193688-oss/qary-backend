import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

type Row = Record<string, unknown> & { id?: string };

const MODEL_DEFAULTS: Record<string, Record<string, unknown>> = {
  wallet: {
    balance: BigInt(0),
    availableBalance: BigInt(0),
    holdBalance: BigInt(0),
    status: 'ACTIVE',
    isDefault: false,
  },
  koperaPoints: {
    balance: 0,
    tier: 'BRONZE',
    lifetimeEarned: 0,
    lifetimeSpent: 0,
  },
  transaction: {
    feeAmount: BigInt(0),
    fxRate: null,
  },
  loan: {
    status: 'APPLICATION',
    interestRate: 0.15,
    outstandingBalance: BigInt(0),
    missedPayments: 0,
    rejectedReason: null,
    rejectedBy: null,
  },
  loanRepayment: {
    paidAmount: BigInt(0),
    paidAt: null,
    status: 'PENDING',
  },
  notification: {
    channel: 'in_app',
    readAt: null,
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    failReason: null,
    externalId: null,
    metadata: null,
    subject: null,
  },
  dispute: {
    status: 'OPENED',
    evidenceSubmitted: null,
    evidenceDeadline: null,
    resolvedAt: null,
    outcome: null,
  },
  subscription: {
    status: 'active',
    intervalCount: 1,
    retryCount: 0,
    maxRetries: 3,
    cancelledAt: null,
    merchantId: null,
    metadata: null,
  },
  beneficiary: {
    currency: null,
  },
  scheduledTransfer: {
    status: 'active',
    lastExecutionDate: null,
    executionCount: 0,
  },
  savingsGoal: {
    currentAmount: BigInt(0),
    status: 'active',
    deadline: null,
    completedAt: null,
  },
  paymentLink: {
    description: null,
    status: 'active',
    singleUse: true,
    timesUsed: 0,
    lastUsedAt: null,
    expiresAt: null,
  },
  transactionLimit: {
    currentUsage: BigInt(0),
  },
  referral: {
    status: 'active',
    signupCount: 0,
    rewardedCount: 0,
    totalPointsEarned: 0,
  },
  referralSignup: {
    status: 'signed_up',
    rewardedAt: null,
  },
  tokenizedCard: {
    holderName: null,
    isDefault: false,
    frozen: false,
    country: null,
    bankName: null,
    fingerprint: null,
  },
  bankAccount: {
    bankCode: null,
    accountType: null,
    isVerified: false,
    isDefault: false,
    metadata: null,
  },
  antExpense: {
    isActive: true,
    suggestion: null,
    savingsIfCut: null,
  },
  userSession: {
    deviceName: null,
    userAgent: null,
    revokedAt: null,
  },
  event: {
    userId: null,
    requestId: null,
    ip: null,
    userAgent: null,
    agentId: null,
    severity: null,
  },
  ledgerEntry: {
    description: null,
  },
  gatewayPayment: {
    merchantId: null,
    status: 'CREATED',
    cardNetwork: null,
    cardLast4: null,
    cardTokenId: null,
    threeDSecureStatus: null,
    processorRef: null,
    processorResponse: null,
    gatewayFee: BigInt(0),
    settlementAmount: null,
    settlementCurrency: null,
    settledAt: null,
    antifraudScore: null,
    antifraudDecision: null,
    antifraudDetails: null,
    idempotencyKey: null,
    webhookDelivered: false,
    errorCode: null,
    errorMessage: null,
  },
  agent: {
    isActive: true,
    version: '1.0.0',
    config: null,
    kpis: null,
    slaMs: null,
    lastHealthCheck: null,
    healthStatus: null,
  },
  agentExecution: {
    output: null,
    status: 'running',
    durationMs: null,
    errorMsg: null,
    triggeredBy: null,
    traceId: null,
    parentExecId: null,
    completedAt: null,
  },
  kycProfile: {
    status: 'PENDING',
    documentType: null,
    documentNumber: null,
    documentCountry: null,
    firstName: null,
    lastName: null,
    dateOfBirth: null,
    nationality: null,
    address: null,
    livenessScore: null,
    livenessImageUrl: null,
    documentFrontUrl: null,
    documentBackUrl: null,
    selfieUrl: null,
    verifiedAt: null,
    rejectedReason: null,
    pepCheck: false,
    sanctionsCheck: false,
    riskScore: null,
    reviewedBy: null,
  },
  businessProfile: {
    legalName: null,
    tradeName: null,
    incorporationDate: null,
    economicActivity: null,
    ciiu: null,
    fiscalAddress: null,
    legalRepName: null,
    legalRepDocType: null,
    legalRepDocNumber: null,
    status: 'PENDING',
    habidomStatus: null,
    coactivaDebt: false,
    riskScore: null,
    reputationScore: null,
    complianceScore: null,
    lastScreeningAt: null,
    verifiedAt: null,
    rejectedReason: null,
    screeningReport: null,
  },
};

const OPERATORS = new Set(['gt', 'gte', 'lt', 'lte', 'not', 'in', 'contains', 'equals']);

function isOperatorObject(obj: Record<string, unknown>): boolean {
  return Object.keys(obj).every(k => OPERATORS.has(k));
}

function applyOperator(rv: unknown, op: string, val: unknown): boolean {
  if (op === 'not') return rv !== val;
  if (op === 'in') return Array.isArray(val) && val.includes(rv);
  if (op === 'contains') return typeof rv === 'string' && typeof val === 'string' && rv.includes(val);
  if (op === 'equals') return rv === val;
  const a = rv instanceof Date ? rv.getTime() : (typeof rv === 'bigint' ? Number(rv) : Number(rv));
  const b = val instanceof Date ? val.getTime() : (typeof val === 'bigint' ? Number(val) : Number(val));
  if (op === 'gt') return a > b;
  if (op === 'gte') return a >= b;
  if (op === 'lt') return a < b;
  if (op === 'lte') return a <= b;
  return true;
}

function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      const compound = v as Record<string, unknown>;
      if (isOperatorObject(compound)) {
        for (const [op, val] of Object.entries(compound)) {
          if (!applyOperator(row[k], op, val)) return false;
        }
        continue;
      }
      for (const [ck, cv] of Object.entries(compound)) {
        if (row[ck] !== cv) return false;
      }
      continue;
    }
    const rv = row[k];
    if (v === null) { if (rv != null) return false; }
    else if (rv !== v) return false;
  }
  return true;
}

export function createInMemoryPrisma(): PrismaClient {
  const tables: Record<string, Row[]> = {
    user: [],
    refreshToken: [],
    event: [],
    transaction: [],
    gatewayPayment: [],
    wallet: [],
    ledgerEntry: [],
    fxRate: [],
    invoice: [],
    loan: [],
    loanRepayment: [],
    koperaPoints: [],
    pointsHistory: [],
    kycProfile: [],
    businessProfile: [],
    tokenizedCard: [],
    bankAccount: [],
    dispute: [],
    agent: [],
    agentExecution: [],
    notification: [],
    subscription: [],
    beneficiary: [],
    scheduledTransfer: [],
    savingsGoal: [],
    paymentLink: [],
    transactionLimit: [],
    referral: [],
    referralSignup: [],
    antExpense: [],
    userSession: [],
    // legacy
    order: [],
    payment: [],
    incident: [],
    mediaAsset: [],
    receipt: [],
    driver: [],
  };

  const model = (name: string) => {
    const arr = () => {
      if (!tables[name]) tables[name] = [];
      return tables[name]!;
    };
    return {
      async findUnique({ where, include }: { where: Record<string, unknown>; include?: Record<string, boolean> }) {
        const r = arr().find((x) => matches(x, where));
        if (!r) return null;
        if (include) {
          const result = { ...r };
          for (const rel of Object.keys(include)) {
            if (include[rel]) {
              const relTable = tables[rel];
              if (relTable) {
                const fk = `${rel}Id`;
                if (r[fk]) {
                  (result as Record<string, unknown>)[rel] = relTable.find((x) => x.id === r[fk]) ?? null;
                } else {
                  const parentFk = `${name}Id`;
                  (result as Record<string, unknown>)[rel] = relTable.find((x) => x[parentFk] === r.id) ?? null;
                }
              }
            }
          }
          return result;
        }
        return r;
      },
      async findFirst({ where }: { where?: Record<string, unknown> } = {}) {
        if (!where) return arr()[0] ?? null;
        return arr().find((r) => {
          for (const [k, v] of Object.entries(where)) {
            if (v && typeof v === 'object' && 'path' in v && 'equals' in (v as Record<string, unknown>)) {
              const path = (v as { path: string[] }).path;
              const expected = (v as { equals: unknown }).equals;
              let cur: unknown = r[k];
              for (const seg of path) {
                if (!cur || typeof cur !== 'object') { cur = undefined; break; }
                cur = (cur as Record<string, unknown>)[seg];
              }
              if (cur !== expected) return false;
            } else if (r[k] !== v) {
              return false;
            }
          }
          return true;
        }) ?? null;
      },
      async findMany({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: unknown } = {}) {
        if (!where) return [...arr()];
        return arr().filter((r) => matches(r, where));
      },
      async create({ data }: { data: Row }) {
        const defaults = MODEL_DEFAULTS[name] ?? {};
        const row = { id: data.id ?? randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...data };
        arr().push(row);
        return row;
      },
      async createMany({ data }: { data: Row[] }) {
        const rows = data.map((d) => {
          const defaults = MODEL_DEFAULTS[name] ?? {};
          const row = { id: d.id ?? randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...defaults, ...d };
          arr().push(row);
          return row;
        });
        return { count: rows.length };
      },
      async update({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const r = arr().find((x) => matches(x, where));
        if (!r) throw new Error(`update: ${name} not found`);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      },
      async updateMany({ where, data }: { where: Record<string, unknown>; data: Row }) {
        const rows = arr().filter((r) => matches(r, where));
        rows.forEach((r) => Object.assign(r, data, { updatedAt: new Date() }));
        return { count: rows.length };
      },
      async upsert({
        where, update, create,
      }: { where: Record<string, unknown>; update: Row; create: Row }) {
        const existing = arr().find((r) => matches(r, where));
        if (existing) {
          Object.assign(existing, update, { updatedAt: new Date() });
          return existing;
        }
        const row = { id: create.id ?? randomUUID(), createdAt: new Date(), updatedAt: new Date(), ...create };
        arr().push(row);
        return row;
      },
      async delete({ where }: { where: Record<string, unknown> }) {
        const idx = arr().findIndex((r) => matches(r, where));
        if (idx < 0) throw new Error(`delete: ${name} not found`);
        const [removed] = arr().splice(idx, 1);
        return removed;
      },
      async deleteMany({ where }: { where?: Record<string, unknown> } = {}) {
        const toRemove = where ? arr().filter((r) => matches(r, where)) : [...arr()];
        toRemove.forEach((r) => {
          const idx = arr().indexOf(r);
          if (idx >= 0) arr().splice(idx, 1);
        });
        return { count: toRemove.length };
      },
      async count({ where }: { where?: Record<string, unknown> } = {}) {
        if (!where) return arr().length;
        return arr().filter((r) => matches(r, where)).length;
      },
    };
  };

  const txHandler = async (fn: (tx: unknown) => Promise<unknown>) => {
    return fn(prisma);
  };

  const prisma = {
    user: model('user'),
    refreshToken: model('refreshToken'),
    event: model('event'),
    transaction: {
      ...model('transaction'),
      async findUnique({ where, include }: { where: Record<string, unknown>; include?: { gatewayPayment?: boolean } }) {
        const r = tables.transaction!.find((x) => matches(x, where));
        if (!r) return null;
        if (include?.gatewayPayment) {
          const gp = tables.gatewayPayment!.find((g) => g.transactionId === r.id);
          return { ...r, gatewayPayment: gp ?? null };
        }
        return r;
      },
    },
    gatewayPayment: {
      ...model('gatewayPayment'),
      async findUnique({ where, include }: { where: Record<string, unknown>; include?: { transaction?: boolean } }) {
        const r = tables.gatewayPayment!.find((x) => matches(x, where));
        if (!r) return null;
        if (include?.transaction) {
          const tx = tables.transaction!.find((t) => t.id === r.transactionId);
          return { ...r, transaction: tx ?? null };
        }
        return r;
      },
    },
    wallet: model('wallet'),
    ledgerEntry: model('ledgerEntry'),
    fxRate: model('fxRate'),
    invoice: model('invoice'),
    loan: {
      ...model('loan'),
      async findUnique({ where, include }: { where: Record<string, unknown>; include?: { repayments?: unknown } }) {
        const r = tables.loan!.find((x) => matches(x, where));
        if (!r) return null;
        if (include?.repayments) {
          const reps = tables.loanRepayment!.filter((x) => x.loanId === r.id);
          return { ...r, repayments: reps };
        }
        return r;
      },
    },
    loanRepayment: model('loanRepayment'),
    koperaPoints: model('koperaPoints'),
    pointsHistory: model('pointsHistory'),
    kycProfile: model('kycProfile'),
    businessProfile: model('businessProfile'),
    tokenizedCard: model('tokenizedCard'),
    bankAccount: model('bankAccount'),
    dispute: model('dispute'),
    agent: model('agent'),
    agentExecution: model('agentExecution'),
    notification: model('notification'),
    subscription: model('subscription'),
    beneficiary: model('beneficiary'),
    scheduledTransfer: model('scheduledTransfer'),
    savingsGoal: model('savingsGoal'),
    paymentLink: model('paymentLink'),
    transactionLimit: model('transactionLimit'),
    referral: model('referral'),
    referralSignup: model('referralSignup'),
    antExpense: model('antExpense'),
    userSession: model('userSession'),
    // legacy
    order: model('order'),
    payment: model('payment'),
    incident: model('incident'),
    mediaAsset: model('mediaAsset'),
    receipt: model('receipt'),
    driver: model('driver'),
    $transaction: txHandler,
  } as unknown as PrismaClient;

  (prisma as unknown as { __tables: typeof tables }).__tables = tables;
  return prisma;
}

export function createInMemoryRedis() {
  const store = new Map<string, { value: string; expiresAt?: number }>();
  const isAlive = (key: string) => {
    const e = store.get(key);
    if (!e) return false;
    if (e.expiresAt && e.expiresAt < Date.now()) { store.delete(key); return false; }
    return true;
  };
  return {
    async get(key: string) { return isAlive(key) ? store.get(key)!.value : null; },
    async set(key: string, value: string, _ex?: string, ttl?: number) {
      store.set(key, { value, expiresAt: ttl ? Date.now() + ttl * 1000 : undefined });
      return 'OK';
    },
    async del(key: string) { return store.delete(key) ? 1 : 0; },
    async incr(key: string) {
      const cur = isAlive(key) ? Number(store.get(key)!.value) : 0;
      const next = cur + 1;
      const e = store.get(key);
      store.set(key, { value: String(next), expiresAt: e?.expiresAt });
      return next;
    },
    async expire(key: string, seconds: number) {
      const e = store.get(key);
      if (!e) return 0;
      e.expiresAt = Date.now() + seconds * 1000;
      return 1;
    },
    async quit() { /* no-op */ return 'OK'; },
  } as unknown as import('ioredis').default;
}

export function createMockStripe() {
  type Intent = {
    id: string; amount: number; currency: string;
    status: string; client_secret: string;
    metadata: Record<string, string>;
  };
  const intents: Map<string, Intent> = new Map();
  let signatureValid = true;

  const stripe = {
    paymentIntents: {
      async create(args: { amount: number; currency: string; metadata?: Record<string, string> }) {
        const id = `pi_test_${Math.random().toString(36).slice(2, 10)}`;
        const intent: Intent = {
          id, amount: args.amount, currency: args.currency,
          status: 'requires_capture', client_secret: `${id}_secret_${randomUUID()}`,
          metadata: args.metadata ?? {},
        };
        intents.set(id, intent);
        return intent;
      },
      async capture(id: string) {
        const i = intents.get(id);
        if (!i) throw new Error('not_found');
        i.status = 'succeeded';
        return i;
      },
      async retrieve(id: string) { return intents.get(id) ?? null; },
    },
    webhooks: {
      constructEvent(body: Buffer, _sig: string, _secret: string) {
        if (!signatureValid) throw new Error('invalid signature');
        const text = body.toString('utf8');
        return JSON.parse(text);
      },
    },
    refunds: { async create() { return { id: 're_test_' + randomUUID(), status: 'succeeded' }; } },
    __intents: intents,
    __setSignatureValid(v: boolean) { signatureValid = v; },
  } as const;

  return stripe;
}
