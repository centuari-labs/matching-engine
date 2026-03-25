import { MatchingEngine } from '../core/matching-engine';
import { OrderStatus } from '../types/orders';
import { createLendLimitOrder } from './factories/order-factory';

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
    const result = engine.updateOrder('non-existent-id', walletAddress1);
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
});
