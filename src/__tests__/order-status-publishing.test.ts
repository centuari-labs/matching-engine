import { MatchingEngine } from '../core/matching-engine';
import {
  handleLendLimitOrder,
  handleBorrowLimitOrder,
  handleLendMarketOrder,
  handleBorrowMarketOrder,
  type HandlerContext,
} from '../services/message-handlers';
import type { LendLimitOrder, BorrowLimitOrder } from '../types/orders';
import { LendMarketOrder, BorrowMarketOrder, OrderStatus } from '../types/orders';
import type { CancelledRemainderMessage } from '../types/messages';
import { NATS_TOPICS } from '../config/nats-config';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
  marketsFromMaturities,
} from './factories/order-factory';

/**
 * Create a mock NATS connection for testing
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

/**
 * Create a valid order as Uint8Array for handler testing
 */
function createOrderBytes(order: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(order));
}

describe('Order Status Publishing', () => {
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

  describe('Taker order status publishing', () => {
    it('should publish FILLED status for taker when fully matched', () => {
      // First submit a borrow order to the book
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });
      engine.submitOrder(borrowOrder);

      // Now submit a lend order that will fully match
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      handleLendLimitOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(lendOrder))));

      // Check that order status was published
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
      expect(statusMessages.length).toBeGreaterThanOrEqual(1);

      // Find the taker order status message
      const takerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendOrder.orderId;
      });

      expect(takerStatus).toBeDefined();
      const parsedTakerStatus = JSON.parse(takerStatus!.data);
      expect(parsedTakerStatus.status).toBe(OrderStatus.Filled);
      expect(parsedTakerStatus.remainingAmount).toBe('0');
      expect(parsedTakerStatus.filledQuantity).toBe('1000000');
      expect(parsedTakerStatus.filledSettlementFeeAmount).toBe('10000');
    });

    it('should publish PARTIALLY_FILLED status for taker when partially matched', () => {
      // First submit a smaller borrow order to the book
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 600,
      });
      engine.submitOrder(borrowOrder);

      // Now submit a larger lend order that will partially match
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      handleLendLimitOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(lendOrder))));

      // Check that order status was published
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);

      // Find the taker order status message
      const takerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendOrder.orderId;
      });

      expect(takerStatus).toBeDefined();
      const parsedTakerStatus = JSON.parse(takerStatus!.data);
      expect(parsedTakerStatus.status).toBe(OrderStatus.PartiallyFilled);
      expect(parsedTakerStatus.remainingAmount).toBe('700000');
      expect(parsedTakerStatus.filledQuantity).toBe('300000');
      expect(parsedTakerStatus.filledSettlementFeeAmount).toBeDefined();
    });

    it('should publish OPEN status for limit order when added to book without matches', () => {
      // Submit a lend order with no counterparty
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      handleLendLimitOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(lendOrder))));

      // Check that order status was published with OPEN status
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
      expect(statusMessages).toHaveLength(1);

      const parsedStatus = JSON.parse(statusMessages[0].data);
      expect(parsedStatus.orderId).toBe(lendOrder.orderId);
      expect(parsedStatus.status).toBe(OrderStatus.Open);
      expect(parsedStatus.remainingAmount).toBe('1000000');
      expect(parsedStatus.filledQuantity).toBe('0');
      expect(parsedStatus.filledSettlementFeeAmount).toBe('0');
    });
  });

  describe('Maker order status publishing', () => {
    it('should publish FILLED status for maker when fully matched', () => {
      // First submit a lend order to the book
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(lendOrder);

      // Now submit a borrow order that will fully match the lend order
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      handleBorrowLimitOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(borrowOrder))));

      // Check that maker order status was published
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);

      // Find the maker order status message
      const makerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendOrder.orderId;
      });

      expect(makerStatus).toBeDefined();
      const parsedMakerStatus = JSON.parse(makerStatus!.data);
      expect(parsedMakerStatus.status).toBe(OrderStatus.Filled);
      expect(parsedMakerStatus.remainingAmount).toBe('0');
    });

    it('should publish PARTIALLY_FILLED status for maker when partially matched', () => {
      // First submit a large lend order to the book
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(lendOrder);

      // Now submit a smaller borrow order
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '400000',
        remainingAmount: '400000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      handleBorrowLimitOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(borrowOrder))));

      // Check that maker order status was published
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);

      // Find the maker order status message
      const makerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendOrder.orderId;
      });

      expect(makerStatus).toBeDefined();
      const parsedMakerStatus = JSON.parse(makerStatus!.data);
      expect(parsedMakerStatus.status).toBe(OrderStatus.PartiallyFilled);
      expect(parsedMakerStatus.remainingAmount).toBe('600000');
    });

    it('should publish status for all affected maker orders', () => {
      // Submit multiple lend orders to the book
      const lendOrder1: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '300000',
        remainingAmount: '300000',
        settlementFeeAmount: '10000',
        rate: 400,
      });

      const lendOrder2: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '400000',
        remainingAmount: '400000',
        settlementFeeAmount: '10000',
        rate: 500,
      });

      engine.submitOrder(lendOrder1);
      engine.submitOrder(lendOrder2);

      // Submit a large borrow order that matches both
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 2,
        originalAmount: '700000',
        remainingAmount: '700000',
        settlementFeeAmount: '10000',
        rate: 600,
      });

      handleBorrowLimitOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(borrowOrder))));

      // Check that all maker order statuses were published
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);

      // Find both maker order status messages
      const maker1Status = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendOrder1.orderId;
      });

      const maker2Status = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendOrder2.orderId;
      });

      expect(maker1Status).toBeDefined();
      expect(maker2Status).toBeDefined();

      const parsedMaker1Status = JSON.parse(maker1Status!.data);
      const parsedMaker2Status = JSON.parse(maker2Status!.data);

      expect(parsedMaker1Status.status).toBe(OrderStatus.Filled);
      expect(parsedMaker2Status.status).toBe(OrderStatus.Filled);
    });
  });

  describe('Market order status publishing', () => {
    it('should publish FILLED status for market order when fully matched', () => {
      // First submit a borrow order to the book
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });
      engine.submitOrder(borrowOrder);

      // Now submit a lend market order
      const lendMarketOrder: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      handleLendMarketOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(lendMarketOrder))));

      // Check that taker (market order) status was published
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);

      const takerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendMarketOrder.orderId;
      });

      expect(takerStatus).toBeDefined();
      const parsedTakerStatus = JSON.parse(takerStatus!.data);
      expect(parsedTakerStatus.status).toBe(OrderStatus.Filled);
    });

    it('should publish status for makers matched by borrow market order', () => {
      // First submit a lend order to the book
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
        rate: 500,
      });
      engine.submitOrder(lendOrder);

      // Now submit a borrow market order
      const borrowMarketOrder: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '500000',
        remainingAmount: '500000',
        settlementFeeAmount: '10000',
      });

      handleBorrowMarketOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(borrowMarketOrder))));

      // Check that maker order status was published
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);

      const makerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendOrder.orderId;
      });

      expect(makerStatus).toBeDefined();
      const parsedMakerStatus = JSON.parse(makerStatus!.data);
      expect(parsedMakerStatus.status).toBe(OrderStatus.Filled);
    });

    it('should publish FILLED with correct filledQuantity for partially matched lend market order', () => {
      // Place a small borrow order on the book
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '100000',
        remainingAmount: '100000',
        settlementFeeAmount: '1000',
        rate: 600,
      });
      engine.submitOrder(borrowOrder);

      // Submit a larger lend market order — only 100k of 1M will match
      const lendMarketOrder: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      handleLendMarketOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(lendMarketOrder))));

      // Check taker status
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
      const takerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendMarketOrder.orderId;
      });

      expect(takerStatus).toBeDefined();
      const parsedTakerStatus = JSON.parse(takerStatus!.data);
      expect(parsedTakerStatus.status).toBe(OrderStatus.Filled);
      expect(parsedTakerStatus.filledQuantity).toBe('100000');
      expect(parsedTakerStatus.remainingAmount).toBe('900000');
    });

    it('should publish cancelled remainder order for partially matched lend market order', () => {
      // Place a small borrow order on the book
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '100000',
        remainingAmount: '100000',
        settlementFeeAmount: '1000',
        rate: 600,
      });
      engine.submitOrder(borrowOrder);

      // Submit a larger lend market order — only 100k of 1M will match
      const lendMarketOrder: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      handleLendMarketOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(lendMarketOrder))));

      // Check cancelled remainder message was published
      const cancelledMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_CANCELLED_REMAINDER);
      expect(cancelledMessages).toHaveLength(1);

      const cancelled: CancelledRemainderMessage = JSON.parse(cancelledMessages[0].data);
      expect(cancelled.originalOrderId).toBe(lendMarketOrder.orderId);
      expect(cancelled.quantity).toBe('900000');
      expect(cancelled.accountWallet).toBe(walletAddress1);
      expect(cancelled.side).toBe('LEND');
      expect(cancelled.type).toBe('MARKET');
    });

    it('should NOT publish cancelled remainder for fully matched market order', () => {
      // Place a borrow order of equal size
      const borrowOrder: BorrowLimitOrder = createBorrowLimitOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
        rate: 600,
      });
      engine.submitOrder(borrowOrder);

      // Submit a lend market order of equal size — will be fully matched
      const lendMarketOrder: LendMarketOrder = createLendMarketOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      handleLendMarketOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(lendMarketOrder))));

      // No cancelled remainder should be published
      const cancelledMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_CANCELLED_REMAINDER);
      expect(cancelledMessages).toHaveLength(0);

      // Status should be FILLED with full amount
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
      const takerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === lendMarketOrder.orderId;
      });
      expect(takerStatus).toBeDefined();
      const parsedTakerStatus = JSON.parse(takerStatus!.data);
      expect(parsedTakerStatus.status).toBe(OrderStatus.Filled);
      expect(parsedTakerStatus.filledQuantity).toBe('1000000');
      expect(parsedTakerStatus.remainingAmount).toBe('0');
    });

    it('should publish correct filledQuantity for partially matched borrow market order', () => {
      // Place a small lend order on the book
      const lendOrder: LendLimitOrder = createLendLimitOrder({
        walletAddress: walletAddress1,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now(),
        originalAmount: '200000',
        remainingAmount: '200000',
        settlementFeeAmount: '2000',
        rate: 500,
      });
      engine.submitOrder(lendOrder);

      // Submit a larger borrow market order — only 200k of 1M will match
      const borrowMarketOrder: BorrowMarketOrder = createBorrowMarketOrder({
        walletAddress: walletAddress2,
        loanToken,
        markets: marketsFromMaturities([maturity]),
        timestamp: Date.now() + 1,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        settlementFeeAmount: '10000',
      });

      handleBorrowMarketOrder(ctx, createOrderBytes(JSON.parse(JSON.stringify(borrowMarketOrder))));

      // Check taker status
      const statusMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
      const takerStatus = statusMessages.find((m) => {
        const parsed = JSON.parse(m.data);
        return parsed.orderId === borrowMarketOrder.orderId;
      });

      expect(takerStatus).toBeDefined();
      const parsedTakerStatus = JSON.parse(takerStatus!.data);
      expect(parsedTakerStatus.status).toBe(OrderStatus.Filled);
      expect(parsedTakerStatus.filledQuantity).toBe('200000');
      expect(parsedTakerStatus.remainingAmount).toBe('800000');

      // Check cancelled remainder
      const cancelledMessages = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_CANCELLED_REMAINDER);
      expect(cancelledMessages).toHaveLength(1);

      const cancelled: CancelledRemainderMessage = JSON.parse(cancelledMessages[0].data);
      expect(cancelled.originalOrderId).toBe(borrowMarketOrder.orderId);
      expect(cancelled.quantity).toBe('800000');
      expect(cancelled.side).toBe('BORROW');
    });
  });
});
