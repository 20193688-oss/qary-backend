export const CURRENCIES = ['PEN', 'USD', 'EUR', 'CRC', 'VES', 'COP'] as const;
export type Currency = (typeof CURRENCIES)[number];
export type Plan = 'starter' | 'pro' | 'enterprise';
export type DeviceStatus = 'active' | 'locked' | 'shielded' | 'blocked';

export interface Tenant { id: string; name: string; plan: Plan; apiKeyHash: string; webhookSecret: string; createdAt: number; admin?: boolean; [k: string]: unknown }

export interface Device {
  id: string;
  tenantId: string;
  publicKey: string;
  platform: 'android' | 'ios' | 'sandbox';
  buildId: string;
  trusted: boolean;
  trustReasons: string[];
  status: DeviceStatus;
  decoy: boolean;
  keyEpoch: number;
  minKeyEpoch: number;
  licenseExpiresAt: number;
  lastCounter: number;
  lastEntryHash: string;
  lastEntrySeq: number;
  sessionEpoch: number;
  pendingCommands: string[];
  createdAt: number;
  statusReason?: string;
  [k: string]: unknown;
}

export interface Profile {
  deviceId: string;
  phone?: string;
  pinHash?: string;
  duressPinHash?: string;
  trustedContacts: { name: string; phone: string }[];
  safeZone?: { lat: number; lon: number; radiusM: number };
  offlineDailyLimitUsdMinor: number;
  offlinePerTxLimitUsdMinor: number;
  countryLimitsUsdMinor: Record<string, number>;
  whitelistMerchants: string[];
  deadmanHours?: number;
  lastProofOfLife: number;
  email?: string;
  userRef: string;
  [k: string]: unknown;
}

export interface Intent {
  txId: string;
  payerDeviceId: string;
  payeeDeviceId?: string;
  payeeRef?: string;
  merchantRef?: string;
  amountMinor: number;       // en moneda del beneficiario
  currency: Currency;
  payerAmountMinor: number;  // en moneda del pagador
  payerCurrency: Currency;
  rateMicros: number;        // unidades de `currency` por 1 `payerCurrency`, x1e6
  marginBps: number;
  rateSnapshotId: string;
  token: string;
  arqc: string;
  counter: number;
  channel: 'ble' | 'nfc' | 'qr' | 'qr_emv' | 'sms' | 'pos';
  ts: number;
  nonce: string;
  geo?: { country: string; latE6?: number; lonE6?: number };
  stepUp?: { biometric: boolean; pin: boolean; smsProof?: string };
  keyEpoch: number;
  [k: string]: unknown;
}
export interface Voucher { intent: Intent; payerSig: string; payeeAck?: { payeeDeviceId: string; sig: string } }

export interface LedgerEntry {
  seq: number;
  counter: number;
  prevHash: string;
  keyEpoch: number;
  type: 'PAY_OUT' | 'PAY_IN' | 'RATE_SYNC' | 'NOTE';
  payload: Record<string, unknown>;
  hash: string;
  mac: string;
  sig: string;
}
