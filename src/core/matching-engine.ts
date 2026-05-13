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
   * Tracks orderIds that have been submitted to this engine.
   *
   * Used to reject duplicate `submitOrder` calls (NATS at-least-once
   * redelivery, backend-v2 retries, attacker replay). Without this set
   * the matching loop would re-execute against a partially-filled book on
   * replay and produce unauthorized fills — the duplicate-guard inside
   * `OrderBook.addOrder` fires too late to prevent that.
   *
   * Hydrated on startup via `syncFromDatabase(orders, recentOrderIds)`
   * with a bounded window (7 days) so a restart doesn't leak the dedup
   * state. Entries are never removed on fill/cancel — once an orderId is
   * seen, it must stay seen until the redelivery window has expired
   * (DB-level `unique(id)` on `orders` is the long-term backstop).
   *
   * Known limitation: this set is unbounded between restarts. At very
   * high order volume the Set can grow without limit; P1 follow-up will
   * add LRU eviction or rely fully on the DB layer for cold tier.
   */
  private submittedOrderIds: Set<string> = new Set();

  /** Serializes snapshot saves to avoid concurrent writes racing on the same files. */
  private saveSnapshotQueue: Promise<void> = Promise.resolve();

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

    // M-12 invariant: the clamp at minBigNumber makes total fee
    // collection mathematically impossible to exceed `totalFee`.
    // Pro-rata rounds UP for each match, but the residual pool
    // (`currentRemaining`) shrinks monotonically and the clamp on the
    // final fill absorbs the rounding overage. Pinned by tests in
    // src/__tests__/settlement-fee-invariant.test.ts.
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
    // M-1 Layer A: reject duplicate submission BEFORE the matching loop runs.
    // Without this guard, a NATS redelivery of a previously-submitted order
    // would re-execute matching against the now-partially-filled book and
    // produce unauthorized fills. The `addOrder` guard inside OrderBook is
    // a defense-in-depth backstop but fires too late on its own.
    if (this.submittedOrderIds.has(order.orderId)) {
      console.warn(`[MatchingEngine] Duplicate submitOrder rejected: ${order.orderId}`);
      return {
        matches: [],
        remainingOrder: null,
        affectedMakerOrders: [],
      };
    }
    this.submittedOrderIds.add(order.orderId);

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

    // Try to match with each market (maturity)
    for (const market of order.markets) {
      const maturity = market.maturity;
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

        // Pre-compute remaining-after for deterministic matchId.
        // Must be done BEFORE recordMatch so the id derivation captures
        // the exact post-match state.
        const lendRemainingAfter = subtractBigNumbers(remainingAmount, matchAmount);
        const borrowRemainingAmount = subtractBigNumbers(
          borrowOrder.remainingAmount,
          matchAmount
        );

        // Create match at borrow order's rate
        const match = this.executionEngine.recordMatch({
          marketId: market.marketId,
          lendOrderId: order.orderId,
          borrowOrderId: borrowOrder.orderId,
          lenderWallet: order.walletAddress,
          borrowerWallet: borrowOrder.walletAddress,
          matchedAmount: matchAmount,
          lendRemainingAfter,
          borrowRemainingAfter: borrowRemainingAmount,
          rate: borrowLimitOrder.rate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: false,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        // Skip downstream effects on duplicate (deterministic matchId
        // re-derivation across restarts).
        if (!match) continue;

        matches.push(match);

        // Apply the remaining-amount updates we computed above.
        remainingAmount = lendRemainingAfter;

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

    // Try to match with each market (maturity)
    for (const market of order.markets) {
      const maturity = market.maturity;
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

        // Pre-compute remaining-after for deterministic matchId.
        const lendRemainingAfter = subtractBigNumbers(remainingAmount, matchAmount);
        const borrowRemainingAmount = subtractBigNumbers(
          borrowOrder.remainingAmount,
          matchAmount
        );

        const match = this.executionEngine.recordMatch({
          marketId: market.marketId,
          lendOrderId: order.orderId,
          borrowOrderId: borrowOrder.orderId,
          lenderWallet: order.walletAddress,
          borrowerWallet: borrowOrder.walletAddress,
          matchedAmount: matchAmount,
          lendRemainingAfter,
          borrowRemainingAfter: borrowRemainingAmount,
          rate: executionRate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: false,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        if (!match) continue;

        matches.push(match);

        // Apply the precomputed remaining amount for the lend side.
        remainingAmount = lendRemainingAfter;

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

    // Try to match with each market (maturity)
    for (const market of order.markets) {
      const maturity = market.maturity;
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

        // Pre-compute remaining-after for deterministic matchId.
        const borrowRemainingAfter = subtractBigNumbers(remainingAmount, matchAmount);
        const lendRemainingAmount = subtractBigNumbers(lendOrder.remainingAmount, matchAmount);

        // Create match at lend order's rate
        const match = this.executionEngine.recordMatch({
          marketId: market.marketId,
          lendOrderId: lendOrder.orderId,
          borrowOrderId: order.orderId,
          lenderWallet: lendOrder.walletAddress,
          borrowerWallet: order.walletAddress,
          matchedAmount: matchAmount,
          lendRemainingAfter: lendRemainingAmount,
          borrowRemainingAfter,
          rate: lendLimitOrder.rate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: true,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        if (!match) continue;

        matches.push(match);

        // Apply the precomputed remaining amount for the borrow side.
        remainingAmount = borrowRemainingAfter;

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

    // Try to match with each market (maturity)
    for (const market of order.markets) {
      const maturity = market.maturity;
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

        // Pre-compute remaining-after for deterministic matchId.
        const borrowRemainingAfter = subtractBigNumbers(remainingAmount, matchAmount);
        const lendRemainingAmount = subtractBigNumbers(lendOrder.remainingAmount, matchAmount);

        const match = this.executionEngine.recordMatch({
          marketId: market.marketId,
          lendOrderId: lendOrder.orderId,
          borrowOrderId: order.orderId,
          lenderWallet: lendOrder.walletAddress,
          borrowerWallet: order.walletAddress,
          matchedAmount: matchAmount,
          lendRemainingAfter: lendRemainingAmount,
          borrowRemainingAfter,
          rate: executionRate,
          loanToken: order.loanToken,
          maturity,
          borrowerIsTaker: true,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount,
          borrowerSettlementFeeAmount,
        });

        if (!match) continue;

        matches.push(match);

        // Apply the precomputed remaining amount for the borrow side.
        remainingAmount = borrowRemainingAfter;

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
   * Get order info needed for status message publishing.
   *
   * @param orderId - The order ID
   * @returns Order info if found, null otherwise
   */
  getOrderInfo(orderId: string): {
    originalAmount: string;
    remainingAmount: string;
    settlementFeeAmount: string;
    remainingSettlementFeeAmount: string;
  } | null {
    const order = this.orderBook.getOrder(orderId);
    if (!order) return null;
    return {
      originalAmount: order.originalAmount,
      remainingAmount: order.remainingAmount,
      settlementFeeAmount: order.settlementFeeAmount,
      remainingSettlementFeeAmount:
        (order as any).remainingSettlementFeeAmount ?? order.settlementFeeAmount,
    };
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

    const previous = this.saveSnapshotQueue;
    let resolveNext!: () => void;
    this.saveSnapshotQueue = new Promise<void>((resolve) => {
      resolveNext = resolve;
    });

    await previous;
    try {
      await this.snapshotService.saveSnapshot(
        this.orderBook,
        this.executionEngine,
        Array.from(this.submittedOrderIds)
      );
    } catch (error) {
      // Log but don't throw - snapshot failures shouldn't block operations
      console.error('Failed to save snapshot:', error);
    } finally {
      resolveNext();
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

      // Restore M-1 Layer A dedup set (v1.1.0+; v1.0.0 snapshots have an
      // empty array per the schema default — DB sync will hydrate instead).
      this.submittedOrderIds = new Set(snapshotData.submittedOrderIds);
      if (snapshotData.version === '1.0.0') {
        console.warn(
          '[MatchingEngine] Loaded v1.0.0 snapshot; submittedOrderIds will be hydrated from DB.'
        );
      }

      console.log(
        `State restored from snapshot: ${snapshotData.metadata.orderCount} orders, ${snapshotData.metadata.matchCount} matches, ${this.submittedOrderIds.size} dedup ids`
      );
      return true;
    } catch (error) {
      console.error('Failed to restore from snapshot:', error);
      return false;
    }
  }

  /**
   * Sync the in-memory order book with active orders from the database.
   *
   * Adds any orders that exist in the database but are missing from the
   * in-memory order book. This is additive only — it does not remove orders
   * that are in memory but not in the database.
   *
   * Also hydrates the `submittedOrderIds` Set from `recentOrderIds` so the
   * M-1 Layer A duplicate-submit guard survives a restart. Pass IDs of all
   * orders (any status) within the redelivery window (~7 days recommended).
   *
   * Should be called on startup after snapshot restore to ensure consistency.
   *
   * @param dbOrders - Active orders loaded from the database (status IN OPEN, PARTIALLY_FILLED)
   * @param recentOrderIds - All orderIds within the redelivery window for dedup hydration
   * @returns Counts of added and skipped orders, plus hydrated dedup set size
   */
  syncFromDatabase(
    dbOrders: Order[],
    recentOrderIds: string[] = []
  ): { added: number; skipped: number; dedupHydrated: number } {
    let added = 0;
    let skipped = 0;

    for (const order of dbOrders) {
      if (this.orderBook.getOrder(order.orderId)) {
        skipped++;
        continue;
      }
      if (!isZero(order.remainingAmount)) {
        this.orderBook.addOrder(order);
        added++;
      }
    }

    // M-1 Layer A: hydrate submittedOrderIds with all orderIds in the
    // redelivery window. Includes FILLED and CANCELLED orders so a
    // post-completion replay is also rejected.
    for (const id of recentOrderIds) {
      this.submittedOrderIds.add(id);
    }

    return { added, skipped, dedupHydrated: this.submittedOrderIds.size };
  }

  /**
   * Direct access to submittedOrderIds for snapshot persistence.
   *
   * @returns Array of all submitted order IDs currently tracked.
   */
  getSubmittedOrderIds(): string[] {
    return Array.from(this.submittedOrderIds);
  }

  /**
   * Restore submittedOrderIds from a snapshot.
   *
   * @param ids - Array of order IDs to restore into the dedup set.
   */
  restoreSubmittedOrderIds(ids: string[]): void {
    this.submittedOrderIds = new Set(ids);
  }
}

