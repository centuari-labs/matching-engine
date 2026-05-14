/**
 * Fee Configuration Tests
 *
 * Tests for fee configuration loading, validation, and caching.
 * Uses jest.resetModules() + dynamic require to reset the module-level
 * cachedFeeConfig between tests.
 */

describe('Fee Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('loadFeeConfig', () => {
    it('should load default configuration values', () => {
      delete process.env.MAKER_FEE_BPS;
      delete process.env.TAKER_FEE_BPS;

      const { loadFeeConfig } = require('../config/fee-config');
      const config = loadFeeConfig();

      expect(config.makerFeeBps).toBe(10);
      expect(config.takerFeeBps).toBe(20);
    });

    it('should load configuration from environment variables', () => {
      process.env.MAKER_FEE_BPS = '50';
      process.env.TAKER_FEE_BPS = '100';

      const { loadFeeConfig } = require('../config/fee-config');
      const config = loadFeeConfig();

      expect(config.makerFeeBps).toBe(50);
      expect(config.takerFeeBps).toBe(100);
    });

    it('should accept 0 as a valid fee value', () => {
      process.env.MAKER_FEE_BPS = '0';
      process.env.TAKER_FEE_BPS = '0';

      const { loadFeeConfig } = require('../config/fee-config');
      const config = loadFeeConfig();

      expect(config.makerFeeBps).toBe(0);
      expect(config.takerFeeBps).toBe(0);
    });

    it('should accept 10000 as a valid fee value', () => {
      process.env.MAKER_FEE_BPS = '10000';
      process.env.TAKER_FEE_BPS = '10000';

      const { loadFeeConfig } = require('../config/fee-config');
      const config = loadFeeConfig();

      expect(config.makerFeeBps).toBe(10000);
      expect(config.takerFeeBps).toBe(10000);
    });

    it('should throw error when fee exceeds 10000', () => {
      process.env.MAKER_FEE_BPS = '10001';

      const { loadFeeConfig } = require('../config/fee-config');

      expect(() => loadFeeConfig()).toThrow('Invalid fee configuration');
    });

    it('should throw error when takerFeeBps exceeds 10000', () => {
      process.env.TAKER_FEE_BPS = '10001';

      const { loadFeeConfig } = require('../config/fee-config');

      expect(() => loadFeeConfig()).toThrow('Invalid fee configuration');
    });

    it('should throw error when fee is negative', () => {
      process.env.MAKER_FEE_BPS = '-1';

      const { loadFeeConfig } = require('../config/fee-config');

      expect(() => loadFeeConfig()).toThrow('Invalid fee configuration');
    });

    it('should throw error when takerFeeBps is negative', () => {
      process.env.TAKER_FEE_BPS = '-1';

      const { loadFeeConfig } = require('../config/fee-config');

      expect(() => loadFeeConfig()).toThrow('Invalid fee configuration');
    });
  });

  describe('caching', () => {
    it('should return the same reference on second call', () => {
      delete process.env.MAKER_FEE_BPS;
      delete process.env.TAKER_FEE_BPS;

      const { loadFeeConfig } = require('../config/fee-config');
      const first = loadFeeConfig();
      const second = loadFeeConfig();

      expect(first).toBe(second);
    });

    it('should not reflect env changes after initial load due to caching', () => {
      process.env.MAKER_FEE_BPS = '50';
      process.env.TAKER_FEE_BPS = '100';

      const { loadFeeConfig } = require('../config/fee-config');
      const first = loadFeeConfig();

      expect(first.makerFeeBps).toBe(50);
      expect(first.takerFeeBps).toBe(100);

      // Change env vars after initial load
      process.env.MAKER_FEE_BPS = '200';
      process.env.TAKER_FEE_BPS = '300';

      const second = loadFeeConfig();

      // Should still return cached values
      expect(second.makerFeeBps).toBe(50);
      expect(second.takerFeeBps).toBe(100);
      expect(first).toBe(second);
    });
  });
});
