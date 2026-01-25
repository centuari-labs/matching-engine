/**
 * Snapshot Service Tests
 *
 * Tests for SnapshotService save/load functionality, filesystem operations,
 * and integration with OrderBook and ExecutionEngine.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SnapshotService } from '../services/snapshot-service';
import { OrderBook } from '../core/order-book';
import { ExecutionEngine } from '../core/execution-engine';
import { MatchingEngine } from '../core/matching-engine';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  DEFAULT_LOAN_TOKEN,
  DEFAULT_MATURITY,
} from './factories/order-factory';
import { generateOrderId } from '../utils/helpers';

describe('SnapshotService', () => {
  const testSnapshotDir = path.join(__dirname, '../../test-snapshots');
  let snapshotService: SnapshotService;
  let orderBook: OrderBook;
  let executionEngine: ExecutionEngine;

  // Clean up test snapshot directory before and after tests
  async function cleanupSnapshotDir(): Promise<void> {
    try {
      await fs.rm(testSnapshotDir, { recursive: true, force: true });
    } catch {
      // Ignore errors if directory doesn't exist
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
    snapshotService = new SnapshotService(testSnapshotDir, null, false);
    orderBook = new OrderBook();
    executionEngine = new ExecutionEngine();
  });

  describe('saveSnapshot', () => {
    it('should save empty order book and execution engine', async () => {
      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.orders).toHaveLength(0);
      expect(snapshotData!.matches).toHaveLength(0);
      expect(snapshotData!.metadata.orderCount).toBe(0);
      expect(snapshotData!.metadata.matchCount).toBe(0);
    });

    it('should save orders with their current state', async () => {
      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const walletAddress2 = '0x2222222222222222222222222222222222222222';

      // Add orders to order book
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500,
      });
      orderBook.addOrder(lendOrder);

      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 600,
      });
      orderBook.addOrder(borrowOrder);

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.orders).toHaveLength(2);
      expect(snapshotData!.orders[0].orderId).toBe(lendOrder.orderId);
      expect(snapshotData!.orders[1].orderId).toBe(borrowOrder.orderId);
    });

    it('should save orders with updated remaining amounts', async () => {
      const walletAddress1 = '0x1111111111111111111111111111111111111111';

      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500,
      });
      orderBook.addOrder(lendOrder);

      // Update order amount (simulate partial fill)
      orderBook.updateOrderAmount(lendOrder.orderId, '500000');

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.orders).toHaveLength(1);
      expect(snapshotData!.orders[0].remainingAmount).toBe('500000');
    });

    it('should save unpublished matches', async () => {
      const lendOrderId = generateOrderId();
      const borrowOrderId = generateOrderId();

      // Record a match
      executionEngine.recordMatch({
        lendOrderId,
        borrowOrderId,
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.matches).toHaveLength(1);
      expect(snapshotData!.matches[0].lendOrderId).toBe(lendOrderId);
      expect(snapshotData!.matches[0].borrowOrderId).toBe(borrowOrderId);
    });

    it('should create snapshot directory if it does not exist', async () => {
      const newDir = path.join(testSnapshotDir, 'nested', 'directory');
      const service = new SnapshotService(newDir, null, false);

      await service.saveSnapshot(orderBook, executionEngine);

      // Directory should exist
      const dirExists = await fs
        .access(newDir)
        .then(() => true)
        .catch(() => false);
      expect(dirExists).toBe(true);

      // Clean up
      await fs.rm(path.join(testSnapshotDir, 'nested'), { recursive: true, force: true });
    });

    it('should rotate backup snapshot on save', async () => {
      // Save first snapshot
      await snapshotService.saveSnapshot(orderBook, executionEngine);

      // Add an order and save again
      const lendOrder = createLendLimitOrder({
        walletAddress: '0x1111111111111111111111111111111111111111',
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500,
      });
      orderBook.addOrder(lendOrder);
      await snapshotService.saveSnapshot(orderBook, executionEngine);

      // Both latest and backup should exist
      const latestPath = path.join(testSnapshotDir, 'latest.json');
      const backupPath = path.join(testSnapshotDir, 'backup.json');

      const latestExists = await fs
        .access(latestPath)
        .then(() => true)
        .catch(() => false);
      const backupExists = await fs
        .access(backupPath)
        .then(() => true)
        .catch(() => false);

      expect(latestExists).toBe(true);
      expect(backupExists).toBe(true);

      // Latest should have 1 order, backup should have 0
      const latestData = JSON.parse(await fs.readFile(latestPath, 'utf-8'));
      const backupData = JSON.parse(await fs.readFile(backupPath, 'utf-8'));

      expect(latestData.orders).toHaveLength(1);
      expect(backupData.orders).toHaveLength(0);
    });

    it('should save metadata file', async () => {
      const lendOrder = createLendLimitOrder({
        walletAddress: '0x1111111111111111111111111111111111111111',
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500,
      });
      orderBook.addOrder(lendOrder);

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const metadata = await snapshotService.getSnapshotMetadata();
      expect(metadata).not.toBeNull();
      expect(metadata!.orderCount).toBe(1);
      expect(metadata!.matchCount).toBe(0);
      expect(metadata!.timestamp).toBeGreaterThan(0);
      expect(metadata!.version).toBe('1.0.0');
    });
  });

  describe('loadSnapshot', () => {
    it('should return null if no snapshot exists', async () => {
      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).toBeNull();
    });

    it('should load snapshot with orders', async () => {
      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const walletAddress2 = '0x2222222222222222222222222222222222222222';

      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500,
      });
      orderBook.addOrder(lendOrder);

      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 600,
      });
      orderBook.addOrder(borrowOrder);

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      // Create new service instance to test loading
      const newService = new SnapshotService(testSnapshotDir, null, false);
      const snapshotData = await newService.loadSnapshot();

      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.orders).toHaveLength(2);
      expect(snapshotData!.orders.find((o) => o.orderId === lendOrder.orderId)).toBeDefined();
      expect(snapshotData!.orders.find((o) => o.orderId === borrowOrder.orderId)).toBeDefined();
    });

    it('should load snapshot with matches', async () => {
      const lendOrderId = generateOrderId();
      const borrowOrderId = generateOrderId();

      executionEngine.recordMatch({
        lendOrderId,
        borrowOrderId,
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const newService = new SnapshotService(testSnapshotDir, null, false);
      const snapshotData = await newService.loadSnapshot();

      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.matches).toHaveLength(1);
      expect(snapshotData!.matches[0].lendOrderId).toBe(lendOrderId);
    });

    it('should handle corrupted snapshot file gracefully', async () => {
      // Create a corrupted snapshot file
      const latestPath = path.join(testSnapshotDir, 'latest.json');
      await fs.mkdir(testSnapshotDir, { recursive: true });
      await fs.writeFile(latestPath, 'invalid json content', 'utf-8');

      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).toBeNull();
    });

    it('should validate snapshot data with Zod schema', async () => {
      // Create invalid snapshot file
      const latestPath = path.join(testSnapshotDir, 'latest.json');
      await fs.mkdir(testSnapshotDir, { recursive: true });
      await fs.writeFile(
        latestPath,
        JSON.stringify({
          version: '1.0.0',
          timestamp: Date.now(),
          orders: [{ invalid: 'order' }], // Invalid order structure
          matches: [],
          metadata: { orderCount: 1, matchCount: 0 },
        }),
        'utf-8'
      );

      // Should return null due to validation failure
      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).toBeNull();
    });
  });

  describe('OrderBook integration', () => {
    it('should restore order book from snapshot', async () => {
      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const walletAddress2 = '0x2222222222222222222222222222222222222222';

      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500,
      });
      orderBook.addOrder(lendOrder);

      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 600,
      });
      orderBook.addOrder(borrowOrder);

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      // Create new order book and restore
      const newOrderBook = new OrderBook();
      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();

      newOrderBook.restoreFromOrders(snapshotData!.orders);

      expect(newOrderBook.orderCount).toBe(2);
      expect(newOrderBook.getOrder(lendOrder.orderId)).not.toBeNull();
      expect(newOrderBook.getOrder(borrowOrder.orderId)).not.toBeNull();
    });

    it('should not restore fully filled orders', async () => {
      const walletAddress1 = '0x1111111111111111111111111111111111111111';

      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500,
      });
      orderBook.addOrder(lendOrder);

      // Fully fill the order
      orderBook.updateOrderAmount(lendOrder.orderId, '0');

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const newOrderBook = new OrderBook();
      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();

      newOrderBook.restoreFromOrders(snapshotData!.orders);

      // Fully filled orders should not be restored
      expect(newOrderBook.orderCount).toBe(0);
    });
  });

  describe('ExecutionEngine integration', () => {
    it('should restore matches from snapshot', async () => {
      const lendOrderId = generateOrderId();
      const borrowOrderId = generateOrderId();

      executionEngine.recordMatch({
        lendOrderId,
        borrowOrderId,
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      });

      await snapshotService.saveSnapshot(orderBook, executionEngine);

      const newExecutionEngine = new ExecutionEngine();
      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();

      newExecutionEngine.restoreMatches(snapshotData!.matches);

      expect(newExecutionEngine.matchCount).toBe(1);
      const matches = newExecutionEngine.getMatchesForOrder(lendOrderId);
      expect(matches).toHaveLength(1);
      expect(matches[0].lendOrderId).toBe(lendOrderId);
    });
  });

  describe('MatchingEngine integration', () => {
    it('should save and restore complete matching engine state', async () => {
      const walletAddress1 = '0x1111111111111111111111111111111111111111';
      const walletAddress2 = '0x2222222222222222222222222222222222222222';

      // Create engine with snapshot service
      const engine1 = new MatchingEngine(undefined, snapshotService);

      // Submit orders that won't match (lend rate > borrow rate)
      // This ensures both orders remain in the book after submission
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 600, // Lender wants at least 600
      });
      engine1.submitOrder(lendOrder);

      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturities: [DEFAULT_MATURITY],
        rate: 500, // Borrower willing to pay at most 500
      });
      engine1.submitOrder(borrowOrder);

      // Verify orders are in engine1 before saving
      expect(engine1.hasOrder(lendOrder.orderId)).toBe(true);
      expect(engine1.hasOrder(borrowOrder.orderId)).toBe(true);

      // Save snapshot
      await engine1.saveSnapshot();

      // Verify snapshot was saved with orders
      const snapshotData = await snapshotService.loadSnapshot();
      expect(snapshotData).not.toBeNull();
      expect(snapshotData!.orders.length).toBe(2);

      // Create new engine and restore
      const engine2 = new MatchingEngine(undefined, snapshotService);
      const restored = await engine2.restoreFromSnapshot();

      expect(restored).toBe(true);
      
      // Verify orders exist in engine2 after restore (checks index)
      expect(engine2.hasOrder(lendOrder.orderId)).toBe(true);
      expect(engine2.hasOrder(borrowOrder.orderId)).toBe(true);
      
      // Verify orders are in the order book trees (not just index)
      const orderBook = engine2.getOrderBook(DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY, 10);
      expect(orderBook.lendOrders.length).toBeGreaterThan(0);
      expect(orderBook.borrowOrders.length).toBeGreaterThan(0);
      
      // Verify specific orders are in the order book
      const lendOrderInBook = orderBook.lendOrders.find((o) => o.orderId === lendOrder.orderId);
      const borrowOrderInBook = orderBook.borrowOrders.find((o) => o.orderId === borrowOrder.orderId);
      expect(lendOrderInBook).toBeDefined();
      expect(borrowOrderInBook).toBeDefined();
    });

    it('should return false if no snapshot exists', async () => {
      const engine = new MatchingEngine(undefined, snapshotService);
      const restored = await engine.restoreFromSnapshot();
      expect(restored).toBe(false);
    });

    it('should handle snapshot save failures gracefully', async () => {
      // Create service with invalid directory (should fail)
      const invalidService = new SnapshotService('/invalid/path/that/does/not/exist', null, false);
      const engine = new MatchingEngine(undefined, invalidService);

      // Should not throw, but should fail silently
      await expect(engine.saveSnapshot()).resolves.not.toThrow();
    });
  });
});
