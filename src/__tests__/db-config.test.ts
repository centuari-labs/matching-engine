/**
 * Database Configuration Tests
 *
 * Tests for database configuration loading and validation.
 */

describe('Database Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('loadDbConfig', () => {
    it('should load default configuration values with DB_URL set', () => {
      process.env.DB_URL = 'postgres://user:pass@localhost:5432/testdb';
      delete process.env.DB_MAX_POOL_SIZE;
      delete process.env.DB_IDLE_TIMEOUT_MS;

      const { loadDbConfig } = require('../config/db-config');
      const config = loadDbConfig();

      expect(config.url).toBe('postgres://user:pass@localhost:5432/testdb');
      expect(config.maxPoolSize).toBe(10);
      expect(config.idleTimeoutMillis).toBe(30000);
    });

    it('should load configuration from environment variables', () => {
      process.env.DB_URL = 'postgres://admin:secret@db-host:5433/production';
      process.env.DB_MAX_POOL_SIZE = '25';
      process.env.DB_IDLE_TIMEOUT_MS = '60000';

      const { loadDbConfig } = require('../config/db-config');
      const config = loadDbConfig();

      expect(config.url).toBe('postgres://admin:secret@db-host:5433/production');
      expect(config.maxPoolSize).toBe(25);
      expect(config.idleTimeoutMillis).toBe(60000);
    });

    it('should throw error when DB_URL is empty', () => {
      process.env.DB_URL = '';
      delete process.env.DB_MAX_POOL_SIZE;
      delete process.env.DB_IDLE_TIMEOUT_MS;

      const { loadDbConfig } = require('../config/db-config');

      expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
    });

    it('should throw error when DB_URL resolves to empty after dotenv', () => {
      // Force DB_URL to empty string; dotenv won't overwrite existing vars
      process.env.DB_URL = '';

      const { loadDbConfig } = require('../config/db-config');

      expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
    });

    it('should throw error when maxPoolSize is 0', () => {
      process.env.DB_URL = 'postgres://user:pass@localhost:5432/testdb';
      process.env.DB_MAX_POOL_SIZE = '0';

      const { loadDbConfig } = require('../config/db-config');

      expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
    });

    it('should throw error when idleTimeoutMillis is -1', () => {
      process.env.DB_URL = 'postgres://user:pass@localhost:5432/testdb';
      process.env.DB_IDLE_TIMEOUT_MS = '-1';

      const { loadDbConfig } = require('../config/db-config');

      expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
    });

    it('should accept idleTimeoutMillis of 0', () => {
      process.env.DB_URL = 'postgres://user:pass@localhost:5432/testdb';
      process.env.DB_IDLE_TIMEOUT_MS = '0';

      const { loadDbConfig } = require('../config/db-config');
      const config = loadDbConfig();

      expect(config.idleTimeoutMillis).toBe(0);
    });

    it('should throw error when maxPoolSize is not a number', () => {
      process.env.DB_URL = 'postgres://user:pass@localhost:5432/testdb';
      process.env.DB_MAX_POOL_SIZE = 'abc';

      const { loadDbConfig } = require('../config/db-config');

      expect(() => loadDbConfig()).toThrow('Invalid DB configuration');
    });
  });
});
