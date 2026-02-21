import {
  lendMarketOrderSchema,
  lendLimitOrderSchema,
  borrowMarketOrderSchema,
  borrowLimitOrderSchema,
  OrderSide,
  OrderType,
  OrderStatus,
} from '../types/orders';
import {
  createLendMarketOrder,
  createLendLimitOrder,
  createBorrowMarketOrder,
  createBorrowLimitOrder,
  marketsFromMaturities,
} from './factories/order-factory';

describe('Order Validation', () => {
  const validLoanToken = '0x1234567890123456789012345678901234567890';
  const validWalletAddress = '0x1111111111111111111111111111111111111111';

  describe('Lend Market Order', () => {
    it('should validate a valid lend market order', () => {
      const order = createLendMarketOrder({
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
      });

      expect(() => lendMarketOrderSchema.parse(order)).not.toThrow();
    });

    it('should reject lend market order with rate', () => {
      const order = {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      };

      expect(() => lendMarketOrderSchema.parse(order)).toThrow();
    });

    it('should reject invalid ethereum address', () => {
      const order = {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: 'invalid-address',
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      expect(() => lendMarketOrderSchema.parse(order)).toThrow();
    });

    it('should reject empty markets array', () => {
      const order = {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: [],
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      expect(() => lendMarketOrderSchema.parse(order)).toThrow();
    });
  });

  describe('Lend Limit Order', () => {
    it('should validate a valid lend limit order', () => {
      const order = createLendLimitOrder({
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200, 1735689600]),
        rate: 500,
      });

      expect(() => lendLimitOrderSchema.parse(order)).not.toThrow();
    });

    it('should reject lend limit order without rate', () => {
      const order = {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      expect(() => lendLimitOrderSchema.parse(order)).toThrow();
    });

    it('should reject negative rate', () => {
      const order = {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: -100,
      };

      expect(() => lendLimitOrderSchema.parse(order)).toThrow();
    });

    it('should reject rate exceeding maximum', () => {
      const order = {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 100001,
      };

      expect(() => lendLimitOrderSchema.parse(order)).toThrow();
    });
  });

  describe('Borrow Market Order', () => {
    it('should validate a valid borrow market order', () => {
      const order = createBorrowMarketOrder({
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
      });

      expect(() => borrowMarketOrderSchema.parse(order)).not.toThrow();
    });
  });

  describe('Borrow Limit Order', () => {
    it('should validate a valid borrow limit order', () => {
      const order = createBorrowLimitOrder({
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
        rate: 750,
      });

      expect(() => borrowLimitOrderSchema.parse(order)).not.toThrow();
    });

    it('should reject borrow limit order without rate', () => {
      const order = {
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Borrow,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      };

      expect(() => borrowLimitOrderSchema.parse(order)).toThrow();
    });
  });
});

