import {
  OrderStatus,
  OrderType,
  OrderSide,
  type LendLimitOrder,
  type BorrowLimitOrder,
  type LendMarketOrder,
  type BorrowMarketOrder,
  lendLimitOrderSchema,
  borrowLimitOrderSchema,
  lendMarketOrderSchema,
  borrowMarketOrderSchema,
} from '../../types/orders';
import { generateOrderId } from '../../utils/helpers';

/**
 * Default asset ID (UUID) used in tests.
 */
export const DEFAULT_ASSET_ID = '550e8400-e29b-41d4-a716-446655440001';

/**
 * Default market ID (UUID) used in tests.
 */
export const DEFAULT_MARKET_ID = '550e8400-e29b-41d4-a716-446655440010';

/**
 * Default settlement fee amount used in tests.
 */
export const DEFAULT_SETTLEMENT_FEE_AMOUNT = '10000';

/**
 * Default original and remaining amount used in tests.
 */
export const DEFAULT_ORDER_AMOUNT = '1000000';

/**
 * Common base fields for all test orders.
 *
 * @returns Base order fields with sensible defaults.
 */
function createBaseOrder() {
  return {
    orderId: generateOrderId(),
    accountId: '550e8400-e29b-41d4-a716-446655440002',
    assetId: DEFAULT_ASSET_ID,
    marketIds: [DEFAULT_MARKET_ID],
    timestamp: Date.now(),
    status: OrderStatus.Open,
    originalAmount: DEFAULT_ORDER_AMOUNT,
    remainingAmount: DEFAULT_ORDER_AMOUNT,
    settlementFeeAmount: DEFAULT_SETTLEMENT_FEE_AMOUNT,
    // Initialize remainingSettlementFeeAmount from settlementFeeAmount by default.
    remainingSettlementFeeAmount: DEFAULT_SETTLEMENT_FEE_AMOUNT,
  };
}

/**
 * Create a lend limit order for tests.
 *
 * @param overrides - Optional overrides for specific fields.
 * @returns A valid LendLimitOrder instance.
 */
export function createLendLimitOrder(
  overrides: Partial<LendLimitOrder> = {},
): LendLimitOrder {
  const base = createBaseOrder();

  const order: LendLimitOrder = {
    ...base,
    side: OrderSide.Lend,
    type: OrderType.Limit,
    rate: 500,
    ...overrides,
  };

  // Ensure remainingSettlementFeeAmount defaults to settlementFeeAmount if not provided.
  if (order.remainingSettlementFeeAmount === undefined) {
    order.remainingSettlementFeeAmount = order.settlementFeeAmount;
  }

  return lendLimitOrderSchema.parse(order);
}

/**
 * Create a borrow limit order for tests.
 *
 * @param overrides - Optional overrides for specific fields.
 * @returns A valid BorrowLimitOrder instance.
 */
export function createBorrowLimitOrder(
  overrides: Partial<BorrowLimitOrder> = {},
): BorrowLimitOrder {
  const base = createBaseOrder();

  const order: BorrowLimitOrder = {
    ...base,
    side: OrderSide.Borrow,
    type: OrderType.Limit,
    rate: 500,
    ...overrides,
  };

  if (order.remainingSettlementFeeAmount === undefined) {
    order.remainingSettlementFeeAmount = order.settlementFeeAmount;
  }

  return borrowLimitOrderSchema.parse(order);
}

/**
 * Create a lend market order for tests.
 *
 * @param overrides - Optional overrides for specific fields.
 * @returns A valid LendMarketOrder instance.
 */
export function createLendMarketOrder(
  overrides: Partial<LendMarketOrder> = {},
): LendMarketOrder {
  const base = createBaseOrder();

  const order: LendMarketOrder = {
    ...base,
    side: OrderSide.Lend,
    type: OrderType.Market,
    ...overrides,
  };

  if (order.remainingSettlementFeeAmount === undefined) {
    order.remainingSettlementFeeAmount = order.settlementFeeAmount;
  }

  return lendMarketOrderSchema.parse(order);
}

/**
 * Create a borrow market order for tests.
 *
 * @param overrides - Optional overrides for specific fields.
 * @returns A valid BorrowMarketOrder instance.
 */
export function createBorrowMarketOrder(
  overrides: Partial<BorrowMarketOrder> = {},
): BorrowMarketOrder {
  const base = createBaseOrder();

  const order: BorrowMarketOrder = {
    ...base,
    side: OrderSide.Borrow,
    type: OrderType.Market,
    ...overrides,
  };

  if (order.remainingSettlementFeeAmount === undefined) {
    order.remainingSettlementFeeAmount = order.settlementFeeAmount;
  }

  return borrowMarketOrderSchema.parse(order);
}

