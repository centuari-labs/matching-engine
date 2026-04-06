import { OrderBook } from './order-book';
import { ExecutionEngine } from './execution-engine';
import type { Order, LendLimitOrder, BorrowLimitOrder } from '../types/orders';
import { OrderSide, OrderStatus, isLimitOrder } from '../types/orders';
import type { Match, MatchResult, OrderBookSnapshot, AffectedOrder } from '../types/matches';
import type { SettlementPublisher } from '../types/settlement';
import type { BufferStats, BufferEventHandler } from '../types/buffer';
import type { SnapshotService } from '../services/snapshot-service';
import {
  minBigNumber,
  subtractBigNumbers,
  isZero,
  calculateMakerFee,
  calculateTakerFee,
  calculateProRataSettlementFee,
} from '../utils/helpers';
import { createLogger } from '../utils/logger';

const log = createLogger('matching-engine');

/**
 * MatchingEngine is the core component that matches lend and borrow orders
 */
export class MatchingEngine {
  private orderBook: OrderBook;
  private executionEngine: ExecutionEngine;
  private snapshotService: SnapshotService | null;

  /** Serializes snapshot saves to avoid concurrent writes racing on the same files. */
  private saveSnapshotQueue: Promise<void> = Promise.resolve();

  /**
   * Create a new MatchingEngine instance
   *
   * @param settlementPublisher - Optional publisher for settlement matches (e.g., Redis)
   * @param snapshotService - Optional snapshot service for state persistence
   * @param bufferEventHandler - Optional handler for buffer events (retry, thresholds, disk spill)
   * @param warningThresholds - Buffer size thresholds that trigger warnings
   * @param diskSpillThreshold - Buffer size that triggers disk spill
   * @param maxBufferSize - Hard cap on buffer size (0 = unlimited)
   */
  constructor(
    settlementPublisher?: SettlementPublisher,
    snapshotService?: SnapshotService,
    bufferEventHandler?: BufferEventHandler,
    warningThresholds: number[] = [],
    diskSpillThreshold: number = 0,
    maxBufferSize: number = 0
  ) {
    this.orderBook = new OrderBook();
    this.executionEngine = new ExecutionEngine(
      settlementPublisher,
      bufferEventHandler,
      warningThresholds,
      diskSpillThreshold,
      maxBufferSize
    );
    this.snapshotService = snapshotService ?? null;
  }

  /**
   * Get the execution engine instance
   *
   * Used by the retry service to call retryPublish on individual matches.
   */
  getExecutionEngine(): ExecutionEngine {
    return this.executionEngine;
  }

  /**
   * Get buffer statistics for monitoring
   */
  getBufferStats(): BufferStats {
    return this.executionEngine.getBufferStats();
  }

