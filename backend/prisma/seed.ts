import { PrismaClient } from '@prisma/client';
import { hashSync } from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding Kopera fintech database...');

  const demoUser = await prisma.user.upsert({
    where: { email: 'demo@kopera.io' },
    update: {},
    create: {
      email: 'demo@kopera.io',
      name: 'Demo User',
      role: 'USER',
      accountType: 'PERSONAL',
      passwordHash: hashSync('KoperaDemo2024!', 10),
      emailVerified: true,
      country: 'PE',
      preferredCurrency: 'PEN',
      locale: 'es-PE',
    },
  });

  const bizUser = await prisma.user.upsert({
    where: { email: 'empresa@kopera.io' },
    update: {},
    create: {
      email: 'empresa@kopera.io',
      name: 'Kopera Business',
      role: 'BUSINESS',
      accountType: 'BUSINESS',
      passwordHash: hashSync('KoperaBiz2024!', 10),
      emailVerified: true,
      country: 'PE',
      preferredCurrency: 'PEN',
      locale: 'es-PE',
    },
  });

  const adminUser = await prisma.user.upsert({
    where: { email: 'admin@kopera.io' },
    update: {},
    create: {
      email: 'admin@kopera.io',
      name: 'Admin Kopera',
      role: 'ADMIN',
      passwordHash: hashSync('KoperaAdmin2024!', 10),
      emailVerified: true,
      country: 'PE',
      preferredCurrency: 'USD',
    },
  });

  for (const currency of ['PEN', 'USD', 'EUR']) {
    await prisma.wallet.upsert({
      where: { userId_currency: { userId: demoUser.id, currency } },
      update: {},
      create: {
        userId: demoUser.id,
        currency,
        balance: currency === 'PEN' ? 1000000n : 500000n,
        availableBalance: currency === 'PEN' ? 1000000n : 500000n,
        isDefault: currency === 'PEN',
      },
    });
  }

  for (const currency of ['PEN', 'USD']) {
    await prisma.wallet.upsert({
      where: { userId_currency: { userId: bizUser.id, currency } },
      update: {},
      create: {
        userId: bizUser.id,
        currency,
        balance: 5000000n,
        availableBalance: 5000000n,
        isDefault: currency === 'PEN',
      },
    });
  }

  await prisma.kycProfile.upsert({
    where: { userId: demoUser.id },
    update: {},
    create: {
      userId: demoUser.id,
      status: 'APPROVED',
      documentType: 'DNI',
      documentNumber: '12345678',
      documentCountry: 'PE',
      firstName: 'Demo',
      lastName: 'User',
      dateOfBirth: new Date('1990-01-15'),
      nationality: 'PE',
      verifiedAt: new Date(),
      pepCheck: true,
      sanctionsCheck: true,
      riskScore: 15,
    },
  });

  await prisma.businessProfile.upsert({
    where: { userId: bizUser.id },
    update: {},
    create: {
      userId: bizUser.id,
      taxId: '20193688001',
      taxIdType: 'RUC',
      taxIdCountry: 'PE',
      legalName: 'Kopera Technologies S.A.C.',
      tradeName: 'Kopera',
      economicActivity: 'Servicios financieros tecnologicos',
      ciiu: '6419',
      status: 'APPROVED',
      habidomStatus: 'HABIDO',
      riskScore: 10,
      reputationScore: 92,
      complianceScore: 95,
      verifiedAt: new Date(),
    },
  });

  await prisma.koperaPoints.upsert({
    where: { userId: demoUser.id },
    update: {},
    create: {
      userId: demoUser.id,
      balance: 2500,
      lifetimeEarned: 3500,
      lifetimeSpent: 1000,
      tier: 'SILVER',
    },
  });

  const fxPairs = [
    { base: 'USD', quote: 'PEN', bid: 3.72, ask: 3.75 },
    { base: 'USD', quote: 'MXN', bid: 17.05, ask: 17.15 },
    { base: 'USD', quote: 'BRL', bid: 4.95, ask: 5.02 },
    { base: 'USD', quote: 'EUR', bid: 0.915, ask: 0.925 },
    { base: 'USD', quote: 'GBP', bid: 0.79, ask: 0.80 },
    { base: 'EUR', quote: 'PEN', bid: 4.05, ask: 4.10 },
  ];
  for (const pair of fxPairs) {
    const mid = (pair.bid + pair.ask) / 2;
    await prisma.fxRate.create({
      data: {
        baseCurrency: pair.base,
        quoteCurrency: pair.quote,
        bid: pair.bid,
        ask: pair.ask,
        mid,
        spread: pair.ask - pair.bid,
        source: 'seed',
        validFrom: new Date(),
      },
    });
  }

  const agentDefs = [
    { n: 1, name: 'Qary Core', cat: 'CORE', desc: 'Master orchestrator', sla: 500 },
    { n: 2, name: 'Cybersecurity', cat: 'CORE', desc: 'Prompt injection & anomaly detection', sla: 200 },
    { n: 3, name: 'Antifraud', cat: 'CORE', desc: 'Real-time fraud scoring < 200ms', sla: 200 },
    { n: 4, name: 'Invoicing & Legal', cat: 'CORE', desc: 'Electronic invoicing multi-country', sla: 3000 },
    { n: 5, name: 'Data Analytics', cat: 'CORE', desc: 'NL2SQL financial queries', sla: 5000 },
    { n: 6, name: 'Payment Gateway', cat: 'PAYMENTS', desc: 'Gateway orchestrator', sla: 2000 },
    { n: 7, name: 'Bank Detection', cat: 'PAYMENTS', desc: 'Auto-detect bank rail', sla: 1000 },
    { n: 8, name: 'Smart Routing', cat: 'PAYMENTS', desc: 'Optimal payment rail selection', sla: 500 },
    { n: 9, name: 'Reconciliation', cat: 'PAYMENTS', desc: 'Real-time bank reconciliation', sla: 60000 },
    { n: 10, name: 'Disputes & Chargebacks', cat: 'PAYMENTS', desc: 'Chargeback management', sla: 5000 },
    { n: 11, name: 'Smart Collections', cat: 'PAYMENTS', desc: 'Multichannel collection', sla: 3000 },
    { n: 12, name: 'Subscriptions', cat: 'PAYMENTS', desc: 'Recurring billing', sla: 2000 },
    { n: 13, name: 'KYC/KYB Onboarding', cat: 'IDENTITY', desc: 'Document verification & liveness', sla: 5000 },
    { n: 14, name: 'Document Verification', cat: 'IDENTITY', desc: 'Deepfake & fraud detection', sla: 3000 },
    { n: 15, name: 'IAM Zero Trust', cat: 'IDENTITY', desc: 'Session & MFA management', sla: 200 },
    { n: 16, name: 'Secrets Management', cat: 'IDENTITY', desc: 'Vault/KMS rotation', sla: 1000 },
    { n: 17, name: 'Privacy & Consent', cat: 'IDENTITY', desc: 'GDPR/LGPD compliance', sla: 1000 },
    { n: 18, name: 'Loans', cat: 'CREDIT', desc: 'End-to-end loan origination', sla: 5000 },
    { n: 19, name: 'Alt Credit Scoring', cat: 'CREDIT', desc: 'Alternative data scoring', sla: 3000 },
    { n: 20, name: 'Cash Flow Prediction', cat: 'CREDIT', desc: '90-day forecasting', sla: 5000 },
    { n: 21, name: 'FX Risk & Treasury', cat: 'CREDIT', desc: 'Hedging & spread optimization', sla: 500 },
    { n: 22, name: 'Investor Relations', cat: 'CREDIT', desc: 'Data room & unit economics', sla: 5000 },
    { n: 23, name: 'Regulatory Compliance', cat: 'COMPLIANCE', desc: 'Multi-regulator monitoring', sla: 3000 },
    { n: 24, name: 'Continuous Audit', cat: 'COMPLIANCE', desc: 'XAI transaction audit', sla: 1000 },
    { n: 25, name: 'PCI-DSS Compliance', cat: 'COMPLIANCE', desc: 'PCI controls monitoring', sla: 5000 },
    { n: 26, name: 'DLP', cat: 'COMPLIANCE', desc: 'Data loss prevention', sla: 200 },
    { n: 27, name: 'Code Security', cat: 'COMPLIANCE', desc: 'SAST/DAST/SCA scanning', sla: 10000 },
    { n: 28, name: 'Regulatory Reporting', cat: 'COMPLIANCE', desc: 'FATF/SAR/STR reports', sla: 10000 },
    { n: 29, name: 'User Support', cat: 'EXPERIENCE', desc: 'L1/L2 support', sla: 3000 },
    { n: 30, name: 'Sentiment & Voice', cat: 'EXPERIENCE', desc: 'Frustration detection', sla: 2000 },
    { n: 31, name: 'Translation', cat: 'EXPERIENCE', desc: '40+ languages', sla: 1000 },
    { n: 32, name: 'Dashboard', cat: 'EXPERIENCE', desc: 'Financial visualization', sla: 3000 },
    { n: 33, name: 'Ant Expenses', cat: 'EXPERIENCE', desc: 'Micro-expense detection', sla: 3000 },
    { n: 34, name: 'Marketing & Retention', cat: 'EXPERIENCE', desc: 'Churn & campaigns', sla: 3000 },
    { n: 35, name: 'Observability SRE', cat: 'INFRASTRUCTURE', desc: 'OpenTelemetry & alerting', sla: 1000 },
    { n: 36, name: 'Testing QA', cat: 'INFRASTRUCTURE', desc: 'Auto-generated tests', sla: 30000 },
    { n: 37, name: 'CI/CD', cat: 'INFRASTRUCTURE', desc: 'GitOps & canary deploys', sla: 5000 },
    { n: 38, name: 'Transactional Email', cat: 'INFRASTRUCTURE', desc: 'Auto-send per operation', sla: 3000 },
    { n: 39, name: 'ESG Sustainability', cat: 'INFRASTRUCTURE', desc: 'Carbon footprint tracking', sla: 2000 },
    { n: 40, name: 'Localization', cat: 'INFRASTRUCTURE', desc: 'Country adaptation', sla: 3000 },
    { n: 41, name: 'Business Validation', cat: 'CORPORATE', desc: 'RUC auto-validation < 800ms', sla: 800 },
    { n: 42, name: 'Reputational Investigation', cat: 'CORPORATE', desc: 'Judicial due diligence', sla: 5000 },
    { n: 43, name: 'Anticorruption', cat: 'CORPORATE', desc: 'OFAC/UN/PEP screening', sla: 3000 },
    { n: 44, name: 'Corporate Report PDF', cat: 'CORPORATE', desc: 'Signed PDF + email', sla: 4000 },
    { n: 45, name: 'Continuous Monitoring', cat: 'CORPORATE', desc: '24/7 post-registration monitoring', sla: 60000 },
    { n: 46, name: 'FX Market Advisor', cat: 'MARKET', desc: 'Real-time rates & advice', sla: 500 },
    { n: 47, name: 'Financial Health', cat: 'MARKET', desc: 'Score analysis & recommendations', sla: 3000 },
    { n: 48, name: 'Financial Education', cat: 'EXPERIENCE', desc: 'Adaptive micro-lessons', sla: 3000 },
    { n: 49, name: 'What-If Simulator', cat: 'MARKET', desc: 'Financial simulator', sla: 2000 },
    { n: 50, name: 'Voice/Video Onboarding', cat: 'EXPERIENCE', desc: 'Accessible 40+ languages', sla: 5000 },
    { n: 51, name: 'Savings Optimizer', cat: 'MARKET', desc: 'Proactive savings detection', sla: 3000 },
  ];

  for (const a of agentDefs) {
    await prisma.agent.upsert({
      where: { number: a.n },
      update: { description: a.desc, slaMs: a.sla },
      create: {
        number: a.n,
        name: a.name,
        category: a.cat as any,
        description: a.desc,
        slaMs: a.sla,
        healthStatus: 'healthy',
        lastHealthCheck: new Date(),
      },
    });
  }

  console.log('Kopera seed complete:');
  console.log(`  Users: ${demoUser.email}, ${bizUser.email}, ${adminUser.email}`);
  console.log(`  Wallets: PEN/USD/EUR for demo; PEN/USD for business`);
  console.log(`  KYC: approved | KYB: approved (RUC 20193688001)`);
  console.log(`  FX rates: ${fxPairs.length} pairs | Agents: ${agentDefs.length}`);
  console.log(`  Points: 2500 (Silver tier) for demo`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
