/**
 * Configuration Validation Tests
 *
 * Tests for db-config, fee-config, nats-config, and redis-config modules.
 * Validates Zod schema parsing, env var handling, and edge cases.
 */

import { loadDbConfig } from '../config/db-config';
import { loadFeeConfig } from '../config/fee-config';
import { loadNatsConfig, NATS_TOPICS } from '../config/nats-config';
import { loadRedisConfig, REDIS_STREAMS, REDIS_CONSUMER_GROUPS } from '../config/redis-config';

describe('db-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should throw when DB_URL is missing', () => {
    delete process.env.DB_URL;
    expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
    expect(() => loadDbConfig()).toThrow('DB_URL is required');
  });

  it('should throw when DB_URL is empty', () => {
    process.env.DB_URL = '';
    expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
  });

  it('should load valid config from env', () => {
    process.env.DB_URL = 'postgres://user:pass@localhost:5432/test';
    process.env.DB_MAX_POOL_SIZE = '20';
    process.env.DB_IDLE_TIMEOUT_MS = '60000';

    const config = loadDbConfig();
    expect(config.url).toBe('postgres://user:pass@localhost:5432/test');
    expect(config.maxPoolSize).toBe(20);
    expect(config.idleTimeoutMillis).toBe(60000);
  });

  it('should use defaults for pool size and idle timeout', () => {
    process.env.DB_URL = 'postgres://localhost:5432/test';
    delete process.env.DB_MAX_POOL_SIZE;
    delete process.env.DB_IDLE_TIMEOUT_MS;

    const config = loadDbConfig();
    expect(config.maxPoolSize).toBe(10);
    expect(config.idleTimeoutMillis).toBe(30000);
  });

  it('should reject invalid pool size (NaN)', () => {
    process.env.DB_URL = 'postgres://localhost:5432/test';
    process.env.DB_MAX_POOL_SIZE = 'abc';

    expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
  });

  it('should reject zero pool size', () => {
    process.env.DB_URL = 'postgres://localhost:5432/test';
    process.env.DB_MAX_POOL_SIZE = '0';

    expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
  });

  it('should reject negative idle timeout', () => {
    process.env.DB_URL = 'postgres://localhost:5432/test';
    process.env.DB_IDLE_TIMEOUT_MS = '-1';

    expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
  });
});

describe('fee-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    // Clear the cached config by re-importing
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load default fee config', () => {
    // loadFeeConfig caches, so we test defaults from a fresh module
    const config = loadFeeConfig();
    expect(config.makerFeeBps).toBeGreaterThanOrEqual(0);
    expect(config.makerFeeBps).toBeLessThanOrEqual(10000);
    expect(config.takerFeeBps).toBeGreaterThanOrEqual(0);
    expect(config.takerFeeBps).toBeLessThanOrEqual(10000);
  });

  it('should have makerFeeBps and takerFeeBps as integers', () => {
    const config = loadFeeConfig();
    expect(Number.isInteger(config.makerFeeBps)).toBe(true);
    expect(Number.isInteger(config.takerFeeBps)).toBe(true);
  });
});

