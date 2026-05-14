/**
 * Snapshot Integration Tests
 *
 * Tests for snapshot mechanism integration with MatchingEngine,
 * including periodic snapshots, shutdown snapshots, and state recovery.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { MatchingEngine } from '../core/matching-engine';
import { SnapshotService } from '../services/snapshot-service';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  DEFAULT_LOAN_TOKEN,
  DEFAULT_MATURITY,
  marketsFromMaturities,
} from './factories/order-factory';

describe('Snapshot Integration', () => {
  const testSnapshotDir = path.join(__dirname, '../../test-snapshots-integration');

  async function cleanupSnapshotDir(): Promise<void> {
    try {
      await fs.rm(testSnapshotDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  }

  beforeAll(async () => {
    await cleanupSnapshotDir();
  });

  afterAll(async () => {
    await cleanupSnapshotDir();
  });

  beforeEach(async () => {
    await cleanupSnapshotDir();
  });

  describe('State Persistence and Recovery', () => {
    it('should persist state after order submission', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine1 = new MatchingEngine(undefined, snapshotService);

      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 500,
      });

      engine1.submitOrder(lendOrder);

      // Wait a bit for async snapshot (if triggered)
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create new engine and restore
      const engine2 = new MatchingEngine(undefined, snapshotService);
      await engine2.restoreFromSnapshot();

      expect(engine2.hasOrder(lendOrder.orderId)).toBe(true);
    });

    it('should persist state after order cancellation', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine1 = new MatchingEngine(undefined, snapshotService);

      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 500,
      });

      engine1.submitOrder(lendOrder);
      engine1.cancelOrder(lendOrder.orderId, walletAddress1);

      // Wait for async snapshot
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Create new engine and restore
      const engine2 = new MatchingEngine(undefined, snapshotService);
      await engine2.restoreFromSnapshot();

      // Order should not exist after cancellation
      expect(engine2.hasOrder(lendOrder.orderId)).toBe(false);
    });

    it('should persist matches after order matching', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine1 = new MatchingEngine(undefined, snapshotService);

      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const walletAddress2 = '0x2222222222222222222222222222222222222222';

      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 500,
      });

      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 600,
      });

      engine1.submitOrder(lendOrder);
      const result = engine1.submitOrder(borrowOrder);

      expect(result.matches).toHaveLength(1);

      // Manually save snapshot (matches are in execution engine)
      await engine1.saveSnapshot();

      // Verify snapshot was persisted before restore (fails fast if save threw silently)
      const metadataBeforeRestore = await snapshotService.getSnapshotMetadata();
      expect(metadataBeforeRestore).not.toBeNull();
      expect(metadataBeforeRestore!.matchCount).toBeGreaterThan(0);

      // Create new engine and restore
      const engine2 = new MatchingEngine(undefined, snapshotService);
      const restored = await engine2.restoreFromSnapshot();

      expect(restored).toBe(true);
      const matches = engine2.getMatches(result.matches[0].lendOrderId);
      expect(matches.length).toBeGreaterThan(0);
    });

    it('should restore order book structure correctly', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine1 = new MatchingEngine(undefined, snapshotService);

      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const walletAddress2 = '0x2222222222222222222222222222222222222222';

      // Add multiple orders that won't match (borrow rate < lend rates)
      // This ensures all orders remain in the book after submission
      const lendOrder1 = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 600, // Lender wants at least 600
      });
      const lendOrder2 = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 700, // Lender wants at least 700
        timestamp: Date.now() + 1,
      });
      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 500, // Borrower willing to pay at most 500
      });

      engine1.submitOrder(lendOrder1);
      engine1.submitOrder(lendOrder2);
      engine1.submitOrder(borrowOrder);

      // Wait for any async snapshot operations to complete
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Verify orders are in engine1 before saving
      expect(engine1.hasOrder(lendOrder1.orderId)).toBe(true);
      expect(engine1.hasOrder(lendOrder2.orderId)).toBe(true);
      expect(engine1.hasOrder(borrowOrder.orderId)).toBe(true);

      await engine1.saveSnapshot();

      // Verify snapshot was saved with orders
      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.orders.length).toBe(3);

      // Create new engine and restore
      const engine2 = new MatchingEngine(undefined, snapshotService);
      const restored = await engine2.restoreFromSnapshot();
      expect(restored).toBe(true);

      // Verify orders exist in engine2 after restore (checks index)
      expect(engine2.hasOrder(lendOrder1.orderId)).toBe(true);
      expect(engine2.hasOrder(lendOrder2.orderId)).toBe(true);
      expect(engine2.hasOrder(borrowOrder.orderId)).toBe(true);

      // Verify order book structure (checks trees)
      const orderBook = engine2.getOrderBook(DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY, 10);
      
      expect(orderBook.lendOrders.length).toBeGreaterThan(0);
      expect(orderBook.borrowOrders.length).toBeGreaterThan(0);

      // Verify orders are in correct priority order
      if (orderBook.lendOrders.length > 1) {
        // Lower rate should come first for lend orders
        expect(orderBook.lendOrders[0].rate).toBeLessThanOrEqual(
          orderBook.lendOrders[1].rate || Infinity
        );
      }
    });

    it('should handle partial fills correctly in snapshot', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine1 = new MatchingEngine(undefined, snapshotService);

      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const walletAddress2 = '0x2222222222222222222222222222222222222222';

      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 500,
        originalAmount: '2000000',
        remainingAmount: '2000000',
      });

      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 600,
        originalAmount: '1000000',
        remainingAmount: '1000000',
      });

      engine1.submitOrder(lendOrder);
      engine1.submitOrder(borrowOrder);

      await engine1.saveSnapshot();

      // Create new engine and restore
      const engine2 = new MatchingEngine(undefined, snapshotService);
      await engine2.restoreFromSnapshot();

      // Lend order should be partially filled
      const restoredLendOrder = engine2.getOrderStatus(lendOrder.orderId);
      expect(restoredLendOrder).not.toBeNull();

      // Verify remaining amount
      const orderBook = engine2.getOrderBook(DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY, 10);
      const restoredOrder = orderBook.lendOrders.find((o) => o.orderId === lendOrder.orderId);
      expect(restoredOrder).toBeDefined();
      expect(parseInt(restoredOrder!.amount, 10)).toBeLessThan(2000000);
    });
  });

  describe('Error Handling', () => {
    it('should handle missing snapshot gracefully', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine = new MatchingEngine(undefined, snapshotService);

      const restored = await engine.restoreFromSnapshot();
      expect(restored).toBe(false);
    });

    it('should handle corrupted snapshot file gracefully', async () => {
      const latestPath = path.join(testSnapshotDir, 'latest.json');
      await fs.mkdir(testSnapshotDir, { recursive: true });
      await fs.writeFile(latestPath, 'invalid json', 'utf-8');

      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine = new MatchingEngine(undefined, snapshotService);

      const restored = await engine.restoreFromSnapshot();
      expect(restored).toBe(false);
    });

    it('should continue operation if snapshot save fails', async () => {
      // Create service with invalid directory
      const invalidService = new SnapshotService('/invalid/path', null, false);
      const engine = new MatchingEngine(undefined, invalidService);

      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 500,
      });

      // Should not throw
      engine.submitOrder(lendOrder);
      await expect(engine.saveSnapshot()).resolves.not.toThrow();

      // Engine should still work
      expect(engine.hasOrder(lendOrder.orderId)).toBe(true);
    });
  });

  describe('Snapshot Metadata', () => {
    it('should save and retrieve snapshot metadata', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const engine = new MatchingEngine(undefined, snapshotService);

      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        markets: marketsFromMaturities([DEFAULT_MATURITY]),
        rate: 500,
      });

      engine.submitOrder(lendOrder);
      await engine.saveSnapshot();

      const metadata = await snapshotService.getSnapshotMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.orderCount).toBe(1);
      expect(metadata!.matchCount).toBe(0);
      expect(metadata!.timestamp).toBeGreaterThan(0);
      expect(metadata!.version).toBe('1.0.0');
    });

    it('should return null metadata if no snapshot exists', async () => {
      const snapshotService = new SnapshotService(testSnapshotDir, null, false);
      const metadata = await snapshotService.getSnapshotMetadata();
      expect(metadata).toBeNull();
    });
  });
});
