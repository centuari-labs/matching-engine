import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
  DEFAULT_ORDER_AMOUNT,
  DEFAULT_SETTLEMENT_FEE_AMOUNT,
} from './order-factory';
import {
  lendLimitOrderSchema,
  borrowLimitOrderSchema,
  lendMarketOrderSchema,
  borrowMarketOrderSchema,
} from '../../types/orders';

describe('order-factory', () => {
  it('creates a valid lend limit order with default fees and amounts', () => {
    const order = createLendLimitOrder();

    // Should be valid according to schema
    expect(() => lendLimitOrderSchema.parse(order)).not.toThrow();

    expect(order.originalAmount).toBe(DEFAULT_ORDER_AMOUNT);
    expect(order.remainingAmount).toBe(DEFAULT_ORDER_AMOUNT);
    expect(order.settlementFeeAmount).toBe(DEFAULT_SETTLEMENT_FEE_AMOUNT);
    expect(order.remainingSettlementFeeAmount).toBe(DEFAULT_SETTLEMENT_FEE_AMOUNT);
  });

  it('creates a valid borrow limit order', () => {
    const order = createBorrowLimitOrder();
    expect(() => borrowLimitOrderSchema.parse(order)).not.toThrow();
  });

  it('creates a valid lend market order', () => {
    const order = createLendMarketOrder();
    expect(() => lendMarketOrderSchema.parse(order)).not.toThrow();
  });

  it('creates a valid borrow market order', () => {
    const order = createBorrowMarketOrder();
    expect(() => borrowMarketOrderSchema.parse(order)).not.toThrow();
  });

  it('respects overrides and keeps remainingSettlementFeeAmount in sync when not provided', () => {
    const order = createLendLimitOrder({
      settlementFeeAmount: '12345',
      remainingSettlementFeeAmount: undefined,
    });

    expect(order.settlementFeeAmount).toBe('12345');
    expect(order.remainingSettlementFeeAmount).toBe('12345');
  });
});

