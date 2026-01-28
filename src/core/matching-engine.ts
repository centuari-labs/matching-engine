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
import type { Match, MatchResult, OrderBookSnapshot, AffectedOrder } from '../types/matches';
import type { SettlementPublisher } from '../types/settlement';
import type { SnapshotService } from '../services/snapshot-service';
import {
  minBigNumber,
  subtractBigNumbers,
  isZero,
  calculateMakerFee,
  calculateTakerFee,
  calculateProRataSettlementFee,
} from '../utils/helpers';

/**
 * MatchingEngine is the core component that matches lend and borrow orders
 */
export class MatchingEngine {
  private orderBook: OrderBook;
  private executionEngine: ExecutionEngine;
  private snapshotService: SnapshotService | null;

  /**
   * Create a new MatchingEngine instance
   *
   * @param settlementPublisher - Optional publisher for settlement matches (e.g., Redis)
   * @param snapshotService - Optional snapshot service for state persistence
   */
  constructor(settlementPublisher?: SettlementPublisher, snapshotService?: SnapshotService) {
    this.orderBook = new OrderBook();
    this.executionEngine = new ExecutionEngine(settlementPublisher);
    this.snapshotService = snapshotService ?? null;
  }

  /**
   * Calculate and deduct the settlement fee for a single match for a given order.
   *
   * Uses the order's total settlementFeeAmount as the full-fee pool and
   * tracks a remaining pool in-memory keyed by orderId. For a match with
   * matchedAmount, it:
   *  - Computes a pro-rata fee with rounding up
   *  - Clamps it to the remaining pool to avoid over-collection
   *  - Deducts the actual fee from the remaining pool
   *
   * @param order - The order paying the settlement fee
   * @param matchedAmount - Matched amount for this fill
   * @returns The actual fee charged for this match
   */
  private calculateAndConsumeSettlementFee(order: Order, matchedAmount: string): string {
    const totalFee = order.settlementFeeAmount;
    const originalAmount = order.originalAmount;

    // Initialize remainingSettlementFeeAmount lazily if it is not set (for
    // backwards compatibility in tests or any internal callers that only set
    // settlementFeeAmount).
    const currentRemaining =
      (order as any).remainingSettlementFeeAmount ?? order.settlementFeeAmount;

    const proRata = calculateProRataSettlementFee(totalFee, matchedAmount, originalAmount);
    const actualFee = minBigNumber(proRata, currentRemaining);

    const remainingAfter = subtractBigNumbers(currentRemaining, actualFee);
    (order as any).remainingSettlementFeeAmount = remainingAfter;

    return actualFee;
  }

