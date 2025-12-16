import { OrderBook } from './order-book';
import { ExecutionEngine } from './execution-engine';
import type {
  Order,
  LendMarketOrder,
  LendLimitOrder,
  BorrowMarketOrder,
  BorrowLimitOrder,
} from '../types/orders';
import { OrderSide, OrderStatus, OrderType, isLimitOrder } from '../types/orders';
import type { Match, MatchResult, OrderBookSnapshot } from '../types/matches';
import {
  minBigNumber,
  subtractBigNumbers,
  isZero
} from '../utils/helpers';

/**
 * MatchingEngine is the core component that matches lend and borrow orders
 */
export class MatchingEngine {
  private orderBook: OrderBook;
  private executionEngine: ExecutionEngine;

  constructor() {
    this.orderBook = new OrderBook();
    this.executionEngine = new ExecutionEngine();
  }

  /**
   * Submit an order to the matching engine
   * The order will be matched against existing orders and added to the order book if not fully filled
   *
   * @param order - The order to submit
   * @returns Match result containing matches and remaining order info
   */
  submitOrder(order: Order): MatchResult {
    const matches: Match[] = [];

    if (order.side === OrderSide.Lend) {
      // Match lend order against borrow orders
      if (order.type === OrderType.Market) {
        this.matchLendMarketOrder(order as LendMarketOrder, matches);
      } else {
        this.matchLendLimitOrder(order as LendLimitOrder, matches);
      }
    } else {
      // Match borrow order against lend orders
      if (order.type === OrderType.Market) {
        this.matchBorrowMarketOrder(order as BorrowMarketOrder, matches);
      } else {
        this.matchBorrowLimitOrder(order as BorrowLimitOrder, matches);
      }
    }

    // Market orders have IOC behavior - never added to book
    // Only limit orders can remain in the book
    const currentOrder = this.orderBook.getOrder(order.orderId);
    let remainingOrder = null;

    if (currentOrder && !isZero(currentOrder.remainingAmount)) {
      remainingOrder = {
        orderId: currentOrder.orderId,
        remainingAmount: currentOrder.remainingAmount,
        status: currentOrder.status,
      };
    }

    return {
      matches,
      remainingOrder,
    };
  }

