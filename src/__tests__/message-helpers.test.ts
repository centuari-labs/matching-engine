import {
  createOrderStatusMessageFromAffected,
  createMatchCreatedMessage,
  createErrorMessage,
  ERROR_CODES,
} from '../types/messages';
import type { AffectedOrder, MatchResult } from '../types/matches';
import { OrderStatus } from '../types/orders';

describe('Message Helpers', () => {
  describe('createOrderStatusMessageFromAffected', () => {
    it('should create correct message structure from AffectedOrder', () => {
      const affected: AffectedOrder = {
        orderId: '123e4567-e89b-12d3-a456-426614174000',
        status: OrderStatus.Filled,
        remainingAmount: '0',
      };

      const message = createOrderStatusMessageFromAffected(affected);

      expect(message.orderId).toBe(affected.orderId);
      expect(message.status).toBe(OrderStatus.Filled);
      expect(message.remainingAmount).toBe('0');
      expect(typeof message.timestamp).toBe('number');
      expect(message.timestamp).toBeGreaterThan(0);
    });

    it('should include current timestamp', () => {
      const beforeTime = Date.now();

      const affected: AffectedOrder = {
        orderId: '123e4567-e89b-12d3-a456-426614174000',
        status: OrderStatus.PartiallyFilled,
        remainingAmount: '500000',
      };

      const message = createOrderStatusMessageFromAffected(affected);
      const afterTime = Date.now();

      expect(message.timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(message.timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should handle FILLED status', () => {
      const affected: AffectedOrder = {
        orderId: '123e4567-e89b-12d3-a456-426614174000',
        status: OrderStatus.Filled,
        remainingAmount: '0',
      };

      const message = createOrderStatusMessageFromAffected(affected);

      expect(message.status).toBe('FILLED');
    });

    it('should handle PARTIALLY_FILLED status', () => {
      const affected: AffectedOrder = {
        orderId: '123e4567-e89b-12d3-a456-426614174000',
        status: OrderStatus.PartiallyFilled,
        remainingAmount: '700000',
      };

      const message = createOrderStatusMessageFromAffected(affected);

      expect(message.status).toBe('PARTIALLY_FILLED');
    });

    it('should preserve remainingAmount as string', () => {
      const largeAmount = '999999999999999999999999';
      const affected: AffectedOrder = {
        orderId: '123e4567-e89b-12d3-a456-426614174000',
        status: OrderStatus.PartiallyFilled,
        remainingAmount: largeAmount,
      };

      const message = createOrderStatusMessageFromAffected(affected);

      expect(message.remainingAmount).toBe(largeAmount);
      expect(typeof message.remainingAmount).toBe('string');
    });
  });

  describe('createMatchCreatedMessage', () => {
    it('should create match created message from result', () => {
      const orderId = '123e4567-e89b-12d3-a456-426614174000';
      const result: MatchResult = {
        matches: [],
        remainingOrder: null,
        affectedMakerOrders: [],
      };

      const message = createMatchCreatedMessage(orderId, result);

      expect(message.orderId).toBe(orderId);
      expect(message.matches).toEqual([]);
      expect(message.remainingOrder).toBeNull();
      expect(typeof message.timestamp).toBe('number');
    });

    it('should include matches array', () => {
      const orderId = '123e4567-e89b-12d3-a456-426614174000';
      const mockMatch = {
        matchId: '223e4567-e89b-12d3-a456-426614174001',
        lendOrderId: orderId,
        borrowOrderId: '323e4567-e89b-12d3-a456-426614174002',
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: '1000000',
        rate: 500,
        loanToken: '0x1234567890123456789012345678901234567890',
        maturity: 1704067200,
        timestamp: Date.now(),
        borrowerIsTaker: true,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        settlementFeeAmount: '10000',
      };
      const result: MatchResult = {
        matches: [mockMatch],
        remainingOrder: null,
        affectedMakerOrders: [],
      };

      const message = createMatchCreatedMessage(orderId, result);

      expect(message.matches).toHaveLength(1);
      expect(message.matches[0]).toEqual(mockMatch);
    });

    it('should include remainingOrder when present', () => {
      const orderId = '123e4567-e89b-12d3-a456-426614174000';
      const result: MatchResult = {
        matches: [],
        remainingOrder: {
          orderId,
          remainingAmount: '500000',
          status: 'PARTIALLY_FILLED',
        },
        affectedMakerOrders: [],
      };

      const message = createMatchCreatedMessage(orderId, result);

      expect(message.remainingOrder).not.toBeNull();
      expect(message.remainingOrder.orderId).toBe(orderId);
      expect(message.remainingOrder.remainingAmount).toBe('500000');
    });
  });

  describe('createErrorMessage', () => {
    it('should create error message with required fields', () => {
      const message = createErrorMessage(
        ERROR_CODES.INVALID_ORDER,
        'Invalid order format'
      );

      expect(message.error).toBe(true);
      expect(message.code).toBe(ERROR_CODES.INVALID_ORDER);
      expect(message.message).toBe('Invalid order format');
      expect(typeof message.timestamp).toBe('number');
    });

    it('should include optional orderId', () => {
      const orderId = '123e4567-e89b-12d3-a456-426614174000';
      const message = createErrorMessage(
        ERROR_CODES.ORDER_NOT_FOUND,
        'Order not found',
        orderId
      );

      expect(message.orderId).toBe(orderId);
    });

    it('should include optional details', () => {
      const details = { field: 'rate', value: -100 };
      const message = createErrorMessage(
        ERROR_CODES.VALIDATION_ERROR,
        'Validation failed',
        undefined,
        details
      );

      expect(message.details).toEqual(details);
    });
  });
});
