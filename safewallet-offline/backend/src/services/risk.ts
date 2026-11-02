export interface RiskInput {
  amountUsdMinor: number;
  perTxLimitUsdMinor: number;
  dailyLimitUsdMinor: number;
  dailyUsedUsdMinor: number;       // antes de esta operación
  txLastHour: number;
  merchantUnlisted: boolean;       // hay merchantRef y no está en la lista blanca
  foreign: boolean;
  hourLocal: number;               // 0..23
  channel: string;
  untrustedDevice: boolean;
  activeRiskFlag: boolean;
}
export interface RiskResult { score: number; factors: { name: string; points: number }[] }

/** Score 0-100. Misma fórmula en Dart (mobile/lib/core/risk.dart): vectores de prueba compartidos. */
export function riskScore(i: RiskInput): RiskResult {
  const f: { name: string; points: number }[] = [];
  const add = (name: string, points: number) => { if (points > 0) f.push({ name, points }); };
  add('amount_vs_tx_limit', Math.round(40 * Math.min(1, i.amountUsdMinor / Math.max(1, i.perTxLimitUsdMinor))));
  add('daily_utilization', Math.round(20 * Math.min(1, (i.dailyUsedUsdMinor + i.amountUsdMinor) / Math.max(1, i.dailyLimitUsdMinor))));
  add('velocity', i.txLastHour >= 6 ? 15 : i.txLastHour >= 3 ? 10 : 0);
  add('merchant_not_whitelisted', i.merchantUnlisted ? 10 : 0);
  add('foreign_country', i.foreign ? 10 : 0);
  add('night_hours', i.hourLocal >= 0 && i.hourLocal < 5 ? 5 : 0);
  add('sms_channel', i.channel === 'sms' ? 5 : 0);
  add('untrusted_device', i.untrustedDevice ? 20 : 0);
  add('active_risk_flag', i.activeRiskFlag ? 20 : 0);
  const score = Math.min(100, f.reduce((a, x) => a + x.points, 0));
  return { score, factors: f };
}
