/**
 * @module @centuari/matching-engine
 * High-performance matching engine for Web3 lending and borrowing
 */

// Core exports
export { MatchingEngine } from './core/matching-engine';
export { OrderBook } from './core/order-book';
export { ExecutionEngine } from './core/execution-engine';

// Type exports
export type {
  Order,
  LendMarketOrder,
  LendLimitOrder,
  BorrowMarketOrder,
  BorrowLimitOrder,
  OrderMetadata,
} from './types/orders';

export {
  OrderSide,
  OrderStatus,
  OrderType,
  isLendOrder,
  isBorrowOrder,
  isMarketOrder,
  isLimitOrder,
  lendMarketOrderSchema,
  lendLimitOrderSchema,
  borrowMarketOrderSchema,
  borrowLimitOrderSchema,
  orderSchema,
} from './types/orders';

export type { Match, MatchResult, OrderBookSnapshot } from './types/matches';
export { matchSchema } from './types/matches';

// Utility exports
export {
  generateOrderId,
  generateMatchId,
  validateTokenAddress,
  calculateMatchRate,
  createOrderComparator,
  compareBigNumbers,
  addBigNumbers,
  subtractBigNumbers,
  minBigNumber,
  isZero,
} from './utils/helpers';

