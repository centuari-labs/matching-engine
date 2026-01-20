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
 * Default loan token address used in tests.
 */
export const DEFAULT_LOAN_TOKEN = '0x1234567890123456789012345678901234567890';

/**
 * Default maturity timestamp used in tests.
 */
export const DEFAULT_MATURITY = 1704067200;

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
    walletAddress: '0x1111111111111111111111111111111111111111',
    loanToken: DEFAULT_LOAN_TOKEN,
    maturities: [DEFAULT_MATURITY],
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

