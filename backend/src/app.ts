import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import type { StripeLike } from './lib/stripe.js';
import type { Realtime } from './lib/realtime.js';
import { noopRealtime } from './lib/realtime.js';
import { authPlugin } from './lib/auth-plugin.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrdersRoutes } from './routes/orders.js';
import { registerLocationsRoutes } from './routes/locations.js';
import { registerIncidentsRoutes } from './routes/incidents.js';
import { registerPaymentsRoutes } from './routes/payments.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerReceiptsRoutes } from './routes/receipts.js';
import { registerVoicePaymentRoutes } from './routes/voice-payment.js';
// Kopera fintech routes
import { registerWalletRoutes } from './routes/kopera/wallets.js';
import { registerFxRoutes } from './routes/kopera/fx.js';
import { registerInvoiceRoutes } from './routes/kopera/invoices.js';
import { registerLoanRoutes } from './routes/kopera/loans.js';
import { registerPointsRoutes } from './routes/kopera/points.js';
import { registerAgentRoutes } from './routes/kopera/agents.js';
import { registerKycRoutes } from './routes/kopera/kyc.js';
import { registerGatewayRoutes } from './routes/kopera/gateway.js';
import { registerNotificationRoutes } from './routes/kopera/notifications.js';
import { registerDisputeRoutes } from './routes/kopera/disputes.js';
import { registerSubscriptionRoutes } from './routes/kopera/subscriptions.js';
import { registerBeneficiaryRoutes } from './routes/kopera/beneficiaries.js';
import { registerScheduledTransferRoutes } from './routes/kopera/scheduled-transfers.js';
import { registerSavingsGoalRoutes } from './routes/kopera/savings-goals.js';
import { registerPaymentLinkRoutes } from './routes/kopera/payment-links.js';
import { registerTransactionLimitRoutes } from './routes/kopera/transaction-limits.js';
import { registerReferralRoutes } from './routes/kopera/referrals.js';
import { registerTokenizedCardRoutes } from './routes/kopera/tokenized-cards.js';
import { registerBankAccountRoutes } from './routes/kopera/bank-accounts.js';
import { registerTransactionRoutes } from './routes/kopera/transactions.js';
import { registerAntExpenseRoutes } from './routes/kopera/ant-expenses.js';
import { registerUserSessionRoutes } from './routes/kopera/user-sessions.js';
import { registerEventRoutes } from './routes/kopera/events.js';
import { registerLedgerRoutes } from './routes/kopera/ledger.js';
import { registerBusinessProfileRoutes } from './routes/kopera/business-profiles.js';
import { registerLoanRepaymentRoutes } from './routes/kopera/loan-repayments.js';
import { registerUserProfileRoutes } from './routes/kopera/user-profiles.js';
import { registerDashboardRoutes } from './routes/kopera/dashboard.js';
import { registerCreditExpressRoutes } from './routes/kopera/credit-express.js';
import { registerCrossBorderTransferRoutes } from './routes/kopera/cross-border-transfers.js';
import { registerTransactionMapRoutes } from './routes/kopera/transaction-map.js';
import { registerSafePayRoutes } from './routes/kopera/safe-pay.js';
import { registerFraudAlertRoutes } from './routes/kopera/fraud-alert.js';
import { registerSecretKeyRoutes } from './routes/kopera/secret-key.js';
import { registerPostFraudAuditRoutes } from './routes/kopera/post-fraud-audit.js';
import { registerComplianceReportRoutes } from './routes/kopera/compliance-reports.js';
import { registerAccountStatementRoutes } from './routes/kopera/account-statements.js';
import { registerWebhookConfigRoutes } from './routes/kopera/webhook-configs.js';
import { registerAuditTrailRoutes } from './routes/kopera/audit-trail.js';
import { registerApiKeyRoutes } from './routes/kopera/api-keys.js';
import { registerRateLimitConfigRoutes } from './routes/kopera/rate-limit-configs.js';
import { registerIpWhitelistRoutes } from './routes/kopera/ip-whitelist.js';
import { registerCurrencyConfigRoutes } from './routes/kopera/currency-configs.js';
import { registerNotificationPrefRoutes } from './routes/kopera/notification-prefs.js';
import { registerFeeScheduleRoutes } from './routes/kopera/fee-schedules.js';
import { registerApprovalWorkflowRoutes } from './routes/kopera/approval-workflows.js';
import { registerDocumentVaultRoutes } from './routes/kopera/document-vault.js';
import { registerPaymentTemplateRoutes } from './routes/kopera/payment-templates.js';
import { registerRiskScoringRoutes } from './routes/kopera/risk-scoring.js';
import { registerExchangeOrderRoutes } from './routes/kopera/exchange-orders.js';
import { registerSpendingInsightRoutes } from './routes/kopera/spending-insights.js';
import { registerComplianceRuleRoutes } from './routes/kopera/compliance-rules.js';
import { registerMerchantProfileRoutes } from './routes/kopera/merchant-profiles.js';
import { registerBalanceAlertRoutes } from './routes/kopera/balance-alerts.js';
import { registerPaymentBatchRoutes } from './routes/kopera/payment-batches.js';
import { registerAccountGroupRoutes } from './routes/kopera/account-groups.js';
import { registerRecurringInvoiceRoutes } from './routes/kopera/recurring-invoices.js';
import { registerVirtualCardRoutes } from './routes/kopera/virtual-cards.js';
import { registerTaxConfigRoutes } from './routes/kopera/tax-configs.js';
import { registerBudgetCategoryRoutes } from './routes/kopera/budget-categories.js';
import { registerPayoutMethodRoutes } from './routes/kopera/payout-methods.js';
import { registerCashflowForecastRoutes } from './routes/kopera/cashflow-forecasts.js';
import { registerPaymentSplitRoutes } from './routes/kopera/payment-splits.js';
import { registerAccountVerificationRoutes } from './routes/kopera/account-verifications.js';
import { registerWireTransferRoutes } from './routes/kopera/wire-transfers.js';
import { registerDirectDebitRoutes } from './routes/kopera/direct-debits.js';
import { registerEscrowRoutes } from './routes/kopera/escrows.js';
import { registerStandingOrderRoutes } from './routes/kopera/standing-orders.js';
import { registerInvoiceCreditNoteRoutes } from './routes/kopera/invoice-credit-notes.js';
import { registerRewardProgramRoutes } from './routes/kopera/reward-programs.js';
import { registerPaymentRequestRoutes } from './routes/kopera/payment-requests.js';
import { registerMerchantSettlementRoutes } from './routes/kopera/merchant-settlements.js';
import { registerPaymentScheduleRoutes } from './routes/kopera/payment-schedules.js';
import { registerChargebackRoutes } from './routes/kopera/chargebacks.js';
import { registerAccountTierRoutes } from './routes/kopera/account-tiers.js';
import { registerPaymentLinkTemplateRoutes } from './routes/kopera/payment-link-templates.js';
import { registerBankTransferBatchRoutes } from './routes/kopera/bank-transfer-batches.js';
import { registerInvoiceReminderRoutes } from './routes/kopera/invoice-reminders.js';
import { registerTransactionTagRoutes } from './routes/kopera/transaction-tags.js';
import { registerRecurringPaymentRoutes } from './routes/kopera/recurring-payments.js';
import { registerPaymentDisputeEvidenceRoutes } from './routes/kopera/payment-dispute-evidence.js';
import { registerCustomerSegmentRoutes } from './routes/kopera/customer-segments.js';
import { registerPaymentCorridorRoutes } from './routes/kopera/payment-corridors.js';
import { registerSettlementReportRoutes } from './routes/kopera/settlement-reports.js';
import { registerPaymentMethodConfigRoutes } from './routes/kopera/payment-method-configs.js';
import { registerTransactionExportRoutes } from './routes/kopera/transaction-exports.js';
import { registerMerchantOnboardingRoutes } from './routes/kopera/merchant-onboarding.js';
import { registerTransactionCategoryRoutes } from './routes/kopera/transaction-categories.js';
import { registerPayoutScheduleRoutes } from './routes/kopera/payout-schedules.js';
import { registerComplianceCheckRoutes } from './routes/kopera/compliance-checks.js';
import { registerAccountClosureRoutes } from './routes/kopera/account-closures.js';
import { registerPaymentGatewayConfigRoutes } from './routes/kopera/payment-gateway-configs.js';
import { registerPaymentReconciliationRoutes } from './routes/kopera/payment-reconciliations.js';
import { registerMerchantFeeOverrideRoutes } from './routes/kopera/merchant-fee-overrides.js';
import { registerTransactionAlertRuleRoutes } from './routes/kopera/transaction-alert-rules.js';

