import { OrderBook } from '../core/order-book';
import { OrderSide, OrderStatus } from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  marketsFromMaturities,
  DEFAULT_LOAN_TOKEN,
  DEFAULT_MATURITY,
} from './factories/order-factory';

describe('OrderBook', () => {
  let book: OrderBook;

  const loanToken = DEFAULT_LOAN_TOKEN;
  const maturity = DEFAULT_MATURITY;
  const SECOND_LOAN_TOKEN = '0xaabbccddee112233445566778899001122334455';
  const SECOND_MATURITY = 1706745600;

  beforeEach(() => {
    book = new OrderBook();
  });

  describe('Basic CRUD', () => {
    it('should add a lend limit order and retrieve it', () => {
      const order = createLendLimitOrder();
      book.addOrder(order);

      expect(book.orderCount).toBe(1);
      expect(book.getOrder(order.orderId)).toEqual(order);
    });

    it('should add a borrow limit order and retrieve it', () => {
      const order = createBorrowLimitOrder();
      book.addOrder(order);

      expect(book.orderCount).toBe(1);
      expect(book.getOrder(order.orderId)).toEqual(order);
    });

    it('should remove an existing order and return true', () => {
      const order = createLendLimitOrder();
      book.addOrder(order);

      const removed = book.removeOrder(order.orderId);

      expect(removed).toBe(true);
      expect(book.getOrder(order.orderId)).toBeNull();
      expect(book.orderCount).toBe(0);
    });

    it('should return false when removing a non-existent order ID', () => {
      const removed = book.removeOrder('non-existent-id');
      expect(removed).toBe(false);
    });

    it('should return null for unknown order ID', () => {
      expect(book.getOrder('unknown-id')).toBeNull();
    });

    it('should return correct status for existing order', () => {
      const order = createLendLimitOrder();
      book.addOrder(order);

      expect(book.getOrderStatus(order.orderId)).toBe(OrderStatus.Open);
    });

    it('should return null status for unknown order ID', () => {
      expect(book.getOrderStatus('unknown-id')).toBeNull();
    });

    it('should clear all orders', () => {
      book.addOrder(createLendLimitOrder());
      book.addOrder(createBorrowLimitOrder());
      book.addOrder(createLendLimitOrder());

      book.clear();

      expect(book.orderCount).toBe(0);
      expect(book.getAllOrders()).toHaveLength(0);
    });

    it('should return all added orders via getAllOrders', () => {
      const o1 = createLendLimitOrder();
      const o2 = createBorrowLimitOrder();
      book.addOrder(o1);
      book.addOrder(o2);

      const all = book.getAllOrders();
      expect(all).toHaveLength(2);

      const ids = all.map((o) => o.orderId);
      expect(ids).toContain(o1.orderId);
      expect(ids).toContain(o2.orderId);
    });
  });

  describe('Duplicate order IDs', () => {
    // M-1 audit fix: addOrder must REJECT duplicates, not overwrite them.
    // Previously the second insert orphaned the original tree node while
    // overwriting orderIndex, producing unauthorized fills on NATS replay.
    it('should reject a duplicate addOrder and preserve the original entry', () => {
      const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const order = createLendLimitOrder({ rate: 300 });
      const inserted = book.addOrder(order);
      expect(inserted).not.toBeNull();

      const duplicate = createLendLimitOrder({
        orderId: order.orderId,
        rate: 700,
        timestamp: order.timestamp,
      });
      const rejected = book.addOrder(duplicate);
      expect(rejected).toBeNull();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Duplicate order rejected: ${order.orderId}`)
      );

      // Original entry preserved; tree has exactly one node.
      const retrieved = book.getOrder(order.orderId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.rate).toBe(300);

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders.length).toBe(1);
      warnSpy.mockRestore();
    });
  });

  describe('updateOrderAmount', () => {
    it('should partially fill an order — reduces amount, status becomes PARTIALLY_FILLED', () => {
      const order = createLendLimitOrder({ remainingAmount: '1000000', originalAmount: '1000000' });
      book.addOrder(order);

      const updated = book.updateOrderAmount(order.orderId, '500000');

      expect(updated).toBe(true);

      const retrieved = book.getOrder(order.orderId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.remainingAmount).toBe('500000');
      expect(retrieved!.status).toBe(OrderStatus.PartiallyFilled);
      expect(book.orderCount).toBe(1);
    });

    it('should fully fill an order (zero amount) — removes from book', () => {
      const order = createLendLimitOrder();
      book.addOrder(order);

      const updated = book.updateOrderAmount(order.orderId, '0');

      expect(updated).toBe(true);
      expect(book.getOrder(order.orderId)).toBeNull();
      expect(book.orderCount).toBe(0);
    });

    it('should update remainingSettlementFeeAmount when provided', () => {
      const order = createLendLimitOrder();
      book.addOrder(order);

      book.updateOrderAmount(order.orderId, '500000', '5000');

      const retrieved = book.getOrder(order.orderId);
      expect(retrieved!.remainingSettlementFeeAmount).toBe('5000');
    });

    it('should return false for non-existent order ID', () => {
      const updated = book.updateOrderAmount('non-existent', '500000');
      expect(updated).toBe(false);
    });
  });

  describe('getBestOrders ordering', () => {
    it('should return empty array for empty book', () => {
      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders).toEqual([]);
    });

    it('should return empty array for unknown loanToken', () => {
      book.addOrder(createLendLimitOrder());

      const orders = book.getBestOrders(
        OrderSide.Lend,
        '0x0000000000000000000000000000000000000000',
        maturity
      );
      expect(orders).toEqual([]);
    });

    it('should return empty array for unknown maturity', () => {
      book.addOrder(createLendLimitOrder());

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, 9999999999);
      expect(orders).toEqual([]);
    });

    it('should sort lend orders by rate ascending (lowest first)', () => {
      const high = createLendLimitOrder({ rate: 800, timestamp: 1000 });
      const low = createLendLimitOrder({ rate: 200, timestamp: 1000 });
      const mid = createLendLimitOrder({ rate: 500, timestamp: 1000 });

      book.addOrder(high);
      book.addOrder(low);
      book.addOrder(mid);

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders.map((o) => o.rate)).toEqual([200, 500, 800]);
    });

    it('should sort borrow orders by rate descending (highest first)', () => {
      const low = createBorrowLimitOrder({ rate: 200, timestamp: 1000 });
      const high = createBorrowLimitOrder({ rate: 800, timestamp: 1000 });
      const mid = createBorrowLimitOrder({ rate: 500, timestamp: 1000 });

      book.addOrder(low);
      book.addOrder(high);
      book.addOrder(mid);

      const orders = book.getBestOrders(OrderSide.Borrow, loanToken, maturity);
      expect(orders.map((o) => o.rate)).toEqual([800, 500, 200]);
    });

    it('should use time priority (FIFO) for same rate — earlier timestamp first', () => {
      const early = createLendLimitOrder({ rate: 500, timestamp: 1000 });
      const late = createLendLimitOrder({ rate: 500, timestamp: 2000 });

      book.addOrder(late);
      book.addOrder(early);

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders[0].timestamp).toBe(1000);
      expect(orders[1].timestamp).toBe(2000);
    });

    it('should place market orders after limit orders', () => {
      const limit = createLendLimitOrder({ rate: 500, timestamp: 1000 });
      const market = createLendMarketOrder({ timestamp: 500 });

      book.addOrder(market);
      book.addOrder(limit);

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders[0].type).toBe('LIMIT');
      expect(orders[1].type).toBe('MARKET');
    });
  });

  describe('Multi-maturity isolation', () => {
    it('should isolate orders by maturity on the same loanToken', () => {
      const orderA = createLendLimitOrder({
        markets: marketsFromMaturities([maturity]),
      });
      const orderB = createLendLimitOrder({
        markets: marketsFromMaturities([SECOND_MATURITY]),
      });

      book.addOrder(orderA);
      book.addOrder(orderB);

      const ordersA = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      const ordersB = book.getBestOrders(OrderSide.Lend, loanToken, SECOND_MATURITY);

      expect(ordersA).toHaveLength(1);
      expect(ordersA[0].orderId).toBe(orderA.orderId);
      expect(ordersB).toHaveLength(1);
      expect(ordersB[0].orderId).toBe(orderB.orderId);
    });

    it('should isolate orders by loanToken', () => {
      const orderA = createLendLimitOrder({ loanToken });
      const orderB = createLendLimitOrder({ loanToken: SECOND_LOAN_TOKEN });

      book.addOrder(orderA);
      book.addOrder(orderB);

      const ordersA = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      const ordersB = book.getBestOrders(OrderSide.Lend, SECOND_LOAN_TOKEN, maturity);

      expect(ordersA).toHaveLength(1);
      expect(ordersA[0].orderId).toBe(orderA.orderId);
      expect(ordersB).toHaveLength(1);
      expect(ordersB[0].orderId).toBe(orderB.orderId);
    });

    it('should place a multi-maturity order in each maturity tree', () => {
      const order = createLendLimitOrder({
        markets: marketsFromMaturities([maturity, SECOND_MATURITY]),
      });

      book.addOrder(order);

      const ordersA = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      const ordersB = book.getBestOrders(OrderSide.Lend, loanToken, SECOND_MATURITY);

      expect(ordersA).toHaveLength(1);
      expect(ordersA[0].orderId).toBe(order.orderId);
      expect(ordersB).toHaveLength(1);
      expect(ordersB[0].orderId).toBe(order.orderId);
      // Only one entry in the index
      expect(book.orderCount).toBe(1);
    });
  });

  describe('getOrderBookSnapshot', () => {
    it('should return correct structure with lend and borrow sides', () => {
      const lend = createLendLimitOrder({ rate: 400 });
      const borrow = createBorrowLimitOrder({ rate: 600 });
      book.addOrder(lend);
      book.addOrder(borrow);

      const snapshot = book.getOrderBookSnapshot(loanToken, maturity);

      expect(snapshot.loanToken).toBe(loanToken);
      expect(snapshot.maturity).toBe(maturity);
      expect(snapshot.lendOrders).toHaveLength(1);
      expect(snapshot.lendOrders[0].orderId).toBe(lend.orderId);
      expect(snapshot.lendOrders[0].rate).toBe(400);
      expect(snapshot.borrowOrders).toHaveLength(1);
      expect(snapshot.borrowOrders[0].orderId).toBe(borrow.orderId);
      expect(snapshot.borrowOrders[0].rate).toBe(600);
    });

    it('should respect depth parameter', () => {
      for (let i = 0; i < 5; i++) {
        book.addOrder(createLendLimitOrder({ rate: 100 * (i + 1), timestamp: 1000 + i }));
      }

      const snapshot = book.getOrderBookSnapshot(loanToken, maturity, 3);

      expect(snapshot.lendOrders).toHaveLength(3);
    });

    it('should return empty arrays for empty book', () => {
      const snapshot = book.getOrderBookSnapshot(loanToken, maturity);

      expect(snapshot.lendOrders).toEqual([]);
      expect(snapshot.borrowOrders).toEqual([]);
    });
  });

  describe('restoreFromOrders', () => {
    it('should restore orders correctly', () => {
      const o1 = createLendLimitOrder({ rate: 300, timestamp: 1000 });
      const o2 = createLendLimitOrder({ rate: 500, timestamp: 2000 });
      book.addOrder(o1);
      book.addOrder(o2);

      const allOrders = book.getAllOrders();

      // Create a new book and restore
      const newBook = new OrderBook();
      newBook.restoreFromOrders(allOrders);

      expect(newBook.orderCount).toBe(2);
      expect(newBook.getOrder(o1.orderId)).not.toBeNull();
      expect(newBook.getOrder(o2.orderId)).not.toBeNull();

      const restored = newBook.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(restored.map((o) => o.rate)).toEqual([300, 500]);
    });

    it('should skip orders with zero remainingAmount', () => {
      const active = createLendLimitOrder({ remainingAmount: '500000' });
      const filled = createLendLimitOrder({ remainingAmount: '0', status: OrderStatus.Filled });

      book.restoreFromOrders([active, filled]);

      expect(book.orderCount).toBe(1);
      expect(book.getOrder(active.orderId)).not.toBeNull();
      expect(book.getOrder(filled.orderId)).toBeNull();
    });

    it('should clear existing orders before restoring', () => {
      book.addOrder(createLendLimitOrder());
      book.addOrder(createBorrowLimitOrder());
      expect(book.orderCount).toBe(2);

      const single = createLendLimitOrder();
      book.restoreFromOrders([single]);

      expect(book.orderCount).toBe(1);
      expect(book.getOrder(single.orderId)).not.toBeNull();
    });
  });

  describe('Interleaved add/remove/update', () => {
    it('should maintain correct order after removing the middle order', () => {
      const o1 = createLendLimitOrder({ rate: 200, timestamp: 1000 });
      const o2 = createLendLimitOrder({ rate: 400, timestamp: 2000 });
      const o3 = createLendLimitOrder({ rate: 600, timestamp: 3000 });

      book.addOrder(o1);
      book.addOrder(o2);
      book.addOrder(o3);

      book.removeOrder(o2.orderId);

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders).toHaveLength(2);
      expect(orders.map((o) => o.rate)).toEqual([200, 600]);
    });

    it('should preserve ordering after partial update and new addition', () => {
      const o1 = createLendLimitOrder({ rate: 300, timestamp: 1000 });
      book.addOrder(o1);

      book.updateOrderAmount(o1.orderId, '500000');

      const o2 = createLendLimitOrder({ rate: 200, timestamp: 2000 });
      book.addOrder(o2);

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders).toHaveLength(2);
      // rate 200 should come before rate 300
      expect(orders[0].rate).toBe(200);
      expect(orders[1].rate).toBe(300);
      expect(orders[1].remainingAmount).toBe('500000');
    });
  });

  describe.skip('Performance', () => {
    it('should handle 1000 orders and return them sorted', () => {
      const count = 1000;
      for (let i = 0; i < count; i++) {
        book.addOrder(
          createLendLimitOrder({
            rate: Math.floor(Math.random() * 10000),
            timestamp: 1000 + i,
          })
        );
      }

      expect(book.orderCount).toBe(count);

      const orders = book.getBestOrders(OrderSide.Lend, loanToken, maturity);
      expect(orders).toHaveLength(count);

      // Verify sorted by rate ascending
      for (let i = 1; i < orders.length; i++) {
        const prevRate = 'rate' in orders[i - 1] ? orders[i - 1].rate! : Infinity;
        const currRate = 'rate' in orders[i] ? orders[i].rate! : Infinity;
        expect(currRate).toBeGreaterThanOrEqual(prevRate);
      }
    });
  });
});
