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
    payload: { email: 'b91@kopera.io' },
  });
  const v = await app.inject({
    method: 'POST', url: '/api/auth/verify-otp',
    payload: { email: 'b91@kopera.io', code: reg.json().debugOtp },
  });
  const { accessToken, user } = v.json();

  return { app, prisma, accessToken, user };
}

describe('IP whitelist', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('adds an IP to whitelist', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/ip-whitelist/add',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ipAddress: '192.168.1.100', label: 'Office' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().ipAddress).toBe('192.168.1.100');
    expect(res.json().label).toBe('Office');
  });

  it('rejects duplicate IP', async () => {
    await ctx.prisma.ipWhitelist.create({
      data: { userId: ctx.user.id, ipAddress: '10.0.0.1', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/ip-whitelist/add',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ipAddress: '10.0.0.1' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('ip_already_whitelisted');
  });

  it('lists whitelisted IPs', async () => {
    await ctx.prisma.ipWhitelist.create({
      data: { userId: ctx.user.id, ipAddress: '10.0.0.1', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ip-whitelist/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('checks an IP against whitelist', async () => {
    await ctx.prisma.ipWhitelist.create({
      data: { userId: ctx.user.id, ipAddress: '10.0.0.1', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/ip-whitelist/check',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { ipAddress: '10.0.0.1' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().whitelistEnabled).toBe(true);
    expect(res.json().allowed).toBe(true);
  });

  it('toggles an IP entry', async () => {
    const entry = await ctx.prisma.ipWhitelist.create({
      data: { userId: ctx.user.id, ipAddress: '10.0.0.1', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'POST', url: `/api/ip-whitelist/${entry.id}/toggle`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('removes an IP', async () => {
    const entry = await ctx.prisma.ipWhitelist.create({
      data: { userId: ctx.user.id, ipAddress: '10.0.0.1', isActive: true },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/ip-whitelist/${entry.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data IP whitelist analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/ip-whitelist/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalEntries).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});

describe('currency configuration', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('sets a currency config', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/currency-configs/set',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { currency: 'USD', displayDecimals: 2, isDefault: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().currency).toBe('USD');
    expect(res.json().isDefault).toBe(true);
  });

  it('lists currency configs', async () => {
    await ctx.prisma.currencyConfig.create({
      data: { userId: ctx.user.id, currency: 'EUR', displayDecimals: 2, roundingMode: 'half_up' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/currency-configs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('gets default currency', async () => {
    await ctx.prisma.currencyConfig.create({
      data: { userId: ctx.user.id, currency: 'USD', displayDecimals: 2, isDefault: true },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/currency-configs/default',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('USD');
  });

  it('removes a currency config', async () => {
    const config = await ctx.prisma.currencyConfig.create({
      data: { userId: ctx.user.id, currency: 'GBP', displayDecimals: 2 },
    });
    const res = await ctx.app.inject({
      method: 'DELETE', url: `/api/currency-configs/${config.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns no_data currency analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/currency-configs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalConfigs).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });

  it('gets a single currency config by id', async () => {
    const config = await ctx.prisma.currencyConfig.create({
      data: { userId: ctx.user.id, currency: 'JPY', displayDecimals: 0, roundingMode: 'floor' },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: `/api/currency-configs/${config.id}`,
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().currency).toBe('JPY');
    expect(res.json().roundingMode).toBe('floor');
  });
});

describe('notification preferences', () => {
  let ctx: Awaited<ReturnType<typeof bootstrap>>;
  beforeEach(async () => { ctx = await bootstrap(); });

  it('sets a notification preference', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/notification-prefs/set',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: { eventType: 'payment.completed', channel: 'push', enabled: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().eventType).toBe('payment.completed');
    expect(res.json().enabled).toBe(true);
  });

  it('lists preferences', async () => {
    await ctx.prisma.notificationPref.create({
      data: { userId: ctx.user.id, eventType: 'login', channel: 'email', enabled: true },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notification-prefs/list',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(1);
  });

  it('bulk sets preferences', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/notification-prefs/bulk',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
      payload: {
        preferences: [
          { eventType: 'payment.completed', channel: 'push', enabled: true },
          { eventType: 'payment.completed', channel: 'email', enabled: false },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('resets to defaults', async () => {
    const res = await ctx.app.inject({
      method: 'POST', url: '/api/notification-prefs/reset',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(6);
  });

  it('gets preferences by event', async () => {
    await ctx.prisma.notificationPref.create({
      data: { userId: ctx.user.id, eventType: 'security.alert', channel: 'push', enabled: true },
    });
    await ctx.prisma.notificationPref.create({
      data: { userId: ctx.user.id, eventType: 'security.alert', channel: 'email', enabled: true },
    });
    await ctx.prisma.notificationPref.create({
      data: { userId: ctx.user.id, eventType: 'marketing', channel: 'email', enabled: false },
    });
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notification-prefs/event/security.alert',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().length).toBe(2);
  });

  it('returns no_data preference analytics', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/api/notification-prefs/analytics',
      headers: { authorization: `Bearer ${ctx.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().totalPreferences).toBe(0);
    expect(res.json().analyticsLevel).toBe('no_data');
  });
});