describe('nats-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load default NATS config', () => {
    const config = loadNatsConfig();
    expect(config.url).toBe(process.env.NATS_URL || 'nats://localhost:4222');
    expect(config.maxReconnectAttempts).toBe(10);
    expect(config.reconnectTimeWait).toBe(2000);
    expect(config.timeout).toBe(10000);
  });

  it('should load custom NATS config from env', () => {
    process.env.NATS_URL = 'nats://custom:4222';
    process.env.NATS_USER = 'testuser';
    process.env.NATS_PASSWORD = 'testpass';
    process.env.NATS_TOKEN = 'testtoken';
    process.env.NATS_MAX_RECONNECT_ATTEMPTS = '5';
    process.env.NATS_RECONNECT_TIME_WAIT = '3000';
    process.env.NATS_TIMEOUT = '15000';

    const config = loadNatsConfig();
    expect(config.url).toBe('nats://custom:4222');
    expect(config.user).toBe('testuser');
    expect(config.password).toBe('testpass');
    expect(config.token).toBe('testtoken');
    expect(config.maxReconnectAttempts).toBe(5);
    expect(config.reconnectTimeWait).toBe(3000);
    expect(config.timeout).toBe(15000);
  });

  it('should reject invalid maxReconnectAttempts (NaN)', () => {
    process.env.NATS_MAX_RECONNECT_ATTEMPTS = 'abc';
    expect(() => loadNatsConfig()).toThrow('Invalid NATS configuration');
  });

  it('should reject zero maxReconnectAttempts', () => {
    process.env.NATS_MAX_RECONNECT_ATTEMPTS = '0';
    expect(() => loadNatsConfig()).toThrow('Invalid NATS configuration');
  });

  it('should reject negative timeout', () => {
    process.env.NATS_TIMEOUT = '-1';
    expect(() => loadNatsConfig()).toThrow('Invalid NATS configuration');
  });

  it('should export correct NATS topics', () => {
    expect(NATS_TOPICS.ORDERS_LEND_MARKET).toBe('orders.lend.market');
    expect(NATS_TOPICS.ORDERS_LEND_LIMIT).toBe('orders.lend.limit');
    expect(NATS_TOPICS.ORDERS_BORROW_MARKET).toBe('orders.borrow.market');
    expect(NATS_TOPICS.ORDERS_BORROW_LIMIT).toBe('orders.borrow.limit');
    expect(NATS_TOPICS.ORDERS_CANCEL).toBe('orders.cancel');
    expect(NATS_TOPICS.ORDERS_STATUS).toBe('orders.status');
    expect(NATS_TOPICS.ERRORS).toBe('errors');
  });
});

describe('redis-config', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load default Redis config', () => {
    const config = loadRedisConfig();
    expect(config.url).toBe(process.env.REDIS_URL || 'redis://localhost:6379');
    expect(config.db).toBe(0);
    expect(config.maxReconnectAttempts).toBe(10);
    expect(config.reconnectTimeWait).toBe(2000);
    expect(config.timeout).toBe(10000);
    expect(config.tls).toBe(false);
  });

  it('should load custom Redis config from env', () => {
    process.env.REDIS_URL = 'redis://custom:6379';
    process.env.REDIS_PASSWORD = 'secret';
    process.env.REDIS_DB = '5';
    process.env.REDIS_MAX_RECONNECT_ATTEMPTS = '20';
    process.env.REDIS_RECONNECT_TIME_WAIT = '5000';
    process.env.REDIS_TIMEOUT = '20000';
    process.env.REDIS_TLS = 'true';

    const config = loadRedisConfig();
    expect(config.url).toBe('redis://custom:6379');
    expect(config.password).toBe('secret');
    expect(config.db).toBe(5);
    expect(config.maxReconnectAttempts).toBe(20);
    expect(config.reconnectTimeWait).toBe(5000);
    expect(config.timeout).toBe(20000);
    expect(config.tls).toBe(true);
  });

  it('should reject invalid db number (> 15)', () => {
    process.env.REDIS_DB = '16';
    expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');
  });

  it('should reject negative db number', () => {
    process.env.REDIS_DB = '-1';
    expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');
  });

  it('should reject NaN timeout', () => {
    process.env.REDIS_TIMEOUT = 'abc';
    expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');
  });

  it('should export correct stream names', () => {
    expect(REDIS_STREAMS.SETTLEMENT_MATCHES).toBe('settlement:matches');
  });

  it('should export correct consumer group names', () => {
    expect(REDIS_CONSUMER_GROUPS.SETTLEMENT_ENGINE).toBe('settlement-engine');
    expect(REDIS_CONSUMER_GROUPS.DB_WRITER).toBe('db-writer');
  });

  it('should treat REDIS_TLS=false as false', () => {
    process.env.REDIS_TLS = 'false';
    const config = loadRedisConfig();
    expect(config.tls).toBe(false);
  });
});
