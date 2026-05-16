/**
 * Expired Order Pruning Tests
 *
 * Covers OrderBook.pruneExpiredOrders / MatchingEngine.pruneExpiredOrders and
 * the snapshot dirty-flag debounce that replaced per-order snapshot writes.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { OrderBook } from '../core/order-book';
import { MatchingEngine } from '../core/matching-engine';
import { SnapshotService } from '../services/snapshot-service';
import { createLendLimitOrder, marketsFromMaturities } from './factories/order-factory';

describe('Expired order pruning', () => {
  // Fixed reference "now" (Unix seconds) so tests do not depend on wall clock.
  const NOW = 2_000_000_000;
  const PAST = NOW - 86_400;
  const FUTURE = NOW + 86_400;

  describe('OrderBook.pruneExpiredOrders', () => {
    it('removes orders whose maturity is in the past', () => {
      const book = new OrderBook();
      book.addOrder(createLendLimitOrder({ markets: marketsFromMaturities([PAST]) }));
      expect(book.orderCount).toBe(1);

      const pruned = book.pruneExpiredOrders(NOW);

      expect(pruned).toBe(1);
      expect(book.orderCount).toBe(0);
    });

    it('keeps orders whose maturity is in the future', () => {
      const book = new OrderBook();
      const order = createLendLimitOrder({ markets: marketsFromMaturities([FUTURE]) });
      book.addOrder(order);

      const pruned = book.pruneExpiredOrders(NOW);

      expect(pruned).toBe(0);
      expect(book.getOrder(order.orderId)).not.toBeNull();
    });

    it('treats an order as expired only when all its markets have matured', () => {
      const book = new OrderBook();
      const mixed = createLendLimitOrder({
        markets: marketsFromMaturities([PAST, FUTURE]),
      });
      book.addOrder(mixed);

      expect(book.pruneExpiredOrders(NOW)).toBe(0);
      expect(book.getOrder(mixed.orderId)).not.toBeNull();
    });

    it('prunes orders matured exactly at the reference time', () => {
      const book = new OrderBook();
      book.addOrder(createLendLimitOrder({ markets: marketsFromMaturities([NOW]) }));

      expect(book.pruneExpiredOrders(NOW)).toBe(1);
      expect(book.orderCount).toBe(0);
    });

    it('returns 0 on an empty book', () => {
      expect(new OrderBook().pruneExpiredOrders(NOW)).toBe(0);
    });
  });

  describe('MatchingEngine.pruneExpiredOrders', () => {
    it('removes expired orders from the engine order book', () => {
      const engine = new MatchingEngine();
      engine.submitOrder(createLendLimitOrder({ markets: marketsFromMaturities([PAST]) }));

      expect(engine.pruneExpiredOrders(NOW)).toBe(1);
    });

    it('defaults to the current time when no argument is given', () => {
      const engine = new MatchingEngine();
      // A maturity in the real past (2024-01-01) — pruned against Date.now().
      engine.submitOrder(createLendLimitOrder({ markets: marketsFromMaturities([1_704_067_200]) }));

      expect(engine.pruneExpiredOrders()).toBe(1);
    });
  });

  describe('Snapshot dirty-flag debounce', () => {
    const testDir = path.join(__dirname, '../../test-snapshots-prune');
    const latestPath = path.join(testDir, 'latest.json');

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it('does not write a snapshot when state is unchanged', async () => {
      const engine = new MatchingEngine(undefined, new SnapshotService(testDir));

      await engine.saveSnapshotIfDirty();

      await expect(fs.access(latestPath)).rejects.toThrow();
    });

    it('writes a snapshot after a mutating operation', async () => {
      const engine = new MatchingEngine(undefined, new SnapshotService(testDir));
      engine.submitOrder(createLendLimitOrder({ markets: marketsFromMaturities([FUTURE]) }));

      await engine.saveSnapshotIfDirty();

      await expect(fs.access(latestPath)).resolves.toBeUndefined();
    });

    it('clears the dirty flag so a second save is skipped', async () => {
      const engine = new MatchingEngine(undefined, new SnapshotService(testDir));
      engine.submitOrder(createLendLimitOrder({ markets: marketsFromMaturities([FUTURE]) }));
      await engine.saveSnapshotIfDirty();
      const firstMtime = (await fs.stat(latestPath)).mtimeMs;

      await engine.saveSnapshotIfDirty();
      const secondMtime = (await fs.stat(latestPath)).mtimeMs;

      expect(secondMtime).toBe(firstMtime);
    });
  });
});
