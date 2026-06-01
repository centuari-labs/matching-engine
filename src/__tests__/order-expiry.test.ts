import { MatchingEngine } from '../core/matching-engine';
import { OrderBook } from '../core/order-book';
import { expireMaturedOrders, MARKET_MATURED_CANCEL_REASON } from '../services/order-expiry';
import { handleLendLimitOrder, type HandlerContext } from '../services/message-handlers';
import { OrderStatus } from '../types/orders';
import { NATS_TOPICS } from '../config/nats-config';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  marketsFromMaturities,
} from './factories/order-factory';

const PAST = 1_000_000_000; // 2001 — comfortably matured
const FUTURE = 4_102_444_800; // 2100 — comfortably live

function createMockNatsConnection() {
  const published: { topic: string; data: string }[] = [];
  return {
    publish: jest.fn((topic: string, data: string) => {
      published.push({ topic, data });
    }),
    getMessagesForTopic: (topic: string) => published.filter((m) => m.topic === topic),
  };
}

function createOrderBytes(order: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(order));
}

describe('Maturity-based order expiry', () => {
  const loanToken = '0x1234567890123456789012345678901234567890';
  const nowSeconds = Math.floor(Date.now() / 1000);

  describe('OrderBook.removeMaturedOrders', () => {
    it('removes resting orders past maturity and returns them, keeping live ones', () => {
      const book = new OrderBook();
      const matured = createLendLimitOrder({
        loanToken,
        markets: marketsFromMaturities([PAST]),
        rate: 500,
      });
      const live = createLendLimitOrder({
        loanToken,
        markets: marketsFromMaturities([FUTURE]),
        rate: 500,
      });
      book.addOrder(matured);
      book.addOrder(live);

      const removed = book.removeMaturedOrders(nowSeconds);

      expect(removed.map((o) => o.orderId)).toEqual([matured.orderId]);
      expect(book.getOrder(matured.orderId)).toBeNull();
      expect(book.getOrder(live.orderId)).not.toBeNull();
    });

    it('keeps a multi-market order while at least one leg is still live', () => {
      const book = new OrderBook();
      const order = createLendLimitOrder({
        loanToken,
        markets: marketsFromMaturities([PAST, FUTURE]),
        rate: 500,
      });
      book.addOrder(order);

      expect(book.removeMaturedOrders(nowSeconds)).toEqual([]);
      expect(book.getOrder(order.orderId)).not.toBeNull();
    });

    it('returns an empty array when nothing is matured', () => {
      const book = new OrderBook();
      book.addOrder(
        createLendLimitOrder({ loanToken, markets: marketsFromMaturities([FUTURE]), rate: 500 })
      );
      expect(book.removeMaturedOrders(nowSeconds)).toEqual([]);
    });
  });

  describe('MatchingEngine.expireMaturedOrders', () => {
    it('removes matured resting orders from the book and returns them', () => {
      const engine = new MatchingEngine();
      const matured = createBorrowLimitOrder({
        loanToken,
        markets: marketsFromMaturities([PAST]),
        rate: 500,
      });
      engine.submitOrder(matured);

      const expired = engine.expireMaturedOrders(nowSeconds);

      expect(expired.map((o) => o.orderId)).toEqual([matured.orderId]);
      expect(engine.hasOrder(matured.orderId)).toBe(false);
    });
  });

  describe('expireMaturedOrders sweep (service)', () => {
    it('publishes a CANCELLED/MARKET_MATURED status for each expired order', () => {
      const engine = new MatchingEngine();
      const mockNc = createMockNatsConnection();
      const matured = createLendLimitOrder({
        loanToken,
        markets: marketsFromMaturities([PAST]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(matured);

      const count = expireMaturedOrders(
        engine,
        mockNc as unknown as Parameters<typeof expireMaturedOrders>[1],
        nowSeconds
      );

      expect(count).toBe(1);
      const statuses = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
      expect(statuses.length).toBe(1);
      const msg = JSON.parse(statuses[0].data);
      expect(msg.orderId).toBe(matured.orderId);
      expect(msg.status).toBe(OrderStatus.Cancelled);
      expect(msg.cancelReason).toBe(MARKET_MATURED_CANCEL_REASON);
      expect(msg.remainingAmount).toBe('1000000');
      expect(msg.filledQuantity).toBe('0');
    });

    it('is idempotent — a second sweep publishes nothing', () => {
      const engine = new MatchingEngine();
      const mockNc = createMockNatsConnection();
      engine.submitOrder(
        createLendLimitOrder({ loanToken, markets: marketsFromMaturities([PAST]), rate: 500 })
      );

      const nc = mockNc as unknown as Parameters<typeof expireMaturedOrders>[1];
      expect(expireMaturedOrders(engine, nc, nowSeconds)).toBe(1);
      expect(expireMaturedOrders(engine, nc, nowSeconds)).toBe(0);
      expect(mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS).length).toBe(1);
    });

    it('expires the unfilled remainder of a partially-filled order', () => {
      const engine = new MatchingEngine();
      const mockNc = createMockNatsConnection();
      // Resting lend 1,000,000 in a matured market, partially filled 400,000.
      const lend = createLendLimitOrder({
        walletAddress: '0x1111111111111111111111111111111111111111',
        loanToken,
        markets: marketsFromMaturities([PAST]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(lend);
      const borrow = createBorrowLimitOrder({
        walletAddress: '0x2222222222222222222222222222222222222222',
        loanToken,
        markets: marketsFromMaturities([PAST]),
        originalAmount: '400000',
        remainingAmount: '400000',
        settlementFeeAmount: '4000',
        rate: 500,
      });
      engine.submitOrder(borrow);

      const count = expireMaturedOrders(
        engine,
        mockNc as unknown as Parameters<typeof expireMaturedOrders>[1],
        nowSeconds
      );

      expect(count).toBeGreaterThanOrEqual(1);
      const lendStatus = mockNc
        .getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS)
        .map((m) => JSON.parse(m.data))
        .find((m) => m.orderId === lend.orderId);
      expect(lendStatus).toBeDefined();
      expect(lendStatus.status).toBe(OrderStatus.Cancelled);
      expect(lendStatus.cancelReason).toBe(MARKET_MATURED_CANCEL_REASON);
      expect(lendStatus.remainingAmount).toBe('600000');
      expect(lendStatus.filledQuantity).toBe('400000');
    });
  });

  describe('placement backstop (handleOrder)', () => {
    it('rejects an order placed into a matured market', () => {
      const engine = new MatchingEngine();
      const mockNc = createMockNatsConnection();
      const ctx: HandlerContext = {
        nc: mockNc as unknown as HandlerContext['nc'],
        engine,
      };
      const order = createLendLimitOrder({
        loanToken,
        markets: marketsFromMaturities([PAST]),
        rate: 500,
      });

      handleLendLimitOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(order))));

      // Order never entered the book; an error was published; no status emitted.
      expect(engine.hasOrder(order.orderId)).toBe(false);
      const errors = mockNc.getMessagesForTopic(NATS_TOPICS.ERRORS);
      expect(errors.length).toBeGreaterThanOrEqual(1);
      expect(errors[0].data).toMatch(/matured market/);
      expect(mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS).length).toBe(0);
    });
  });
});
