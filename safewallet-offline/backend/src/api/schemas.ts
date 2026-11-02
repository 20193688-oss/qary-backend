import { CURRENCIES } from '../types.js';

export type Schema = Record<string, unknown>;
export const str = (extra: Schema = {}): Schema => ({ type: 'string', ...extra });
export const int = (extra: Schema = {}): Schema => ({ type: 'integer', ...extra });
export const bool: Schema = { type: 'boolean' };
export const obj = (properties: Record<string, Schema>, required: string[] = [], additionalProperties = false): Schema => ({ type: 'object', properties, required, additionalProperties });
export const arr = (items: Schema, extra: Schema = {}): Schema => ({ type: 'array', items, ...extra });
export const any: Schema = {};
export const currency: Schema = { type: 'string', enum: [...CURRENCIES] };
export const hex = (min: number, max: number): Schema => ({ type: 'string', pattern: `^[0-9a-f]{${min},${max}}$` });
export const b64 = (extra: Schema = {}): Schema => ({ type: 'string', pattern: '^[A-Za-z0-9_-]+$', ...extra });

export const wrapped = obj({ epk: b64(), iv: b64(), ct: b64(), tag: b64() }, ['epk', 'iv', 'ct', 'tag']);
export const rateSnapshot = obj({
  id: str(), base: str(), asOf: int(), expiresAt: int(), ratesMicros: obj(Object.fromEntries(CURRENCIES.map((c) => [c, int()])), [...CURRENCIES]),
  marginBps: int(), source: str(), sig: b64(),
}, ['id', 'base', 'asOf', 'expiresAt', 'ratesMicros', 'marginBps', 'source', 'sig']);

export const intent = obj({
  txId: hex(8, 64), payerDeviceId: hex(32, 32), payeeDeviceId: hex(32, 32), payeeRef: str(), merchantRef: str(),
  amountMinor: int({ minimum: 1 }), currency, payerAmountMinor: int({ minimum: 1 }), payerCurrency: currency, rateMicros: int({ minimum: 1 }),
  marginBps: int({ minimum: 0, maximum: 1000 }), rateSnapshotId: str(), token: str({ pattern: '^\\d{16}$' }), arqc: hex(32, 32), counter: int({ minimum: 1 }),
  channel: { type: 'string', enum: ['ble', 'nfc', 'qr', 'qr_emv', 'sms', 'pos'] }, ts: int(), nonce: str(), keyEpoch: int({ minimum: 1 }),
  geo: obj({ country: str(), latE6: int(), lonE6: int() }, ['country']),
  stepUp: obj({ biometric: bool, pin: bool, smsProof: str() }, ['biometric', 'pin']),
}, ['txId', 'payerDeviceId', 'amountMinor', 'currency', 'payerAmountMinor', 'payerCurrency', 'rateMicros', 'marginBps', 'rateSnapshotId', 'token', 'arqc', 'counter', 'channel', 'ts', 'nonce', 'keyEpoch'], true);

export const voucher = obj({
  intent, payerSig: b64(),
  payeeAck: obj({ payeeDeviceId: hex(32, 32), sig: b64() }, ['payeeDeviceId', 'sig']),
}, ['intent', 'payerSig']);

export const ledgerEntry = obj({
  seq: int({ minimum: 0 }), counter: int({ minimum: 1 }), prevHash: hex(64, 64), keyEpoch: int({ minimum: 1 }),
  type: { type: 'string', enum: ['PAY_OUT', 'PAY_IN', 'RATE_SYNC', 'NOTE'] }, payload: { type: 'object' }, hash: hex(64, 64), mac: hex(64, 64), sig: b64(),
}, ['seq', 'counter', 'prevHash', 'keyEpoch', 'type', 'payload', 'hash', 'mac', 'sig']);

export const errorSchema = obj({ error: obj({ code: str(), message: str(), details: any }, ['code', 'message']) }, ['error']);
export const deviceIdParam = obj({ deviceId: hex(32, 32) }, ['deviceId']);
