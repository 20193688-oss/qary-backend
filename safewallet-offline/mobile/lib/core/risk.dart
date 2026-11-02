/// Score de riesgo 0-100 (misma fórmula que `backend/src/services/risk.ts`; vectores compartidos).
class RiskInput {
  const RiskInput({
    required this.amountUsdMinor, required this.perTxLimitUsdMinor, required this.dailyLimitUsdMinor, required this.dailyUsedUsdMinor,
    this.txLastHour = 0, this.merchantUnlisted = false, this.foreign = false, required this.hourLocal, required this.channel,
    this.untrustedDevice = false, this.activeRiskFlag = false,
  });
  final int amountUsdMinor, perTxLimitUsdMinor, dailyLimitUsdMinor, dailyUsedUsdMinor, txLastHour, hourLocal;
  final bool merchantUnlisted, foreign, untrustedDevice, activeRiskFlag;
  final String channel;

  factory RiskInput.fromJson(Map<String, dynamic> j) => RiskInput(
      amountUsdMinor: j['amountUsdMinor'], perTxLimitUsdMinor: j['perTxLimitUsdMinor'], dailyLimitUsdMinor: j['dailyLimitUsdMinor'],
      dailyUsedUsdMinor: j['dailyUsedUsdMinor'], txLastHour: j['txLastHour'], merchantUnlisted: j['merchantUnlisted'], foreign: j['foreign'],
      hourLocal: j['hourLocal'], channel: j['channel'], untrustedDevice: j['untrustedDevice'], activeRiskFlag: j['activeRiskFlag']);
}

int _round(num x) => x.round();

int riskScore(RiskInput i) {
  var s = 0;
  s += _round(40 * _min1(i.amountUsdMinor / (i.perTxLimitUsdMinor < 1 ? 1 : i.perTxLimitUsdMinor)));
  s += _round(20 * _min1((i.dailyUsedUsdMinor + i.amountUsdMinor) / (i.dailyLimitUsdMinor < 1 ? 1 : i.dailyLimitUsdMinor)));
  s += i.txLastHour >= 6 ? 15 : (i.txLastHour >= 3 ? 10 : 0);
  s += i.merchantUnlisted ? 10 : 0;
  s += i.foreign ? 10 : 0;
  s += (i.hourLocal >= 0 && i.hourLocal < 5) ? 5 : 0;
  s += i.channel == 'sms' ? 5 : 0;
  s += i.untrustedDevice ? 20 : 0;
  s += i.activeRiskFlag ? 20 : 0;
  return s > 100 ? 100 : s;
}

double _min1(double x) => x > 1 ? 1 : x;
