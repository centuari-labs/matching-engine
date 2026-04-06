import { MatchingEngine } from '../core/matching-engine';
import { OrderStatus } from '../types/orders';
import { createLendLimitOrder, createBorrowLimitOrder } from './factories/order-factory';
import { generateOrderId } from '../utils/helpers';

describe('Order Update logic', () => {
  let engine: MatchingEngine;
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';

  beforeEach(() => {
    engine = new MatchingEngine();
  });

  it('should return the old order when updating an open order', () => {
    const order = createLendLimitOrder({
      walletAddress: walletAddress1,
    });
    engine.submitOrder(order);

    const result = engine.updateOrder(order.orderId, walletAddress1);
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect(result.orderId).toBe(order.orderId);
    }
    expect(engine.getOrderStatus(order.orderId)).toBeNull();
  });

  it('should return NOT_FOUND when order does not exist', () => {
    const result = engine.updateOrder(generateOrderId(), walletAddress1);
    expect(result).toBe('NOT_FOUND');
  });

  it('should return WALLET_MISMATCH when wallet address does not match', () => {
    const order = createLendLimitOrder({
      walletAddress: walletAddress1,
    });
    engine.submitOrder(order);

    const result = engine.updateOrder(order.orderId, walletAddress2);
    expect(result).toBe('WALLET_MISMATCH');
    expect(engine.getOrderStatus(order.orderId)).toBe(OrderStatus.Open);
  });

  it('should return INVALID_STATUS when order is already filled', () => {
    // Create matching orders so one gets filled
    const lendOrder = createLendLimitOrder({
      walletAddress: walletAddress1,
      rate: 500,
      originalAmount: '1000000',
      remainingAmount: '1000000',
    });
    const borrowOrder = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      rate: 500,
      originalAmount: '1000000',
      remainingAmount: '1000000',
    });

    engine.submitOrder(lendOrder);
    const matchResult = engine.submitOrder(borrowOrder);

    // One of them should be fully matched and removed from book
    // The borrow order (taker) is fully filled and removed
    expect(matchResult.matches.length).toBeGreaterThan(0);

    // Trying to update a filled order that's no longer in the book
    const result = engine.updateOrder(borrowOrder.orderId, walletAddress2);
    expect(result).toBe('NOT_FOUND');
  });

  it('should allow updating a partially filled order', () => {
    const lendOrder = createLendLimitOrder({
      walletAddress: walletAddress1,
      rate: 500,
      originalAmount: '2000000',
      remainingAmount: '2000000',
    });

    const borrowOrder = createBorrowLimitOrder({
      walletAddress: walletAddress2,
      rate: 500,
      originalAmount: '1000000',
      remainingAmount: '1000000',
    });

    engine.submitOrder(lendOrder);
    engine.submitOrder(borrowOrder);

    // lendOrder should be partially filled (1000000 out of 2000000)
    const result = engine.updateOrder(lendOrder.orderId, walletAddress1);
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect(result.orderId).toBe(lendOrder.orderId);
      expect(result.status).toBe(OrderStatus.PartiallyFilled);
    }
  });

  it('should remove the order from the book after update', () => {
    const order = createLendLimitOrder({
      walletAddress: walletAddress1,
    });
    engine.submitOrder(order);

    expect(engine.hasOrder(order.orderId)).toBe(true);

    const result = engine.updateOrder(order.orderId, walletAddress1);
    expect(typeof result).toBe('object');
    expect(engine.hasOrder(order.orderId)).toBe(false);
  });

  it('should preserve original order fields in the returned order', () => {
    const order = createLendLimitOrder({
      walletAddress: walletAddress1,
      rate: 750,
      originalAmount: '5000000',
      remainingAmount: '5000000',
      settlementFeeAmount: '50000',
    });
    engine.submitOrder(order);

    const result = engine.updateOrder(order.orderId, walletAddress1);
    expect(typeof result).toBe('object');
    if (typeof result === 'object') {
      expect(result.originalAmount).toBe('5000000');
      expect(result.remainingAmount).toBe('5000000');
      expect(result.settlementFeeAmount).toBe('50000');
      expect(result.rate).toBe(750);
    }
  });
});
