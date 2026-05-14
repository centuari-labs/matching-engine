import { MatchingEngine } from '../core/matching-engine';
import { OrderBook } from '../core/order-book';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
} from './factories/order-factory';

/**
 * M-1 audit fix tests — duplicate order guard at both layers.
 *
 * Layer A (MatchingEngine.submitOrder): rejects duplicate orderIds BEFORE
 * the matching loop runs. Prevents unauthorized fills from NATS redelivery.
 *
 * Layer B (OrderBook.addOrder): rejects duplicate orderIds inside the
 * book itself. Defense in depth against direct callers that bypass
 * submitOrder (e.g. snapshot restore, db sync).
 */
describe('M-1: Duplicate order guard — Layer B (OrderBook.addOrder)', () => {
  let book: OrderBook;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    book = new OrderBook();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns the order on first insert', () => {
    const order = createLendLimitOrder();
    const result = book.addOrder(order);
    expect(result).toBe(order);
    expect(book.orderCount).toBe(1);
  });

  it('returns null and logs a WARN on duplicate orderId', () => {
    const order = createLendLimitOrder();
    book.addOrder(order);

    const result = book.addOrder(order);

    expect(result).toBeNull();
    expect(book.orderCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Duplicate order rejected: ${order.orderId}`)
    );
  });

  it('preserves the metadata of the first-inserted order on duplicate', () => {
    const original = createLendLimitOrder({ remainingAmount: '500000' });
    const replay = createLendLimitOrder({
      orderId: original.orderId,
      remainingAmount: '999999', // attacker tries to modify
    });

    book.addOrder(original);
    book.addOrder(replay);

    const fromBook = book.getOrder(original.orderId);
    expect(fromBook).not.toBeNull();
    expect(fromBook?.remainingAmount).toBe('500000');
  });

  it('allows re-add after removeOrder (the updateOrderAmount path)', () => {
    const order = createLendLimitOrder();
    book.addOrder(order);
    book.removeOrder(order.orderId);

    // Re-add should succeed because the index was cleared.
    const result = book.addOrder(order);
    expect(result).toBe(order);
    expect(book.orderCount).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('allows re-add after clear (the restoreFromOrders path)', () => {
    const order = createLendLimitOrder();
    book.addOrder(order);
    book.clear();

    const result = book.addOrder(order);
    expect(result).toBe(order);
    expect(book.orderCount).toBe(1);
  });

  it('updateOrderAmount survives the guard (removeOrder runs first internally)', () => {
    const order = createLendLimitOrder({ remainingAmount: '1000000' });
    book.addOrder(order);

    const ok = book.updateOrderAmount(order.orderId, '500000');

    expect(ok).toBe(true);
    expect(book.orderCount).toBe(1);
    expect(book.getOrder(order.orderId)?.remainingAmount).toBe('500000');
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('M-1: Duplicate order guard — Layer A (MatchingEngine.submitOrder)', () => {
  let engine: MatchingEngine;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    engine = new MatchingEngine();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('accepts a fresh order normally', () => {
    const order = createLendLimitOrder();
    const result = engine.submitOrder(order);
    expect(result.matches).toEqual([]);
    expect(result.remainingOrder?.orderId).toBe(order.orderId);
  });

  it('rejects a duplicate submitOrder with empty MatchResult', () => {
    const order = createLendLimitOrder();
    engine.submitOrder(order);

    const replay = engine.submitOrder(order);

    expect(replay.matches).toEqual([]);
    expect(replay.affectedMakerOrders).toEqual([]);
    expect(replay.remainingOrder).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Duplicate submitOrder rejected: ${order.orderId}`)
    );
  });

  it('prevents the matching loop from re-executing on duplicate (the actual exploit)', () => {
    // Set up a maker order so a replay would otherwise match against it.
    // Different wallets to avoid self-match prevention.
    const maker = createBorrowLimitOrder({
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      rate: 500,
      remainingAmount: '1000000',
    });
    engine.submitOrder(maker);

    const taker = createLendLimitOrder({
      walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      rate: 500,
      remainingAmount: '500000',
    });
    const firstSubmit = engine.submitOrder(taker);
    expect(firstSubmit.matches.length).toBeGreaterThan(0);

    // Replay the SAME taker order — should produce zero new matches.
    const replay = engine.submitOrder(taker);
    expect(replay.matches).toEqual([]);
    expect(replay.affectedMakerOrders).toEqual([]);
  });

  it('hydrates submittedOrderIds from syncFromDatabase recentOrderIds', () => {
    const id1 = '11111111-1111-4111-8111-111111111111';
    const id2 = '22222222-2222-4222-8222-222222222222';
    const id3 = '33333333-3333-4333-8333-333333333333';
    const recentIds = [id1, id2, id3];
    const result = engine.syncFromDatabase([], recentIds);
    expect(result.dedupHydrated).toBe(3);

    // A submission with one of the hydrated ids must be rejected.
    const replay = createLendLimitOrder({ orderId: id2 });
    const replayResult = engine.submitOrder(replay);
    expect(replayResult.matches).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Duplicate submitOrder rejected: ${id2}`)
    );
  });

  it('exposes submittedOrderIds via getSubmittedOrderIds', () => {
    const o1 = createLendLimitOrder();
    const o2 = createLendLimitOrder();
    engine.submitOrder(o1);
    engine.submitOrder(o2);

    const ids = engine.getSubmittedOrderIds();
    expect(ids).toEqual(expect.arrayContaining([o1.orderId, o2.orderId]));
    expect(ids).toHaveLength(2);
  });

  it('restores submittedOrderIds from a snapshot via restoreSubmittedOrderIds', () => {
    const id1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const id2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const persisted = [id1, id2];
    engine.restoreSubmittedOrderIds(persisted);

    const replay = createLendLimitOrder({ orderId: id1 });
    const result = engine.submitOrder(replay);
    expect(result.matches).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining(`Duplicate submitOrder rejected: ${id1}`)
    );
  });

  it('does NOT clear submittedOrderIds when an order is fully filled (replay-after-fill still blocked)', () => {
    const maker = createBorrowLimitOrder({
      walletAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      rate: 500,
      remainingAmount: '1000000',
    });
    engine.submitOrder(maker);

    const taker = createLendLimitOrder({
      walletAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      rate: 500,
      remainingAmount: '1000000',
    });
    engine.submitOrder(taker); // fully fills

    // Maker should be gone from the book but still in the dedup set.
    expect(engine.getSubmittedOrderIds()).toContain(maker.orderId);

    // Replaying the taker must still be rejected even though the order is filled.
    const replay = engine.submitOrder(taker);
    expect(replay.matches).toEqual([]);
  });
});
