import createRBTree from 'functional-red-black-tree';
import type { Order, OrderMetadata } from '../types/orders';
import { OrderStatus, OrderSide } from '../types/orders';
import { createOrderComparator, isZero } from '../utils/helpers';

/**
 * Type alias for Red-Black Tree from functional-red-black-tree
 */
type RBTree = createRBTree.Tree<Order, null>;

/**
 * OrderBook manages all orders using Red-Black Trees for efficient price-time priority matching
 */
export class OrderBook {
  // Main order books indexed by (loanToken, maturity)
  private lendOrders: Map<string, Map<number, RBTree>>;
  private borrowOrders: Map<string, Map<number, RBTree>>;

  // Order metadata for O(1) lookups by orderId
  private orderIndex: Map<string, OrderMetadata & { order: Order }>;

  // Per-wallet open-order count (key = lowercased wallet address). Kept in sync
  // with `orderIndex` on every add/remove/clear so the unbounded-book guard
  // (per-wallet cap) is O(1).
  private walletOrderCounts: Map<string, number>;

  // Comparators for tree ordering
  private lendComparator: (a: Order, b: Order) => number;
  private borrowComparator: (a: Order, b: Order) => number;

  constructor() {
    this.lendOrders = new Map();
    this.borrowOrders = new Map();
    this.orderIndex = new Map();
    this.walletOrderCounts = new Map();
    this.lendComparator = createOrderComparator(OrderSide.Lend);
    this.borrowComparator = createOrderComparator(OrderSide.Borrow);
  }

  /**
   * Add an order to the order book
   *
   * @param order - The order to add
   */
  addOrder(order: Order): void {
    // Maintain the per-wallet count, but only for genuinely new orderIds — a
    // re-add of an existing id (e.g. updateOrderAmount remove→re-add) must not
    // double-count.
    if (!this.orderIndex.has(order.orderId)) {
      const walletKey = order.walletAddress.toLowerCase();
      this.walletOrderCounts.set(walletKey, (this.walletOrderCounts.get(walletKey) ?? 0) + 1);
    }

    // Store order metadata for quick lookups
    this.orderIndex.set(order.orderId, {
      orderId: order.orderId,
      walletAddress: order.walletAddress,
      loanToken: order.loanToken,
      markets: order.markets,
      side: order.side,
      type: order.type,
      order,
    });

    // Add to appropriate trees for each market (maturity)
    const orderMap = order.side === OrderSide.Lend ? this.lendOrders : this.borrowOrders;
    const comparator = order.side === OrderSide.Lend ? this.lendComparator : this.borrowComparator;

    for (const market of order.markets) {
      const maturity = market.maturity;
      // Get or create token map
      if (!orderMap.has(order.loanToken)) {
        orderMap.set(order.loanToken, new Map());
      }
      const tokenMap = orderMap.get(order.loanToken)!;

      // Get or create tree for this maturity
      let tree = tokenMap.get(maturity);
      if (!tree) {
        tree = createRBTree(comparator);
        tokenMap.set(maturity, tree);
      }

      // Insert order into tree
      tokenMap.set(maturity, tree.insert(order, null));
    }
  }

  /**
   * Remove an order from the order book
   *
   * @param orderId - The ID of the order to remove
   * @returns True if order was removed, false if not found
   */
  removeOrder(orderId: string): boolean {
    const metadata = this.orderIndex.get(orderId);
    if (!metadata) {
      return false;
    }

    const orderMap = metadata.side === OrderSide.Lend ? this.lendOrders : this.borrowOrders;

    // Remove from all market (maturity) trees
    const tokenMap = orderMap.get(metadata.loanToken);
    if (tokenMap) {
      for (const market of metadata.markets) {
        const maturity = market.maturity;
        let tree = tokenMap.get(maturity);
        if (tree) {
          // Remove the order from the tree
          tree = tree.remove(metadata.order);
          if (tree.length === 0) {
            tokenMap.delete(maturity);
          } else {
            tokenMap.set(maturity, tree);
          }
        }
      }

      if (tokenMap.size === 0) {
        orderMap.delete(metadata.loanToken);
      }
    }

    // Remove from index and decrement the per-wallet count.
    this.orderIndex.delete(orderId);
    const walletKey = metadata.walletAddress.toLowerCase();
    const nextCount = (this.walletOrderCounts.get(walletKey) ?? 1) - 1;
    if (nextCount <= 0) {
      this.walletOrderCounts.delete(walletKey);
    } else {
      this.walletOrderCounts.set(walletKey, nextCount);
    }
    return true;
  }

  /**
   * Update an order's remaining amount and optionally its remaining settlement fee.
   *
   * @param orderId - The ID of the order to update
   * @param newRemainingAmount - The new remaining amount
   * @param remainingSettlementFeeAmount - Optional updated remaining settlement fee
   * @returns True if updated successfully
   */
  updateOrderAmount(
    orderId: string,
    newRemainingAmount: string,
    remainingSettlementFeeAmount?: string
  ): boolean {
    const metadata = this.orderIndex.get(orderId);
    if (!metadata) {
      return false;
    }

    // Remove old order
    this.removeOrder(orderId);

    // Create updated order - preserve all fields from the original order
    const updatedOrder: Order = {
      ...metadata.order,
      remainingAmount: newRemainingAmount,
      status: isZero(newRemainingAmount) ? OrderStatus.Filled : OrderStatus.PartiallyFilled,
      ...(remainingSettlementFeeAmount !== undefined && { remainingSettlementFeeAmount }),
    };

    // Re-add if not fully filled
    if (!isZero(newRemainingAmount)) {
      this.addOrder(updatedOrder);
    }

    return true;
  }