  /**
   * Submit an order to the matching engine
   * The order will be matched against existing orders and added to the order book if not fully filled
   *
   * @param order - The order to submit
   * @returns Match result containing matches, remaining order info, and affected maker orders
   */
  submitOrder(order: Order): MatchResult {
    const matches: Match[] = [];
    const affectedMakerOrders: AffectedOrder[] = [];

    if (order.side === OrderSide.Lend) {
      // Match lend order against borrow orders
      if (order.type === OrderType.Market) {
        this.matchLendMarketOrder(order as LendMarketOrder, matches, affectedMakerOrders);
      } else {
        this.matchLendLimitOrder(order as LendLimitOrder, matches, affectedMakerOrders);
      }
    } else {
      // Match borrow order against lend orders
      if (order.type === OrderType.Market) {
        this.matchBorrowMarketOrder(order as BorrowMarketOrder, matches, affectedMakerOrders);
      } else {
        this.matchBorrowLimitOrder(order as BorrowLimitOrder, matches, affectedMakerOrders);
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

    // Save snapshot after order submission (non-blocking)
    this.saveSnapshotAsync();

    return {
      matches,
      remainingOrder,
      affectedMakerOrders,
    };
  }

  /**
   * Match a lend market order against borrow limit orders
   * Market orders match at the best available rate (highest borrow rate)
   */
  private matchLendMarketOrder(
    order: LendMarketOrder,
    matches: Match[],
    affectedMakerOrders: AffectedOrder[]
  ): void {
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

        // Calculate trading fees
        const makerFeeAmount = calculateMakerFee(matchAmount);
        const takerFeeAmount = calculateTakerFee(matchAmount);
        // borrowerIsTaker is false, so borrower is maker, lender (order) is taker

        // Calculate settlement fees (both sides pay from their own fee pools)
        const lenderSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          order,
          matchAmount
        );
        const borrowerSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          borrowOrder,
          matchAmount
        );

        // Create match at borrow order's rate
        const match = this.executionEngine.recordMatch({
          lendOrderId: order.orderId,
          borrowOrderId: borrowOrder.orderId,
          lenderWallet: order.walletAddress,
          borrowerWallet: borrowOrder.walletAddress,
          matchedAmount: matchAmount,
          rate: borrowLimitOrder.rate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: false,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const borrowRemainingAmount = subtractBigNumbers(
          borrowOrder.remainingAmount,
          matchAmount
        );

        // Update borrow order in order book and track affected order
        if (isZero(borrowRemainingAmount)) {
          this.orderBook.removeOrder(borrowOrder.orderId);
          affectedMakerOrders.push({
            orderId: borrowOrder.orderId,
            status: OrderStatus.Filled,
            remainingAmount: borrowRemainingAmount,
            originalAmount: borrowOrder.originalAmount,
            settlementFeeAmount: borrowOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (borrowOrder as any).remainingSettlementFeeAmount,
          });
        } else {
          this.orderBook.updateOrderAmount(borrowOrder.orderId, borrowRemainingAmount);
          affectedMakerOrders.push({
            orderId: borrowOrder.orderId,
            status: OrderStatus.PartiallyFilled,
            remainingAmount: borrowRemainingAmount,
            originalAmount: borrowOrder.originalAmount,
            settlementFeeAmount: borrowOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (borrowOrder as any).remainingSettlementFeeAmount,
          });
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
  private matchLendLimitOrder(
    order: LendLimitOrder,
    matches: Match[],
    affectedMakerOrders: AffectedOrder[]
  ): void {
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

        // Calculate match amount
        const matchAmount = minBigNumber(remainingAmount, borrowOrder.remainingAmount);

        // Calculate trading fees
        const makerFeeAmount = calculateMakerFee(matchAmount);
        const takerFeeAmount = calculateTakerFee(matchAmount);
        // borrowerIsTaker is false, so borrower is maker, lender (order) is taker

        // Calculate settlement fees (both sides pay from their own fee pools)
        const lenderSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          order,
          matchAmount
        );
        const borrowerSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          borrowOrder,
          matchAmount
        );

        const match = this.executionEngine.recordMatch({
          lendOrderId: order.orderId,
          borrowOrderId: borrowOrder.orderId,
          lenderWallet: order.walletAddress,
          borrowerWallet: borrowOrder.walletAddress,
          matchedAmount: matchAmount,
          rate: executionRate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: false,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const borrowRemainingAmount = subtractBigNumbers(
          borrowOrder.remainingAmount,
          matchAmount
        );

        // Update borrow order in order book and track affected order
        if (isZero(borrowRemainingAmount)) {
          this.orderBook.removeOrder(borrowOrder.orderId);
          affectedMakerOrders.push({
            orderId: borrowOrder.orderId,
            status: OrderStatus.Filled,
            remainingAmount: borrowRemainingAmount,
            originalAmount: borrowOrder.originalAmount,
            settlementFeeAmount: borrowOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (borrowOrder as any).remainingSettlementFeeAmount,
          });
        } else {
          this.orderBook.updateOrderAmount(borrowOrder.orderId, borrowRemainingAmount);
          affectedMakerOrders.push({
            orderId: borrowOrder.orderId,
            status: OrderStatus.PartiallyFilled,
            remainingAmount: borrowRemainingAmount,
            originalAmount: borrowOrder.originalAmount,
            settlementFeeAmount: borrowOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (borrowOrder as any).remainingSettlementFeeAmount,
          });
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
  private matchBorrowMarketOrder(
    order: BorrowMarketOrder,
    matches: Match[],
    affectedMakerOrders: AffectedOrder[]
  ): void {
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

        // Calculate trading fees
        const makerFeeAmount = calculateMakerFee(matchAmount);
        const takerFeeAmount = calculateTakerFee(matchAmount);
        // borrowerIsTaker is true, so borrower (order) is taker, lender is maker

        // Calculate settlement fees (both sides pay from their own fee pools)
        const lenderSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          lendOrder,
          matchAmount
        );
        const borrowerSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          order,
          matchAmount
        );

        // Create match at lend order's rate
        const match = this.executionEngine.recordMatch({
          lendOrderId: lendOrder.orderId,
          borrowOrderId: order.orderId,
          lenderWallet: lendOrder.walletAddress,
          borrowerWallet: order.walletAddress,
          matchedAmount: matchAmount,
          rate: lendLimitOrder.rate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: true,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const lendRemainingAmount = subtractBigNumbers(lendOrder.remainingAmount, matchAmount);

        // Update lend order in order book and track affected order
        if (isZero(lendRemainingAmount)) {
          this.orderBook.removeOrder(lendOrder.orderId);
          affectedMakerOrders.push({
            orderId: lendOrder.orderId,
            status: OrderStatus.Filled,
            remainingAmount: lendRemainingAmount,
            originalAmount: lendOrder.originalAmount,
            settlementFeeAmount: lendOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (lendOrder as any).remainingSettlementFeeAmount,
          });
        } else {
          this.orderBook.updateOrderAmount(lendOrder.orderId, lendRemainingAmount);
          affectedMakerOrders.push({
            orderId: lendOrder.orderId,
            status: OrderStatus.PartiallyFilled,
            remainingAmount: lendRemainingAmount,
            originalAmount: lendOrder.originalAmount,
            settlementFeeAmount: lendOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (lendOrder as any).remainingSettlementFeeAmount,
          });
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
  private matchBorrowLimitOrder(
    order: BorrowLimitOrder,
    matches: Match[],
    affectedMakerOrders: AffectedOrder[]
  ): void {
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

        // Calculate trading fees
        const makerFeeAmount = calculateMakerFee(matchAmount);
        const takerFeeAmount = calculateTakerFee(matchAmount);
        // borrowerIsTaker is true, so borrower (order) is taker, lender is maker

        // Calculate settlement fees (both sides pay from their own fee pools)
        const lenderSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          lendOrder,
          matchAmount
        );
        const borrowerSettlementFeeAmount = this.calculateAndConsumeSettlementFee(
          order,
          matchAmount
        );

        const match = this.executionEngine.recordMatch({
          lendOrderId: lendOrder.orderId,
          borrowOrderId: order.orderId,
          lenderWallet: lendOrder.walletAddress,
          borrowerWallet: order.walletAddress,
          matchedAmount: matchAmount,
          rate: executionRate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: true,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const lendRemainingAmount = subtractBigNumbers(lendOrder.remainingAmount, matchAmount);

        // Update lend order in order book and track affected order
        if (isZero(lendRemainingAmount)) {
          this.orderBook.removeOrder(lendOrder.orderId);
          affectedMakerOrders.push({
            orderId: lendOrder.orderId,
            status: OrderStatus.Filled,
            remainingAmount: lendRemainingAmount,
            originalAmount: lendOrder.originalAmount,
            settlementFeeAmount: lendOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (lendOrder as any).remainingSettlementFeeAmount,
          });
        } else {
          this.orderBook.updateOrderAmount(lendOrder.orderId, lendRemainingAmount);
          affectedMakerOrders.push({
            orderId: lendOrder.orderId,
            status: OrderStatus.PartiallyFilled,
            remainingAmount: lendRemainingAmount,
            originalAmount: lendOrder.originalAmount,
            settlementFeeAmount: lendOrder.settlementFeeAmount,
            remainingSettlementFeeAmount: (lendOrder as any).remainingSettlementFeeAmount,
          });
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
   * @returns True if order was cancelled, false if not found, wallet address doesn't match, or order is not cancellable
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

    // Only allow cancellation of open or partially filled orders
    if (order.status !== OrderStatus.Open && order.status !== OrderStatus.PartiallyFilled) {
      return false;
    }

    // Remove from order book
    this.orderBook.removeOrder(orderId);

    // Save snapshot after order cancellation (non-blocking)
    this.saveSnapshotAsync();

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

  /**
   * Save snapshot of current state
   *
   * Saves the current order book and execution engine state to persistent storage.
   * This is called automatically after critical operations, but can also be called manually.
   *
   * @returns Promise that resolves when snapshot is saved
   */
  async saveSnapshot(): Promise<void> {
    if (!this.snapshotService) {
      return;
    }

    try {
      await this.snapshotService.saveSnapshot(this.orderBook, this.executionEngine);
    } catch (error) {
      // Log but don't throw - snapshot failures shouldn't block operations
      console.error('Failed to save snapshot:', error);
    }
  }

  /**
   * Save snapshot asynchronously (fire-and-forget)
   *
   * Non-blocking version of saveSnapshot for use after critical operations.
   */
  private saveSnapshotAsync(): void {
    if (!this.snapshotService) {
      return;
    }

    // Fire-and-forget - don't await
    this.saveSnapshot().catch((error) => {
      // Already logged in saveSnapshot, but catch to prevent unhandled rejection
      console.warn('Async snapshot save failed:', error);
    });
  }

  /**
   * Restore state from snapshot
   *
   * Loads and restores the order book and execution engine state from persistent storage.
   * Should be called on startup to resume operations from the last saved state.
   *
   * @returns True if snapshot was successfully restored, false otherwise
   */
  async restoreFromSnapshot(): Promise<boolean> {
    if (!this.snapshotService) {
      return false;
    }

    try {
      const snapshotData = await this.snapshotService.loadSnapshot();
      if (!snapshotData) {
        return false;
      }

      // Restore order book
      this.orderBook.restoreFromOrders(snapshotData.orders);

      // Restore execution engine
      this.executionEngine.restoreMatches(snapshotData.matches);

      console.log(
        `State restored from snapshot: ${snapshotData.metadata.orderCount} orders, ${snapshotData.metadata.matchCount} matches`
      );
      return true;
    } catch (error) {
      console.error('Failed to restore from snapshot:', error);
      return false;
    }
  }
}