  /**
   * Calculate the settlement fee for a single match (pure — no mutation).
   *
   * Computes a pro-rata fee (rounded up), clamped to the caller-provided
   * remaining pool, and returns both the fee charged and the new remaining.
   *
   * @param order - The order paying the settlement fee
   * @param matchedAmount - Matched amount for this fill
   * @param currentRemaining - Current remaining settlement fee pool
   * @returns The actual fee charged and the updated remaining pool
   */
  private calculateSettlementFee(
    order: Order,
    matchedAmount: string,
    currentRemaining: string
  ): { actualFee: string; remainingAfter: string } {
    const proRata = calculateProRataSettlementFee(
      order.settlementFeeAmount,
      matchedAmount,
      order.originalAmount
    );
    const actualFee = minBigNumber(proRata, currentRemaining);
    const remainingAfter = subtractBigNumbers(currentRemaining, actualFee);
    return { actualFee, remainingAfter };
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

    const takerRemainingFee = this.matchAgainstBook(order, matches, affectedMakerOrders);

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
      takerRemainingSettlementFeeAmount: takerRemainingFee,
    };
  }

  /**
   * Match a taker order against the opposite side of the order book.
   *
   * Handles all four combinations (lend/borrow × market/limit) in a single
   * loop.  Behaviour is driven by `order.side` and `order.type`:
   *
   *  - **Side** determines which book side to scan, which wallet is
   *    lender/borrower, and the `borrowerIsTaker` flag.
   *  - **Type** determines rate filtering (market orders accept any rate;
   *    limit orders enforce a minimum/maximum) and whether the remainder is
   *    added to the book (limit) or discarded (market / IOC).
   *
   * @returns The taker's remaining settlement fee pool after all matches
   */
  private matchAgainstBook(
    order: Order,
    matches: Match[],
    affectedMakerOrders: AffectedOrder[]
  ): string {
    const takerIsLender = order.side === OrderSide.Lend;
    const takerIsLimit = isLimitOrder(order);
    const makerSide = takerIsLender ? OrderSide.Borrow : OrderSide.Lend;

    let remainingAmount = order.remainingAmount;
    let takerRemainingFee = order.settlementFeeAmount;

    for (const market of order.markets) {
      if (isZero(remainingAmount)) break;

      const makerOrders = this.orderBook.getBestOrders(makerSide, order.loanToken, market.maturity);

      for (const makerOrder of makerOrders) {
        if (isZero(remainingAmount)) break;

        // Skip self-matching
        if (order.walletAddress.toLowerCase() === makerOrder.walletAddress.toLowerCase()) {
          continue;
        }

        // Only match against limit orders (they have a rate to execute at)
        if (!isLimitOrder(makerOrder)) continue;

        const makerRate = (makerOrder as LendLimitOrder | BorrowLimitOrder).rate;

        // Rate filtering for limit taker orders
        if (takerIsLimit) {
          const takerRate = (order as LendLimitOrder | BorrowLimitOrder).rate;
          if (takerIsLender) {
            // Lender wants minimum rate; skip if maker's borrow rate is too low
            if (makerRate < takerRate) continue;
          } else {
            // Borrower accepts maximum rate; stop if maker's lend rate is too high
            // (lend orders are sorted ascending, so all subsequent are higher)
            if (makerRate > takerRate) break;
          }
        }

        // Calculate match amount
        const matchAmount = minBigNumber(remainingAmount, makerOrder.remainingAmount);

        // Calculate trading fees
        const makerFeeAmount = calculateMakerFee(matchAmount);
        const takerFeeAmount = calculateTakerFee(matchAmount);

        // Calculate settlement fees (both sides pay from their own fee pools)
        const makerCurrentFee =
          makerOrder.remainingSettlementFeeAmount ?? makerOrder.settlementFeeAmount;

        const takerFeeResult = this.calculateSettlementFee(order, matchAmount, takerRemainingFee);
        const makerFeeResult = this.calculateSettlementFee(
          makerOrder,
          matchAmount,
          makerCurrentFee
        );

        takerRemainingFee = takerFeeResult.remainingAfter;

        // Record the match — assign lender/borrower roles based on taker side
        const match = this.executionEngine.recordMatch({
          marketId: market.marketId,
          lendOrderId: takerIsLender ? order.orderId : makerOrder.orderId,
          borrowOrderId: takerIsLender ? makerOrder.orderId : order.orderId,
          lenderWallet: takerIsLender ? order.walletAddress : makerOrder.walletAddress,
          borrowerWallet: takerIsLender ? makerOrder.walletAddress : order.walletAddress,
          matchedAmount: matchAmount,
          rate: makerRate,
          loanToken: order.loanToken,
          maturity: market.maturity,
          borrowerIsTaker: !takerIsLender,
          makerFeeAmount,
          takerFeeAmount,
          lenderSettlementFeeAmount: takerIsLender
            ? takerFeeResult.actualFee
            : makerFeeResult.actualFee,
          borrowerSettlementFeeAmount: takerIsLender
            ? makerFeeResult.actualFee
            : takerFeeResult.actualFee,
        });

        matches.push(match);

        // Update remaining amounts
        remainingAmount = subtractBigNumbers(remainingAmount, matchAmount);
        const makerRemainingAmount = subtractBigNumbers(makerOrder.remainingAmount, matchAmount);

        // Update maker order in book and track as affected
        const makerStatus = isZero(makerRemainingAmount)
          ? OrderStatus.Filled
          : OrderStatus.PartiallyFilled;

        if (isZero(makerRemainingAmount)) {
          this.orderBook.removeOrder(makerOrder.orderId);
        } else {
          this.orderBook.updateOrderAmount(
            makerOrder.orderId,
            makerRemainingAmount,
            makerFeeResult.remainingAfter
          );
        }

        affectedMakerOrders.push({
          orderId: makerOrder.orderId,
          status: makerStatus,
          remainingAmount: makerRemainingAmount,
          originalAmount: makerOrder.originalAmount,
          settlementFeeAmount: makerOrder.settlementFeeAmount,
          remainingSettlementFeeAmount: makerFeeResult.remainingAfter,
        });
      }
    }

    // Limit orders: add remainder to the book if not fully filled
    // Market orders: IOC — never added to the book
    if (takerIsLimit && !isZero(remainingAmount)) {
      this.orderBook.addOrder({
        ...order,
        remainingAmount,
        remainingSettlementFeeAmount: takerRemainingFee,
        status: matches.length > 0 ? OrderStatus.PartiallyFilled : OrderStatus.Open,
      });
    }

    return takerRemainingFee;
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
      remainingSettlementFeeAmount: order.remainingSettlementFeeAmount ?? order.settlementFeeAmount,
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
      await this.snapshotService.saveSnapshot(this.orderBook, this.executionEngine);
    } catch (error) {
      // Log but don't throw - snapshot failures shouldn't block operations
      log.error({ err: error }, 'failed to save snapshot');
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
      log.warn({ err: error }, 'async snapshot save failed');
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

      log.info(
        {
          orderCount: snapshotData.metadata.orderCount,
          matchCount: snapshotData.metadata.matchCount,
        },
        'state restored from snapshot'
      );
      return true;
    } catch (error) {
      log.error({ err: error }, 'failed to restore from snapshot');
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
   * Should be called on startup after snapshot restore to ensure consistency.
   *
   * @param dbOrders - Active orders loaded from the database
   * @returns Counts of added and skipped orders
   */
  syncFromDatabase(dbOrders: Order[]): { added: number; skipped: number } {
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

    return { added, skipped };
  }
}