  /**
   * Get orders from the order book that could match
   *
   * @param side - The side to get orders from (opposite of incoming order)
   * @param loanToken - The loan token address
   * @param maturity - The maturity date
   * @returns Array of orders in price-time priority order
   */
  getBestOrders(side: OrderSide, loanToken: string, maturity: number): Order[] {
    const orderMap = side === OrderSide.Lend ? this.lendOrders : this.borrowOrders;
    const tokenMap = orderMap.get(loanToken);

    if (!tokenMap) {
      return [];
    }

    const tree = tokenMap.get(maturity);
    if (!tree) {
      return [];
    }

    // Collect all orders from the tree in sorted order
    const orders: Order[] = [];
    const iterator = tree.begin;

    while (iterator.valid) {
      orders.push(iterator.key as Order);
      iterator.next(); // Mutates iterator in place
    }

    return orders;
  }

  /**
   * Get an order by ID
   *
   * @param orderId - The order ID
   * @returns The order if found, null otherwise
   */
  getOrder(orderId: string): Order | null {
    const metadata = this.orderIndex.get(orderId);
    return metadata ? metadata.order : null;
  }

  /**
   * Get order status
   *
   * @param orderId - The order ID
   * @returns The order status if found, null otherwise
   */
  getOrderStatus(orderId: string): OrderStatus | null {
    const order = this.getOrder(orderId);
    return order ? order.status : null;
  }

  /**
   * Get order book snapshot for a specific token and maturity
   *
   * @param loanToken - The loan token address
   * @param maturity - The maturity date
   * @param depth - Maximum number of orders to return per side
   * @returns Order book snapshot
   */
  getOrderBookSnapshot(
    loanToken: string,
    maturity: number,
    depth: number = 10
  ): {
    loanToken: string;
    maturity: number;
    lendOrders: Array<{
      orderId: string;
      rate?: number;
      amount: string;
      timestamp: number;
    }>;
    borrowOrders: Array<{
      orderId: string;
      rate?: number;
      amount: string;
      timestamp: number;
    }>;
  } {
    const lendOrders = this.getBestOrders(OrderSide.Lend, loanToken, maturity)
      .slice(0, depth)
      .map((order) => ({
        orderId: order.orderId,
        rate: 'rate' in order ? order.rate : undefined,
        amount: order.remainingAmount,
        timestamp: order.timestamp,
      }));

    const borrowOrders = this.getBestOrders(OrderSide.Borrow, loanToken, maturity)
      .slice(0, depth)
      .map((order) => {
        return {
          orderId: order.orderId,
          rate: 'rate' in order ? order.rate : undefined,
          amount: order.remainingAmount,
          timestamp: order.timestamp,
        };
      });

    return {
      loanToken,
      maturity,
      lendOrders,
      borrowOrders,
    };
  }

  /**
   * Clear all orders from the order book
   */
  clear(): void {
    this.lendOrders.clear();
    this.borrowOrders.clear();
    this.orderIndex.clear();
    this.walletOrderCounts.clear();
  }

  /**
   * Get the number of open orders currently resting in the book for a wallet.
   *
   * @param walletAddress - Wallet address (case-insensitive)
   * @returns Open-order count for the wallet (0 if none)
   */
  getWalletOrderCount(walletAddress: string): number {
    return this.walletOrderCounts.get(walletAddress.toLowerCase()) ?? 0;
  }

  /**
   * Get total number of orders in the book
   *
   * @returns Total order count
   */
  get orderCount(): number {
    return this.orderIndex.size;
  }

  /**
   * Get all orders from the order book
   *
   * Used for snapshot serialization. Returns all orders with their current state.
   *
   * @returns Array of all orders in the order book
   */
  getAllOrders(): Order[] {
    return Array.from(this.orderIndex.values()).map((metadata) => metadata.order);
  }

  /**
   * Remove every resting order whose market(s) have all passed maturity, and
   * return the removed orders.
   *
   * A resting order in a matured market can never validly match, so it would
   * otherwise sit on the book forever locking the user's spendable balance. The
   * maturity-expiry sweep calls this, then publishes a CANCELLED status per
   * returned order. An order is only removed when *every* market slot is matured
   * — a multi-maturity order with at least one still-live leg stays on the book.
   *
   * @param nowSeconds - Current time as a unix timestamp in seconds.
   * @returns The orders that were removed (may be empty).
   */
  removeMaturedOrders(nowSeconds: number): Order[] {
    const matured: Order[] = [];
    // Collect first (orderIndex dedupes multi-slot orders), then remove — never
    // mutate the index while iterating it.
    for (const metadata of this.orderIndex.values()) {
      if (metadata.markets.every((market) => market.maturity <= nowSeconds)) {
        matured.push(metadata.order);
      }
    }
    for (const order of matured) {
      this.removeOrder(order.orderId);
    }
    return matured;
  }

  /**
   * Restore order book from serialized orders
   *
   * Rebuilds the order book structure (Red-Black Trees) from a list of orders.
   * Used for snapshot restoration. Clears existing orders before restoring.
   *
   * @param orders - Array of orders to restore
   */
  restoreFromOrders(orders: Order[]): void {
    // Clear existing state
    this.clear();

    // Restore each order
    for (const order of orders) {
      // Only restore orders that are not fully filled
      if (!isZero(order.remainingAmount)) {
        this.addOrder(order);
      }
    }
  }
}
