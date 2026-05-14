/**
 * Retry Service Tests
 *
 * Tests for exponential backoff scheduling, timer cleanup,
 * concurrency guards, and shutdown behavior.
 */

import { RetryService } from '../services/retry-service';
import { ExecutionEngine } from '../core/execution-engine';
import { DiskPersistenceService } from '../services/disk-persistence-service';
import type { BufferConfig } from '../config/buffer-config';
import { createMatch } from './factories/match-factory';

jest.useFakeTimers();

const DEFAULT_CONFIG: BufferConfig = {
  retryInitialDelayMs: 1000,
  retryMaxDelayMs: 30000,
  retryBackoffMultiplier: 2,
  warningThresholds: [1000, 5000, 10000],
  diskSpillThreshold: 5000,
  diskSpillDir: '/tmp/test-spill',
  bufferMaxSize: 10000,
};

describe('RetryService', () => {
  let retryService: RetryService;
  let mockDiskService: jest.Mocked<DiskPersistenceService>;
  let executionEngine: ExecutionEngine;

  beforeEach(() => {
    mockDiskService = {
      flush: jest.fn().mockResolvedValue(undefined),
      load: jest.fn().mockResolvedValue([]),
      exists: jest.fn().mockResolvedValue(false),
    } as unknown as jest.Mocked<DiskPersistenceService>;

    retryService = new RetryService(mockDiskService, DEFAULT_CONFIG);
    executionEngine = new ExecutionEngine(undefined, retryService);
    retryService.setExecutionEngine(executionEngine);
  });

  afterEach(() => {
    retryService.shutdown();
    jest.clearAllTimers();
  });

  describe('onPublishFailed', () => {
    it('should schedule a retry with initial delay', () => {
      const match = createMatch();

      retryService.onPublishFailed(match);

      expect(retryService.pendingRetryCount).toBe(1);
    });

    it('should not schedule duplicate retries for the same match', () => {
      const match = createMatch();

      retryService.onPublishFailed(match);
      retryService.onPublishFailed(match);

      expect(retryService.pendingRetryCount).toBe(1);
    });

    it('should schedule retries for different matches independently', () => {
      const match1 = createMatch();
      const match2 = createMatch();

      retryService.onPublishFailed(match1);
      retryService.onPublishFailed(match2);

      expect(retryService.pendingRetryCount).toBe(2);
    });

    it('should call retryPublish on the execution engine after delay', () => {
      const match = createMatch();
      // Store match in engine so retryPublish can find it
      executionEngine.recordMatch({
        marketId: match.marketId,
        lendOrderId: match.lendOrderId,
        borrowOrderId: match.borrowOrderId,
        lenderWallet: match.lenderWallet,
        borrowerWallet: match.borrowerWallet,
        matchedAmount: match.matchedAmount,
        lendRemainingAfter: '0',
        borrowRemainingAfter: '0',
        rate: match.rate,
        loanToken: match.loanToken,
        maturity: match.maturity,
        borrowerIsTaker: match.borrowerIsTaker,
        makerFeeAmount: match.makerFeeAmount,
        takerFeeAmount: match.takerFeeAmount,
        lenderSettlementFeeAmount: match.lenderSettlementFeeAmount,
        borrowerSettlementFeeAmount: match.borrowerSettlementFeeAmount,
      });

      const spy = jest.spyOn(executionEngine, 'retryPublish');
      retryService.onPublishFailed(match);

      // Before delay: not called
      expect(spy).not.toHaveBeenCalled();

      // After delay: called
      jest.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledWith(match.matchId);
    });

    it('should apply exponential backoff on successive failures', () => {
      const match = createMatch();
      const spy = jest.spyOn(executionEngine, 'retryPublish');

      // First failure: 1s delay
      retryService.onPublishFailed(match);
      jest.advanceTimersByTime(999);
      expect(spy).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(spy).toHaveBeenCalledTimes(1);

      // Second failure: 2s delay
      retryService.onPublishFailed(match);
      jest.advanceTimersByTime(1999);
      expect(spy).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(spy).toHaveBeenCalledTimes(2);

      // Third failure: 4s delay
      retryService.onPublishFailed(match);
      jest.advanceTimersByTime(3999);
      expect(spy).toHaveBeenCalledTimes(2);
      jest.advanceTimersByTime(1);
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('should cap backoff delay at retryMaxDelayMs', () => {
      const config: BufferConfig = {
        ...DEFAULT_CONFIG,
        retryInitialDelayMs: 10000,
        retryMaxDelayMs: 30000,
        retryBackoffMultiplier: 10,
      };
      retryService.shutdown();
      retryService = new RetryService(mockDiskService, config);
      retryService.setExecutionEngine(executionEngine);

      const match = createMatch();
      const spy = jest.spyOn(executionEngine, 'retryPublish');

      // First failure: 10s
      retryService.onPublishFailed(match);
      jest.advanceTimersByTime(10000);
      expect(spy).toHaveBeenCalledTimes(1);

      // Second failure: would be 100s but capped at 30s
      retryService.onPublishFailed(match);
      jest.advanceTimersByTime(30000);
      expect(spy).toHaveBeenCalledTimes(2);
    });
  });

  describe('onPublishSucceeded', () => {
    it('should clear pending retry timer', () => {
      const match = createMatch();

      retryService.onPublishFailed(match);
      expect(retryService.pendingRetryCount).toBe(1);

      retryService.onPublishSucceeded(match.matchId);
      expect(retryService.pendingRetryCount).toBe(0);
    });

    it('should be safe to call for unknown matchId', () => {
      expect(() => retryService.onPublishSucceeded('unknown-id')).not.toThrow();
    });
  });

  describe('onThresholdBreached', () => {
    it('should not throw', () => {
      expect(() => retryService.onThresholdBreached(1500, 1000)).not.toThrow();
    });
  });

  describe('onDiskSpillNeeded', () => {
    it('should delegate to disk persistence service', () => {
      const matches = [createMatch(), createMatch()];

      retryService.onDiskSpillNeeded(matches);

      expect(mockDiskService.flush).toHaveBeenCalledWith(matches);
    });
  });

  describe('shutdown', () => {
    it('should clear all pending retry timers', () => {
      retryService.onPublishFailed(createMatch());
      retryService.onPublishFailed(createMatch());
      retryService.onPublishFailed(createMatch());

      expect(retryService.pendingRetryCount).toBe(3);

      retryService.shutdown();

      expect(retryService.pendingRetryCount).toBe(0);
    });
  });
});
