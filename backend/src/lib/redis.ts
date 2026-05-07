import Redis from 'ioredis';

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL ?? 'redis://localhost:6379';
  _redis = new Redis(url, { maxRetriesPerRequest: 3, lazyConnect: false });
  return _redis;
}

export async function closeRedis() {
  if (_redis) {
    await _redis.quit();
    _redis = null;
  }
}
