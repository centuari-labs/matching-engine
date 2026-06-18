import { MatchingEngine } from '../core/matching-engine';
import {
  handleUpdateOrder,
  handleLendLimitOrder,
  handleBorrowLimitOrder,
  type HandlerContext,
} from '../services/message-handlers';
import { NATS_TOPICS } from '../config/nats-config';
import type { OrderUpdatedMessage } from '../types/messages';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  marketsFromMaturities,
} from './factories/order-factory';
import { generateOrderId } from '../utils/helpers';

/**
 * Create a mock NATS connection that captures published messages.
 */
function createMockNatsConnection() {
  const publishedMessages: { topic: string; data: string }[] = [];

  return {
    publish: jest.fn((topic: string, data: string) => {
      publishedMessages.push({ topic, data });
    }),
    getPublishedMessages: () => publishedMessages,
    getMessagesForTopic: (topic: string) => publishedMessages.filter((m) => m.topic === topic),
  };
}

function toBytes(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe('handleUpdateOrder', () => {
  let engine: MatchingEngine;
  let mockNc: ReturnType<typeof createMockNatsConnection>;
  let ctx: HandlerContext;

  const loanToken = '0x1234567890123456789012345678901234567890';
  const walletAddress1 = '0x1111111111111111111111111111111111111111';
  const walletAddress2 = '0x2222222222222222222222222222222222222222';
  // Far-future maturity so the handleOrder matured-market backstop accepts these
  // placements (a past maturity is rejected as a matured market).
  const maturity = 4102444800; // 2100-01-01

  beforeEach(() => {
    engine = new MatchingEngine();
    mockNc = createMockNatsConnection();
    ctx = {
      nc: mockNc as unknown as HandlerContext['nc'],
      engine,
    };
  });

  describe('happy path — quantity update', () => {
    it('should publish orders.updated with recalculated amounts when quantity increases', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress1,
          originalAmount: '2000000',
          timestamp: Date.now(),
        })
      );

      const updatedMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_UPDATED);
      expect(updatedMsgs.length).toBe(1);

      const event: OrderUpdatedMessage = JSON.parse(updatedMsgs[0].data);
      expect(event.orderId).toBe(order.orderId);
      expect(event.originalAmount).toBe('2000000');
      expect(event.remainingAmount).toBe('2000000');
      // Settlement fee recalculated pro-rata: 10000 * 2000000 / 1000000 = 20000 (with ceiling)
      expect(BigInt(event.settlementFeeAmount)).toBeGreaterThan(0n);
    });

    it('should put the updated order back in the book', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress1,
          originalAmount: '2000000',
          timestamp: Date.now(),
        })
      );

      // Order should be back in the book with same ID
      expect(engine.hasOrder(order.orderId)).toBe(true);
    });

    it('should publish orders.status for re-submitted order', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress1,
          originalAmount: '2000000',
          timestamp: Date.now(),
        })
      );

      const statusMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
      expect(statusMsgs.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('happy path — rate update only', () => {
    it('should update the rate without changing amounts', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress1,
          rate: 750,
          timestamp: Date.now(),
        })
      );

      const updatedMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_UPDATED);
      expect(updatedMsgs.length).toBe(1);

      const event: OrderUpdatedMessage = JSON.parse(updatedMsgs[0].data);
      expect(event.rate).toBe(750);
      expect(event.originalAmount).toBe('1000000');
      expect(event.remainingAmount).toBe('1000000');
    });
  });

  describe('happy path — quantity + explicit settlement fee', () => {
    it('should use explicit settlement fee instead of pro-rata recalculation', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress1,
          originalAmount: '2000000',
          settlementFeeAmount: '50000',
          timestamp: Date.now(),
        })
      );

      const updatedMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_UPDATED);
      expect(updatedMsgs.length).toBe(1);

      const event: OrderUpdatedMessage = JSON.parse(updatedMsgs[0].data);
      expect(event.settlementFeeAmount).toBe('50000');
    });
  });

  describe('happy path — partial fill then update', () => {
    it('should recalculate remaining based on filled amount', () => {
      // Place lend order with 2M, partially fill with 1M borrow
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '2000000',
        remainingAmount: '2000000',
        settlementFeeAmount: '20000',
        rate: 500,
      });
      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      // Use handlers to properly set up status
      handleLendLimitOrder(ctx, toBytes(lendOrder));
      handleBorrowLimitOrder(ctx, toBytes(borrowOrder));

      // Clear published messages before update
      mockNc.getPublishedMessages().length = 0;

      // Update lend order to 3M total (1M filled, so 2M remaining)
      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: lendOrder.orderId,
          walletAddress: walletAddress1,
          originalAmount: '3000000',
          timestamp: Date.now(),
        })
      );

      const updatedMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_UPDATED);
      expect(updatedMsgs.length).toBe(1);

      const event: OrderUpdatedMessage = JSON.parse(updatedMsgs[0].data);
      expect(event.originalAmount).toBe('3000000');
      expect(event.remainingAmount).toBe('2000000');
    });
  });

  describe('happy path — update triggers new match', () => {
    it('should produce matches when updated rate becomes matchable', () => {
      // Lend order at rate 800 — does not match borrow at rate 500
      // (lender wants minimum 800, but borrower only offers 500)
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 800,
      });
      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      handleLendLimitOrder(ctx, toBytes(lendOrder));
      handleBorrowLimitOrder(ctx, toBytes(borrowOrder));

      // Both should still be in the book — no match because lend rate (800) > borrow rate (500)
      expect(engine.hasOrder(lendOrder.orderId)).toBe(true);
      expect(engine.hasOrder(borrowOrder.orderId)).toBe(true);

      // Clear messages
      mockNc.getPublishedMessages().length = 0;

      // Update lend order rate to 400 — lender now accepts lower rate, should match borrow at 500
      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: lendOrder.orderId,
          walletAddress: walletAddress1,
          rate: 400,
          timestamp: Date.now(),
        })
      );

      const matchMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.MATCHES_CREATED);
      expect(matchMsgs.length).toBeGreaterThan(0);
    });
  });

  describe('error — quantity less than filled amount', () => {
    it('should publish error when new quantity is below filled amount', () => {
      const lendOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '2000000',
        remainingAmount: '2000000',
        settlementFeeAmount: '20000',
        rate: 500,
      });
      const borrowOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      handleLendLimitOrder(ctx, toBytes(lendOrder));
      handleBorrowLimitOrder(ctx, toBytes(borrowOrder));
      mockNc.getPublishedMessages().length = 0;

      // Try to reduce total quantity below the 1M already filled
      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: lendOrder.orderId,
          walletAddress: walletAddress1,
          originalAmount: '500000',
          timestamp: Date.now(),
        })
      );

      const errorMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ERRORS);
      expect(errorMsgs.length).toBe(1);
      const error = JSON.parse(errorMsgs[0].data);
      expect(error.error).toBe(true);
    });
  });

  describe('error — invalid message', () => {
    it('should publish error for garbage bytes', () => {
      handleUpdateOrder(ctx, new Uint8Array([0xff, 0xfe]));

      const errorMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ERRORS);
      expect(errorMsgs.length).toBe(1);
    });

    it('should publish error for empty update (no fields)', () => {
      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: generateOrderId(),
          walletAddress: walletAddress1,
          // No update fields — refine should reject
        })
      );

      const errorMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ERRORS);
      expect(errorMsgs.length).toBe(1);
    });
  });

  describe('error — NOT_FOUND', () => {
    it('should publish ORDER_NOT_FOUND error for nonexistent order', () => {
      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: generateOrderId(),
          walletAddress: walletAddress1,
          rate: 500,
          timestamp: Date.now(),
        })
      );

      const errorMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ERRORS);
      expect(errorMsgs.length).toBe(1);
      const error = JSON.parse(errorMsgs[0].data);
      expect(error.code).toBe('ORDER_NOT_FOUND');
    });
  });

  describe('error — WALLET_MISMATCH', () => {
    it('should publish VALIDATION_ERROR for wrong wallet', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress2,
          rate: 750,
          timestamp: Date.now(),
        })
      );

      const errorMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ERRORS);
      expect(errorMsgs.length).toBe(1);
      const error = JSON.parse(errorMsgs[0].data);
      expect(error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('amount field fallback', () => {
    it('should use quantity field when originalAmount is not provided', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress1,
          quantity: '2000000',
          timestamp: Date.now(),
        })
      );

      const updatedMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_UPDATED);
      expect(updatedMsgs.length).toBe(1);

      const event: OrderUpdatedMessage = JSON.parse(updatedMsgs[0].data);
      expect(event.originalAmount).toBe('2000000');
    });

    it('should use amount field as last fallback', () => {
      const order = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        rate: 500,
      });
      engine.submitOrder(order);

      handleUpdateOrder(
        ctx,
        toBytes({
          orderId: order.orderId,
          walletAddress: walletAddress1,
          amount: '3000000',
          timestamp: Date.now(),
        })
      );

      const updatedMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_UPDATED);
      expect(updatedMsgs.length).toBe(1);

      const event: OrderUpdatedMessage = JSON.parse(updatedMsgs[0].data);
      expect(event.originalAmount).toBe('3000000');
    });
  });
});