export interface AppDeps {
  prisma: PrismaClient;
  redis: Redis;
  stripe: StripeLike;
  realtime?: Realtime;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const isTest = process.env.NODE_ENV === 'test';
  const app = Fastify({
    logger: isTest
      ? false
      : { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    trustProxy: true,
    disableRequestLogging: isTest,
  });

  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      (req as { rawBody?: Buffer }).rawBody = body as Buffer;
      try {
        const text = (body as Buffer).toString('utf8');
        done(null, text.length ? JSON.parse(text) : {});
      } catch (e) {
        done(e as Error);
      }
    },
  );

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, { origin: process.env.APP_BASE_URL ?? true, credentials: true });
  await app.register(rateLimit, {
    max: Number(process.env.RATE_LIMIT_GLOBAL_PER_MIN ?? 120),
    timeWindow: '1 minute',
  });
  await authPlugin(app);

  // Legacy routes (ride-sharing)
  await registerHealthRoutes(app);
  await registerAuthRoutes(app, deps);
  await registerOrdersRoutes(app);
  await registerLocationsRoutes(app, { realtime: deps.realtime ?? noopRealtime });
  await registerIncidentsRoutes(app);
  await registerPaymentsRoutes(app, deps);
  await registerWebhookRoutes(app, deps);
  await registerReceiptsRoutes(app, deps);
  await registerVoicePaymentRoutes(app, deps);

  // Kopera fintech routes
  await registerWalletRoutes(app, deps.prisma);
  await registerFxRoutes(app, deps.prisma);
  await registerInvoiceRoutes(app, deps.prisma);
  await registerLoanRoutes(app, deps.prisma);
  await registerPointsRoutes(app, deps.prisma);
  await registerAgentRoutes(app, deps.prisma);
  await registerKycRoutes(app, deps.prisma);
  await registerGatewayRoutes(app, deps.prisma);
  await registerNotificationRoutes(app, deps.prisma);
  await registerDisputeRoutes(app, deps.prisma);
  await registerSubscriptionRoutes(app, deps.prisma);
  await registerBeneficiaryRoutes(app, deps.prisma);
  await registerScheduledTransferRoutes(app, deps.prisma);
  await registerSavingsGoalRoutes(app, deps.prisma);
  await registerPaymentLinkRoutes(app, deps.prisma);
  await registerTransactionLimitRoutes(app, deps.prisma);
  await registerReferralRoutes(app, deps.prisma);
  await registerTokenizedCardRoutes(app, deps.prisma);
  await registerBankAccountRoutes(app, deps.prisma);
  await registerTransactionRoutes(app, deps.prisma);
  await registerAntExpenseRoutes(app, deps.prisma);
  await registerUserSessionRoutes(app, deps.prisma);
  await registerEventRoutes(app, deps.prisma);
  await registerLedgerRoutes(app, deps.prisma);
  await registerBusinessProfileRoutes(app, deps.prisma);
  await registerLoanRepaymentRoutes(app, deps.prisma);
  await registerUserProfileRoutes(app, deps.prisma);
  await registerDashboardRoutes(app, deps.prisma);
  await registerCreditExpressRoutes(app, deps.prisma);
  await registerCrossBorderTransferRoutes(app, deps.prisma);
  await registerTransactionMapRoutes(app, deps.prisma);
  await registerSafePayRoutes(app, deps.prisma);
  await registerFraudAlertRoutes(app, deps.prisma);
  await registerSecretKeyRoutes(app, deps.prisma);
  await registerPostFraudAuditRoutes(app, deps.prisma);
  await registerComplianceReportRoutes(app, deps.prisma);
  await registerAccountStatementRoutes(app, deps.prisma);
  await registerWebhookConfigRoutes(app, deps.prisma);
  await registerAuditTrailRoutes(app, deps.prisma);
  await registerApiKeyRoutes(app, deps.prisma);
  await registerRateLimitConfigRoutes(app, deps.prisma);
  await registerIpWhitelistRoutes(app, deps.prisma);
  await registerCurrencyConfigRoutes(app, deps.prisma);
  await registerNotificationPrefRoutes(app, deps.prisma);
  await registerFeeScheduleRoutes(app, deps.prisma);
  await registerApprovalWorkflowRoutes(app, deps.prisma);
  await registerDocumentVaultRoutes(app, deps.prisma);
  await registerPaymentTemplateRoutes(app, deps.prisma);
  await registerRiskScoringRoutes(app, deps.prisma);
  await registerExchangeOrderRoutes(app, deps.prisma);
  await registerSpendingInsightRoutes(app, deps.prisma);
  await registerComplianceRuleRoutes(app, deps.prisma);
  await registerMerchantProfileRoutes(app, deps.prisma);
  await registerBalanceAlertRoutes(app, deps.prisma);
  await registerPaymentBatchRoutes(app, deps.prisma);
  await registerAccountGroupRoutes(app, deps.prisma);
  await registerRecurringInvoiceRoutes(app, deps.prisma);
  await registerVirtualCardRoutes(app, deps.prisma);
  await registerTaxConfigRoutes(app, deps.prisma);
  await registerBudgetCategoryRoutes(app, deps.prisma);
  await registerPayoutMethodRoutes(app, deps.prisma);
  await registerCashflowForecastRoutes(app, deps.prisma);
  await registerPaymentSplitRoutes(app, deps.prisma);
  await registerAccountVerificationRoutes(app, deps.prisma);
  await registerWireTransferRoutes(app, deps.prisma);
  await registerDirectDebitRoutes(app, deps.prisma);
  await registerEscrowRoutes(app, deps.prisma);
  await registerStandingOrderRoutes(app, deps.prisma);
  await registerInvoiceCreditNoteRoutes(app, deps.prisma);
  await registerRewardProgramRoutes(app, deps.prisma);
  await registerPaymentRequestRoutes(app, deps.prisma);
  await registerMerchantSettlementRoutes(app, deps.prisma);
  await registerPaymentScheduleRoutes(app, deps.prisma);
  await registerChargebackRoutes(app, deps.prisma);
  await registerAccountTierRoutes(app, deps.prisma);
  await registerPaymentLinkTemplateRoutes(app, deps.prisma);
  await registerBankTransferBatchRoutes(app, deps.prisma);
  await registerInvoiceReminderRoutes(app, deps.prisma);
  await registerTransactionTagRoutes(app, deps.prisma);
  await registerRecurringPaymentRoutes(app, deps.prisma);
  await registerPaymentDisputeEvidenceRoutes(app, deps.prisma);
  await registerCustomerSegmentRoutes(app, deps.prisma);
  await registerPaymentCorridorRoutes(app, deps.prisma);
  await registerSettlementReportRoutes(app, deps.prisma);
  await registerPaymentMethodConfigRoutes(app, deps.prisma);
  await registerTransactionExportRoutes(app, deps.prisma);
  await registerMerchantOnboardingRoutes(app, deps.prisma);
  await registerTransactionCategoryRoutes(app, deps.prisma);
  await registerPayoutScheduleRoutes(app, deps.prisma);
  await registerComplianceCheckRoutes(app, deps.prisma);
  await registerAccountClosureRoutes(app, deps.prisma);
  await registerPaymentGatewayConfigRoutes(app, deps.prisma);
  await registerPaymentReconciliationRoutes(app, deps.prisma);
  await registerMerchantFeeOverrideRoutes(app, deps.prisma);
  await registerTransactionAlertRuleRoutes(app, deps.prisma);

  return app;
}
