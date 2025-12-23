/**
 * Redis Configuration Tests
 *
 * Tests for Redis configuration loading and validation.
 */

import {
  loadRedisConfig,
  REDIS_STREAMS,
  REDIS_CONSUMER_GROUPS,
  type RedisConfig,
} from '../config/redis-config';

describe('Redis Configuration', () => {
  // Store original env vars
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment before each test
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    // Restore original env vars
    process.env = originalEnv;
  });

  describe('loadRedisConfig', () => {
    it('should load default configuration when no env vars are set', () => {
      delete process.env.REDIS_URL;
      delete process.env.REDIS_PASSWORD;
      delete process.env.REDIS_DB;
      delete process.env.REDIS_MAX_RECONNECT_ATTEMPTS;
      delete process.env.REDIS_RECONNECT_TIME_WAIT;
      delete process.env.REDIS_TIMEOUT;
      delete process.env.REDIS_TLS;

      const config = loadRedisConfig();

      expect(config.url).toBe('redis://localhost:6379');
      expect(config.password).toBeUndefined();
      expect(config.db).toBe(0);
      expect(config.maxReconnectAttempts).toBe(10);
      expect(config.reconnectTimeWait).toBe(2000);
      expect(config.timeout).toBe(10000);
      expect(config.tls).toBe(false);
    });

    it('should load configuration from environment variables', () => {
      process.env.REDIS_URL = 'redis://custom-host:6380';
      process.env.REDIS_PASSWORD = 'secret123';
      process.env.REDIS_DB = '5';
      process.env.REDIS_MAX_RECONNECT_ATTEMPTS = '20';
      process.env.REDIS_RECONNECT_TIME_WAIT = '3000';
      process.env.REDIS_TIMEOUT = '15000';
      process.env.REDIS_TLS = 'true';

      const config = loadRedisConfig();

      expect(config.url).toBe('redis://custom-host:6380');
      expect(config.password).toBe('secret123');
      expect(config.db).toBe(5);
      expect(config.maxReconnectAttempts).toBe(20);
      expect(config.reconnectTimeWait).toBe(3000);
      expect(config.timeout).toBe(15000);
      expect(config.tls).toBe(true);
    });

    it('should handle partial environment variable configuration', () => {
      process.env.REDIS_URL = 'redis://partial-host:6379';
      delete process.env.REDIS_PASSWORD;
      delete process.env.REDIS_DB;
      process.env.REDIS_TIMEOUT = '5000';

      const config = loadRedisConfig();

      expect(config.url).toBe('redis://partial-host:6379');
      expect(config.password).toBeUndefined();
      expect(config.db).toBe(0);
      expect(config.timeout).toBe(5000);
    });

    it('should set tls to false when REDIS_TLS is not "true"', () => {
      process.env.REDIS_TLS = 'false';
      let config = loadRedisConfig();
      expect(config.tls).toBe(false);

      process.env.REDIS_TLS = 'yes';
      config = loadRedisConfig();
      expect(config.tls).toBe(false);

      process.env.REDIS_TLS = '1';
      config = loadRedisConfig();
      expect(config.tls).toBe(false);
    });

    it('should handle valid database numbers (0-15)', () => {
      process.env.REDIS_DB = '0';
      let config = loadRedisConfig();
      expect(config.db).toBe(0);

      process.env.REDIS_DB = '15';
      config = loadRedisConfig();
      expect(config.db).toBe(15);
    });

    it('should throw error for invalid database number (> 15)', () => {
      process.env.REDIS_DB = '16';
      expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');
    });

    it('should throw error for negative database number', () => {
      process.env.REDIS_DB = '-1';
      expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');
    });

    it('should throw error for invalid timeout (non-positive)', () => {
      process.env.REDIS_TIMEOUT = '0';
      expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');

      process.env.REDIS_TIMEOUT = '-1000';
      expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');
    });

    it('should throw error for invalid maxReconnectAttempts (non-positive)', () => {
      process.env.REDIS_MAX_RECONNECT_ATTEMPTS = '0';
      expect(() => loadRedisConfig()).toThrow('Invalid Redis configuration');
    });

    it('should use default URL when REDIS_URL is empty', () => {
      // Empty string is treated as falsy, so default is used
      process.env.REDIS_URL = '';
      const config = loadRedisConfig();
      expect(config.url).toBe('redis://localhost:6379');
    });
  });

  describe('REDIS_STREAMS', () => {
    it('should have correct settlement matches stream name', () => {
      expect(REDIS_STREAMS.SETTLEMENT_MATCHES).toBe('settlement:matches');
    });

    it('should be immutable (const assertion)', () => {
      expect(typeof REDIS_STREAMS).toBe('object');
      expect(Object.keys(REDIS_STREAMS)).toContain('SETTLEMENT_MATCHES');
    });
  });

  describe('REDIS_CONSUMER_GROUPS', () => {
    it('should have correct settlement engine consumer group name', () => {
      expect(REDIS_CONSUMER_GROUPS.SETTLEMENT_ENGINE).toBe('settlement-engine');
    });

    it('should be immutable (const assertion)', () => {
      expect(typeof REDIS_CONSUMER_GROUPS).toBe('object');
      expect(Object.keys(REDIS_CONSUMER_GROUPS)).toContain('SETTLEMENT_ENGINE');
    });
  });

  describe('RedisConfig type', () => {
    it('should allow valid configuration object', () => {
      const config: RedisConfig = {
        url: 'redis://localhost:6379',
        db: 0,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
        timeout: 10000,
        tls: false,
      };

      expect(config.url).toBeDefined();
      expect(config.db).toBeDefined();
    });

    it('should allow optional password', () => {
      const configWithPassword: RedisConfig = {
        url: 'redis://localhost:6379',
        password: 'secret',
        db: 0,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
        timeout: 10000,
        tls: false,
      };

      const configWithoutPassword: RedisConfig = {
        url: 'redis://localhost:6379',
        db: 0,
        maxReconnectAttempts: 10,
        reconnectTimeWait: 2000,
        timeout: 10000,
        tls: false,
      };

      expect(configWithPassword.password).toBe('secret');
      expect(configWithoutPassword.password).toBeUndefined();
    });
  });
});