  /**
   * Match a lend market order against borrow limit orders
   * Market orders match at the best available rate (highest borrow rate)
   */
  private matchLendMarketOrder(order: LendMarketOrder, matches: Match[]): void {
    let remainingAmount = order.remainingAmount;

    // Try to match with each maturity
    for (const maturity of order.maturities) {
      if (isZero(remainingAmount)) break;

      // Get borrow orders for this maturity (sorted by rate descending - highest first)
      const borrowOrders = this.orderBook.getBestOrders(
        OrderSide.Borrow,
        order.loanToken,
        maturity
      );

      for (const borrowOrder of borrowOrders) {
        if (isZero(remainingAmount)) break;

        // Skip self-matching: lend and borrow orders from the same wallet cannot match
        if (order.walletAddress.toLowerCase() === borrowOrder.walletAddress.toLowerCase()) {
          continue;
        }

        // Only match with limit orders (market orders don't have rates)
        if (!isLimitOrder(borrowOrder)) continue;

        const borrowLimitOrder = borrowOrder as BorrowLimitOrder;

        // Calculate match amount
        const matchAmount = minBigNumber(remainingAmount, borrowOrder.remainingAmount);

        // Create match at borrow order's rate
        const match = this.executionEngine.recordMatch({
          lendOrderId: order.orderId,
          borrowOrderId: borrowOrder.orderId,
          matchedAmount: matchAmount,
          rate: borrowLimitOrder.rate,
          loanToken: order.loanToken,
          collateralTokens: borrowLimitOrder.collateralTokens,
          maturity,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const borrowRemainingAmount = subtractBigNumbers(
          borrowOrder.remainingAmount,
          matchAmount
        );

        // Update borrow order in order book
        if (isZero(borrowRemainingAmount)) {
          this.orderBook.removeOrder(borrowOrder.orderId);
        } else {
          this.orderBook.updateOrderAmount(borrowOrder.orderId, borrowRemainingAmount);
        }
      }
    }

    // Market orders have Immediate-or-Cancel (IOC) behavior
    // - If fully filled: order is complete, not added to book
    // - If partially filled: matched portion executes, remaining is rejected (not added to book)
    // - If no matches: order is rejected, not added to book
    // Market orders are NEVER added to the order book - they execute immediately or are rejected
  }

  /**
   * Match a lend limit order against borrow orders
   * Matches with borrow orders that have rate >= lend rate
   */
  private matchLendLimitOrder(order: LendLimitOrder, matches: Match[]): void {
    let remainingAmount = order.remainingAmount;

    // Try to match with each maturity
    for (const maturity of order.maturities) {
      if (isZero(remainingAmount)) break;

      // Get borrow orders for this maturity (sorted by rate descending - highest first)
      const borrowOrders = this.orderBook.getBestOrders(
        OrderSide.Borrow,
        order.loanToken,
        maturity
      );

      for (const borrowOrder of borrowOrders) {
        if (isZero(remainingAmount)) break;

        // Skip self-matching: lend and borrow orders from the same wallet cannot match
        if (order.walletAddress.toLowerCase() === borrowOrder.walletAddress.toLowerCase()) {
          continue;
        }

        // Check if borrow order has acceptable rate and determine execution rate
        let executionRate: number;
        if (isLimitOrder(borrowOrder)) {
          const borrowRate = (borrowOrder as BorrowLimitOrder).rate;
          // Lender wants minimum rate, borrower willing to pay maximum rate
          // Match only if borrowRate >= lendRate
          if (borrowRate < order.rate) {
            continue; // Borrow rate too low, skip
          }
          // Use maker's rate (borrow order already in the book)
          executionRate = borrowRate;
        } else {
          // Market order - matches at lend order's rate (shouldn't happen in practice)
          executionRate = order.rate;
        }

        const borrowMarketOrLimit = borrowOrder as BorrowMarketOrder | BorrowLimitOrder;

        // Calculate match amount
        const matchAmount = minBigNumber(remainingAmount, borrowOrder.remainingAmount);

        const match = this.executionEngine.recordMatch({
          lendOrderId: order.orderId,
          borrowOrderId: borrowOrder.orderId,
          matchedAmount: matchAmount,
          rate: executionRate,
          loanToken: order.loanToken,
          collateralTokens: borrowMarketOrLimit.collateralTokens,
          maturity,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const borrowRemainingAmount = subtractBigNumbers(
          borrowOrder.remainingAmount,
          matchAmount
        );

        // Update borrow order in order book
        if (isZero(borrowRemainingAmount)) {
          this.orderBook.removeOrder(borrowOrder.orderId);
        } else {
          this.orderBook.updateOrderAmount(borrowOrder.orderId, borrowRemainingAmount);
        }
      }
    }

    // Update lend order status and add to order book if not fully filled
    const updatedOrder: LendLimitOrder = {
      ...order,
      remainingAmount,
      status: isZero(remainingAmount)
        ? OrderStatus.Filled
        : matches.length > 0
          ? OrderStatus.PartiallyFilled
          : OrderStatus.Open,
    };

    if (!isZero(remainingAmount)) {
      this.orderBook.addOrder(updatedOrder);
    }
  }

  /**
   * Match a borrow market order against lend limit orders
   * Market orders match at the best available rate (lowest lend rate)
   */
  private matchBorrowMarketOrder(order: BorrowMarketOrder, matches: Match[]): void {
    let remainingAmount = order.remainingAmount;

    // Try to match with each maturity
    for (const maturity of order.maturities) {
      if (isZero(remainingAmount)) break;

      // Get lend orders for this maturity (sorted by rate ascending - lowest first)
      const lendOrders = this.orderBook.getBestOrders(
        OrderSide.Lend,
        order.loanToken,
        maturity
      );

      for (const lendOrder of lendOrders) {
        if (isZero(remainingAmount)) break;

        // Skip self-matching: lend and borrow orders from the same wallet cannot match
        if (order.walletAddress.toLowerCase() === lendOrder.walletAddress.toLowerCase()) {
          continue;
        }

        // Only match with limit orders (market orders don't have rates)
        if (!isLimitOrder(lendOrder)) continue;

        const lendLimitOrder = lendOrder as LendLimitOrder;

        // Calculate match amount
        const matchAmount = minBigNumber(remainingAmount, lendOrder.remainingAmount);

        // Create match at lend order's rate
        const match = this.executionEngine.recordMatch({
          lendOrderId: lendOrder.orderId,
          borrowOrderId: order.orderId,
          matchedAmount: matchAmount,
          rate: lendLimitOrder.rate,
          loanToken: order.loanToken,
          collateralTokens: order.collateralTokens,
          maturity,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const lendRemainingAmount = subtractBigNumbers(lendOrder.remainingAmount, matchAmount);

        // Update lend order in order book
        if (isZero(lendRemainingAmount)) {
          this.orderBook.removeOrder(lendOrder.orderId);
        } else {
          this.orderBook.updateOrderAmount(lendOrder.orderId, lendRemainingAmount);
        }
      }
    }

    // Market orders have Immediate-or-Cancel (IOC) behavior
    // - If fully filled: order is complete, not added to book
    // - If partially filled: matched portion executes, remaining is rejected (not added to book)
    // - If no matches: order is rejected, not added to book
    // Market orders are NEVER added to the order book - they execute immediately or are rejected
  }

  /**
   * Match a borrow limit order against lend orders
   * Matches with lend orders that have rate <= borrow rate
   */
  private matchBorrowLimitOrder(order: BorrowLimitOrder, matches: Match[]): void {
    let remainingAmount = order.remainingAmount;

    // Try to match with each maturity
    for (const maturity of order.maturities) {
      if (isZero(remainingAmount)) break;

      // Get lend orders for this maturity (sorted by rate ascending - lowest first)
      const lendOrders = this.orderBook.getBestOrders(
        OrderSide.Lend,
        order.loanToken,
        maturity
      );

      for (const lendOrder of lendOrders) {
        if (isZero(remainingAmount)) break;

        // Skip self-matching: lend and borrow orders from the same wallet cannot match
        if (order.walletAddress.toLowerCase() === lendOrder.walletAddress.toLowerCase()) {
          continue;
        }

        // Check if lend order has acceptable rate and determine execution rate
        let executionRate: number;
        if (isLimitOrder(lendOrder)) {
          const lendRate = (lendOrder as LendLimitOrder).rate;
          // Borrower willing to pay maximum rate, lender wants minimum rate
          // Match only if lendRate <= borrowRate
          if (lendRate > order.rate) {
            break; // Lend rate too high, and rest will be higher (sorted), stop
          }
          // Use maker's rate (lend order already in the book)
          executionRate = lendRate;
        } else {
          // Market order - matches at borrow order's rate (shouldn't happen in practice)
          executionRate = order.rate;
        }

        // Calculate match amount
        const matchAmount = minBigNumber(remainingAmount, lendOrder.remainingAmount);

        const match = this.executionEngine.recordMatch({
          lendOrderId: lendOrder.orderId,
          borrowOrderId: order.orderId,
          matchedAmount: matchAmount,
          rate: executionRate,
          loanToken: order.loanToken,
          collateralTokens: order.collateralTokens,
          maturity,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const lendRemainingAmount = subtractBigNumbers(lendOrder.remainingAmount, matchAmount);

        // Update lend order in order book
        if (isZero(lendRemainingAmount)) {
          this.orderBook.removeOrder(lendOrder.orderId);
        } else {
          this.orderBook.updateOrderAmount(lendOrder.orderId, lendRemainingAmount);
        }
      }
    }

    // Update borrow order status and add to order book if not fully filled
    const updatedOrder: BorrowLimitOrder = {
      ...order,
      remainingAmount,
      status: isZero(remainingAmount)
        ? OrderStatus.Filled
        : matches.length > 0
          ? OrderStatus.PartiallyFilled
          : OrderStatus.Open,
    };

    if (!isZero(remainingAmount)) {
      this.orderBook.addOrder(updatedOrder);
    }
  }

  /**
   * Cancel an order
   *
   * @param orderId - The ID of the order to cancel
   * @param walletAddress - The wallet address of the order owner
   * @returns True if order was cancelled, false if not found or wallet address doesn't match
   */
  cancelOrder(orderId: string, walletAddress: string): boolean {
    const order = this.orderBook.getOrder(orderId);
    if (!order) {
      return false;
    }

    // Validate wallet address matches the order owner
    if (order.walletAddress.toLowerCase() !== walletAddress.toLowerCase()) {
      return false;
    }

    // Remove from order book
    this.orderBook.removeOrder(orderId);
    return true;
  }

  /**
   * Get order status
   *
   * @param orderId - The order ID
   * @returns The order status if found, null otherwise
   */
  getOrderStatus(orderId: string): OrderStatus | null {
    return this.orderBook.getOrderStatus(orderId);
  }

  /**
   * Check if an order exists
   *
   * @param orderId - The order ID
   * @returns True if order exists, false otherwise
   */
  hasOrder(orderId: string): boolean {
    return this.orderBook.getOrder(orderId) !== null;
  }

  /**
   * Get order book snapshot
   *
   * @param loanToken - The loan token address
   * @param maturity - The maturity date
   * @param depth - Maximum number of orders to return per side
   * @returns Order book snapshot
   */
  getOrderBook(loanToken: string, maturity: number, depth: number = 10): OrderBookSnapshot {
    return this.orderBook.getOrderBookSnapshot(loanToken, maturity, depth);
  }

  /**
   * Get all matches for an order
   *
   * @param orderId - The order ID
   * @returns Array of matches
   */
  getMatches(orderId: string): Match[] {
    return this.executionEngine.getMatchesForOrder(orderId);
  }

  /**
   * Get execution engine statistics
   *
   * @param loanToken - The loan token address
   * @param maturity - The maturity date
   * @returns Statistics object
   */
  getStatistics(
    loanToken: string,
    maturity: number
  ): {
    totalMatches: number;
    totalVolume: bigint;
    averageRate: number;
    minRate: number;
    maxRate: number;
  } | null {
    return this.executionEngine.getStatistics(loanToken, maturity);
  }

  /**
   * Clear all orders and matches
   */
  clear(): void {
    this.orderBook.clear();
    this.executionEngine.clear();
  }
}

