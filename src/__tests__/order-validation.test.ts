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

    it('should preserve an explicit collateralAssets list on parse', () => {
      const usdc = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const btc = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const order = createBorrowMarketOrder({
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        markets: marketsFromMaturities([1704067200]),
        collateralAssets: [usdc, btc],
      });
      const parsed = borrowMarketOrderSchema.parse(order);
      expect(parsed.collateralAssets).toEqual([usdc, btc]);
    });

    it('should default collateralAssets to [] when omitted', () => {
      // Build the input without going through the factory so we can omit the field.
      const parsed = borrowMarketOrderSchema.parse({
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        assetId: '550e8400-e29b-41d4-a716-446655440001',
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Borrow,
        type: OrderType.Market,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });
      expect(parsed.collateralAssets).toEqual([]);
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

    it('should reject malformed addresses in collateralAssets', () => {
      // Factory parses through the schema, so the throw originates there.
      expect(() =>
        createBorrowLimitOrder({
          walletAddress: validWalletAddress,
          loanToken: validLoanToken,
          markets: marketsFromMaturities([1704067200]),
          rate: 750,
          collateralAssets: ['0xnotahexaddress'],
        }),
      ).toThrow();
    });

    it('should not carry collateralAssets on lend orders (stripped, not present)', () => {
      // Lend schema has no collateralAssets field; with Zod's default `strip` mode,
      // an extra key in the input is dropped silently rather than rejected.
      const parsed = lendLimitOrderSchema.parse({
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        assetId: '550e8400-e29b-41d4-a716-446655440001',
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
        collateralAssets: ['0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'],
      });
      expect((parsed as Record<string, unknown>).collateralAssets).toBeUndefined();
    });
  });

  describe('Schema Boundary Tests', () => {
    it('should accept rate = 0 for lend limit order (min boundary)', () => {
      expect(() => createLendLimitOrder({ rate: 0 })).not.toThrow();
    });

    it('should accept rate = 10000 for borrow limit order (max boundary)', () => {
      expect(() => createBorrowLimitOrder({ rate: 10000 })).not.toThrow();
    });

    it('should accept amount = "0" as valid per regex', () => {
      // Documents that "0" is a valid amount string per the schema
      // (guarded at runtime by business logic, not schema)
      const result = lendLimitOrderSchema.safeParse({
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        assetId: '550e8400-e29b-41d4-a716-446655440001',
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '0',
        remainingAmount: '0',
        settlementFeeAmount: '0',
        rate: 500,
      });
      expect(result.success).toBe(true);
    });

    it('should reject maturity = 0 (positive() check)', () => {
      const result = lendLimitOrderSchema.safeParse({
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        assetId: '550e8400-e29b-41d4-a716-446655440001',
        markets: [{ marketId: '550e8400-e29b-41d4-a716-446655440002', maturity: 0 }],
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      expect(result.success).toBe(false);
    });

    it('should accept Ethereum address with all uppercase hex', () => {
      expect(() =>
        createLendLimitOrder({
          walletAddress: '0xABCDEF0123456789ABCDEF0123456789ABCDEF01',
        })
      ).not.toThrow();
    });

    it('should reject Ethereum address missing "0x" prefix', () => {
      const result = lendLimitOrderSchema.safeParse({
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: '1234567890123456789012345678901234567890',
        loanToken: validLoanToken,
        assetId: '550e8400-e29b-41d4-a716-446655440001',
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      expect(result.success).toBe(false);
    });

    it('should reject Ethereum address with invalid hex chars', () => {
      const result = lendLimitOrderSchema.safeParse({
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
        loanToken: validLoanToken,
        assetId: '550e8400-e29b-41d4-a716-446655440001',
        markets: marketsFromMaturities([1704067200]),
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      expect(result.success).toBe(false);
    });

    it('should reject empty markets array', () => {
      const result = lendLimitOrderSchema.safeParse({
        orderId: '550e8400-e29b-41d4-a716-446655440000',
        walletAddress: validWalletAddress,
        loanToken: validLoanToken,
        assetId: '550e8400-e29b-41d4-a716-446655440001',
        markets: [],
        timestamp: Date.now(),
        side: OrderSide.Lend,
        type: OrderType.Limit,
        status: OrderStatus.Open,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      expect(result.success).toBe(false);
    });
  });
});

