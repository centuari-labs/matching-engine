/**
 * Buffer Configuration Tests
 *
 * Tests for buffer config loading, env var overrides, and validation.
 */

import { loadBufferConfig } from '../config/buffer-config';

describe('Buffer Configuration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('should load default values when no env vars are set', () => {
    delete process.env.BUFFER_RETRY_INITIAL_DELAY_MS;
    delete process.env.BUFFER_RETRY_MAX_DELAY_MS;
    delete process.env.BUFFER_RETRY_BACKOFF_MULTIPLIER;
    delete process.env.BUFFER_WARNING_THRESHOLDS;
    delete process.env.BUFFER_DISK_SPILL_THRESHOLD;
    delete process.env.BUFFER_DISK_SPILL_DIR;

    const config = loadBufferConfig();

    expect(config.retryInitialDelayMs).toBe(1000);
    expect(config.retryMaxDelayMs).toBe(30000);
    expect(config.retryBackoffMultiplier).toBe(2);
    expect(config.warningThresholds).toEqual([1000, 5000, 10000]);
    expect(config.diskSpillThreshold).toBe(5000);
    expect(config.diskSpillDir).toBe('./unpublished-matches');
  });

  it('should override values from environment variables', () => {
    process.env.BUFFER_RETRY_INITIAL_DELAY_MS = '500';
    process.env.BUFFER_RETRY_MAX_DELAY_MS = '60000';
    process.env.BUFFER_RETRY_BACKOFF_MULTIPLIER = '3';
    process.env.BUFFER_WARNING_THRESHOLDS = '500,2000,8000';
    process.env.BUFFER_DISK_SPILL_THRESHOLD = '3000';
    process.env.BUFFER_DISK_SPILL_DIR = '/tmp/spill';

    const config = loadBufferConfig();

    expect(config.retryInitialDelayMs).toBe(500);
    expect(config.retryMaxDelayMs).toBe(60000);
    expect(config.retryBackoffMultiplier).toBe(3);
    expect(config.warningThresholds).toEqual([500, 2000, 8000]);
    expect(config.diskSpillThreshold).toBe(3000);
    expect(config.diskSpillDir).toBe('/tmp/spill');
  });

  it('should parse comma-separated thresholds with spaces', () => {
    process.env.BUFFER_WARNING_THRESHOLDS = ' 100 , 200 , 300 ';

    const config = loadBufferConfig();

    expect(config.warningThresholds).toEqual([100, 200, 300]);
  });

  it('should reject negative retry delay', () => {
    process.env.BUFFER_RETRY_INITIAL_DELAY_MS = '-1';

    expect(() => loadBufferConfig()).toThrow('Invalid buffer configuration');
  });

  it('should reject zero max delay', () => {
    process.env.BUFFER_RETRY_MAX_DELAY_MS = '0';

    expect(() => loadBufferConfig()).toThrow('Invalid buffer configuration');
  });

  it('should reject negative backoff multiplier', () => {
    process.env.BUFFER_RETRY_BACKOFF_MULTIPLIER = '-1';

    expect(() => loadBufferConfig()).toThrow('Invalid buffer configuration');
  });

  it('should fall back to default for empty disk spill dir', () => {
    process.env.BUFFER_DISK_SPILL_DIR = '';

    const config = loadBufferConfig();
    expect(config.diskSpillDir).toBe('./unpublished-matches');
  });
});
