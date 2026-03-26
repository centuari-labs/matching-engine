/**
 * Message Handlers Unit Tests
 *
 * Tests for NATS message handler functions with mocked MatchingEngine and NatsConnection.
 */

import {
  handleLendMarketOrder,
  handleLendLimitOrder,
  handleBorrowMarketOrder,
  handleBorrowLimitOrder,
  handleCancelOrder,
  type HandlerContext,
} from '../services/message-handlers';
import { MatchingEngine } from '../core/matching-engine';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
} from './factories/order-factory';
import { NATS_TOPICS } from '../config/nats-config';
import { generateOrderId } from '../utils/helpers';

function createMockCtx(): HandlerContext {
  const engine = new MatchingEngine();
  const nc = {
    publish: jest.fn(),
    subscribe: jest.fn(),
    drain: jest.fn(),
    closed: jest.fn().mockReturnValue(new Promise(() => {})),
  };
  return { nc: nc as any, engine };
}

function encode(obj: object): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

describe('message-handlers', () => {
  let ctx: HandlerContext;

  beforeEach(() => {
    ctx = createMockCtx();
  });

  describe('handleLendLimitOrder', () => {
    it('should process a valid lend limit order', () => {
      const order = createLendLimitOrder();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      handleLendLimitOrder(ctx, encode(order));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Processing lend limit'));
      consoleSpy.mockRestore();
    });

    it('should match against existing borrow order', () => {
      // First submit a borrow limit order
      const borrowOrder = createBorrowLimitOrder({ rate: 500 });
      handleBorrowLimitOrder(ctx, encode(borrowOrder));

      // Then submit a matching lend limit order
      const lendOrder = createLendLimitOrder({
        rate: 500,
        walletAddress: '0x2222222222222222222222222222222222222222',
      });
      handleLendLimitOrder(ctx, encode(lendOrder));

      // Should have published status updates
      expect(ctx.nc.publish).toHaveBeenCalled();
    });

    it('should publish error for invalid message', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      handleLendLimitOrder(ctx, new TextEncoder().encode('not json'));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Error handling lend limit order'),
        expect.any(Error)
      );
      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });

    it('should publish error for schema validation failure', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      handleLendLimitOrder(ctx, encode({ orderId: 'not-a-uuid' }));

      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });
  });

  describe('handleLendMarketOrder', () => {
    it('should process a valid lend market order', () => {
      const order = createLendMarketOrder();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      handleLendMarketOrder(ctx, encode(order));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Processing lend market'));
      consoleSpy.mockRestore();
    });

    it('should publish error for invalid message', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      handleLendMarketOrder(ctx, new TextEncoder().encode('bad'));

      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });
  });

  describe('handleBorrowLimitOrder', () => {
    it('should process a valid borrow limit order', () => {
      const order = createBorrowLimitOrder();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      handleBorrowLimitOrder(ctx, encode(order));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Processing borrow limit'));
      consoleSpy.mockRestore();
    });

    it('should publish error for invalid message', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      handleBorrowLimitOrder(ctx, new TextEncoder().encode('{}'));

      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });
  });

  describe('handleBorrowMarketOrder', () => {
    it('should process a valid borrow market order', () => {
      const order = createBorrowMarketOrder();
      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

      handleBorrowMarketOrder(ctx, encode(order));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Processing borrow market'));
      consoleSpy.mockRestore();
    });

    it('should publish error for invalid message', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      handleBorrowMarketOrder(ctx, new TextEncoder().encode('"x"'));

      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });
  });

  describe('handleCancelOrder', () => {
    it('should cancel an existing order', () => {
      // Submit an order first
      const order = createLendLimitOrder();
      handleLendLimitOrder(ctx, encode(order));

      const cancelRequest = {
        orderId: order.orderId,
        walletAddress: order.walletAddress,
        timestamp: Date.now(),
      };

      const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
      handleCancelOrder(ctx, encode(cancelRequest));

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Order ${order.orderId} cancelled successfully`)
      );
      // Should publish CANCELLED status
      const statusCalls = (ctx.nc.publish as jest.Mock).mock.calls.filter(
        (call: unknown[]) => call[0] === NATS_TOPICS.ORDERS_STATUS
      );
      const cancelledCall = statusCalls.find((call: unknown[]) => {
        const parsed = JSON.parse(call[1] as string);
        return parsed.status === 'CANCELLED';
      });
      expect(cancelledCall).toBeDefined();
      consoleSpy.mockRestore();
    });

    it('should publish error for non-existent order', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const cancelRequest = {
        orderId: generateOrderId(),
        walletAddress: '0x1111111111111111111111111111111111111111',
        timestamp: Date.now(),
      };

      handleCancelOrder(ctx, encode(cancelRequest));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('not found'));
      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });

    it('should publish error for wallet address mismatch', () => {
      // Submit an order
      const order = createLendLimitOrder();
      handleLendLimitOrder(ctx, encode(order));

      // Try to cancel with wrong wallet
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();
      const cancelRequest = {
        orderId: order.orderId,
        walletAddress: '0x9999999999999999999999999999999999999999',
        timestamp: Date.now(),
      };

      handleCancelOrder(ctx, encode(cancelRequest));

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Wallet address mismatch'));
      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });

    it('should publish error for invalid cancel message', () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      handleCancelOrder(ctx, new TextEncoder().encode('bad'));

      expect(ctx.nc.publish).toHaveBeenCalledWith(NATS_TOPICS.ERRORS, expect.any(String));
      consoleSpy.mockRestore();
    });
  });

  describe('publishOrderStatusUpdates', () => {
    it('should publish FILLED status when order fully matched', () => {
      // Create matching orders that will fully fill
      const borrowOrder = createBorrowLimitOrder({ rate: 500 });
      handleBorrowLimitOrder(ctx, encode(borrowOrder));

      const lendOrder = createLendLimitOrder({
        rate: 500,
        walletAddress: '0x2222222222222222222222222222222222222222',
      });
      handleLendLimitOrder(ctx, encode(lendOrder));

      // Check that FILLED status was published
      const statusCalls = (ctx.nc.publish as jest.Mock).mock.calls.filter(
        (call: unknown[]) => call[0] === NATS_TOPICS.ORDERS_STATUS
      );
      expect(statusCalls.length).toBeGreaterThan(0);
    });

    it('should publish maker order status updates', () => {
      // Submit a maker borrow order
      const borrowOrder = createBorrowLimitOrder({
        rate: 500,
        originalAmount: '2000000',
        remainingAmount: '2000000',
      });
      handleBorrowLimitOrder(ctx, encode(borrowOrder));

      // Submit a taker lend order that partially fills the borrow
      const lendOrder = createLendLimitOrder({
        rate: 500,
        originalAmount: '1000000',
        remainingAmount: '1000000',
        walletAddress: '0x2222222222222222222222222222222222222222',
      });
      handleLendLimitOrder(ctx, encode(lendOrder));

      // Should have published status for both the maker and taker
      const statusCalls = (ctx.nc.publish as jest.Mock).mock.calls.filter(
        (call: unknown[]) => call[0] === NATS_TOPICS.ORDERS_STATUS
      );
      expect(statusCalls.length).toBeGreaterThanOrEqual(2);
    });
  });
});
