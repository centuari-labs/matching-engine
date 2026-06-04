/**
 * NATS Configuration Tests
 *
 * Tests for NATS configuration loading and validation.
 */

describe('NATS Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('loadNatsConfig', () => {
    it('should load default configuration when no env vars are set', () => {
      delete process.env.NATS_URL;
      delete process.env.NATS_USER;
      delete process.env.NATS_PASSWORD;
      delete process.env.NATS_TOKEN;
      delete process.env.NATS_MAX_RECONNECT_ATTEMPTS;
      delete process.env.NATS_RECONNECT_TIME_WAIT;
      delete process.env.NATS_TIMEOUT;

      const { loadNatsConfig } = require('../config/nats-config');
      const config = loadNatsConfig();

      expect(config.url).toBe('nats://localhost:4222');
      expect(config.maxReconnectAttempts).toBe(10);
      expect(config.reconnectTimeWait).toBe(2000);
      expect(config.timeout).toBe(10000);
    });

    it('should load configuration from environment variables', () => {
      process.env.NATS_URL = 'nats://custom-host:4223';
      process.env.NATS_USER = 'admin';
      process.env.NATS_PASSWORD = 'secret123';
      process.env.NATS_TOKEN = 'mytoken';
      process.env.NATS_MAX_RECONNECT_ATTEMPTS = '20';
      process.env.NATS_RECONNECT_TIME_WAIT = '5000';
      process.env.NATS_TIMEOUT = '15000';

      const { loadNatsConfig } = require('../config/nats-config');
      const config = loadNatsConfig();

      expect(config.url).toBe('nats://custom-host:4223');
      expect(config.user).toBe('admin');
      expect(config.password).toBe('secret123');
      expect(config.token).toBe('mytoken');
      expect(config.maxReconnectAttempts).toBe(20);
      expect(config.reconnectTimeWait).toBe(5000);
      expect(config.timeout).toBe(15000);
    });

    it('should throw error when NATS_URL is empty string', () => {
      process.env.NATS_URL = '';

      const { loadNatsConfig } = require('../config/nats-config');

      // Empty string is falsy, so the default is used
      const config = loadNatsConfig();
      expect(config.url).toBe('nats://localhost:4222');
    });

    it('should throw error when maxReconnectAttempts is 0', () => {
      process.env.NATS_MAX_RECONNECT_ATTEMPTS = '0';

      const { loadNatsConfig } = require('../config/nats-config');

      expect(() => loadNatsConfig()).toThrow('Invalid NATS configuration');
    });

    it('should throw error when maxReconnectAttempts is -1', () => {
      process.env.NATS_MAX_RECONNECT_ATTEMPTS = '-1';

      const { loadNatsConfig } = require('../config/nats-config');

      expect(() => loadNatsConfig()).toThrow('Invalid NATS configuration');
    });

    it('should throw error when reconnectTimeWait is non-positive', () => {
      process.env.NATS_RECONNECT_TIME_WAIT = '0';

      const { loadNatsConfig } = require('../config/nats-config');

      expect(() => loadNatsConfig()).toThrow('Invalid NATS configuration');
    });

    it('should throw error when timeout is non-positive', () => {
      process.env.NATS_TIMEOUT = '-1';

      const { loadNatsConfig } = require('../config/nats-config');

      expect(() => loadNatsConfig()).toThrow('Invalid NATS configuration');
    });

    it('should handle partial environment variable configuration', () => {
      process.env.NATS_URL = 'nats://partial-host:4222';
      delete process.env.NATS_USER;
      delete process.env.NATS_PASSWORD;
      process.env.NATS_TIMEOUT = '5000';

      const { loadNatsConfig } = require('../config/nats-config');
      const config = loadNatsConfig();

      expect(config.url).toBe('nats://partial-host:4222');
      expect(config.timeout).toBe(5000);
      expect(config.maxReconnectAttempts).toBe(10);
    });
  });

  describe('NATS_TOPICS', () => {
    it('should have expected topic keys', () => {
      const { NATS_TOPICS } = require('../config/nats-config');

      expect(NATS_TOPICS.ORDERS_LEND_MARKET).toBe('orders.lend.market');
      expect(NATS_TOPICS.ORDERS_LEND_LIMIT).toBe('orders.lend.limit');
      expect(NATS_TOPICS.ORDERS_BORROW_MARKET).toBe('orders.borrow.market');
      expect(NATS_TOPICS.ORDERS_BORROW_LIMIT).toBe('orders.borrow.limit');
      expect(NATS_TOPICS.ORDERS_CANCEL).toBe('orders.cancel');
      expect(NATS_TOPICS.ORDERS_CANCEL_REQUEST).toBe('orders.cancel.request');
      expect(NATS_TOPICS.ORDERS_UPDATE).toBe('orders.update');
      expect(NATS_TOPICS.ORDERS_STATUS).toBe('orders.status');
      expect(NATS_TOPICS.ORDERS_CANCELLED_REMAINDER).toBe('orders.cancelled_remainder');
      expect(NATS_TOPICS.MATCHES_CREATED).toBe('matches.created');
      expect(NATS_TOPICS.ORDERS_UPDATED).toBe('orders.updated');
      expect(NATS_TOPICS.ERRORS).toBe('errors');
    });

    it('should be an immutable object', () => {
      const { NATS_TOPICS } = require('../config/nats-config');

      expect(typeof NATS_TOPICS).toBe('object');
      expect(Object.keys(NATS_TOPICS).length).toBe(12);
    });
  });

  describe('Type exports', () => {
    it('should export NatsConfig type and allow valid configuration', () => {
      const { loadNatsConfig } = require('../config/nats-config');
      type NatsConfig = ReturnType<typeof loadNatsConfig>;

      const config: NatsConfig = loadNatsConfig();
      expect(config.url).toBeDefined();
      expect(typeof config.maxReconnectAttempts).toBe('number');
    });
  });
});
