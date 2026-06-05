import { MatchingEngine } from '../core/matching-engine';
import { handleCancelOrderRequest, type HandlerContext } from '../services/message-handlers';
import { NATS_TOPICS } from '../config/nats-config';
import { cancelReplySchema, type CancelReply } from '../types/messages';
import { createLendLimitOrder, marketsFromMaturities } from './factories/order-factory';
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

/**
 * Minimal mock of a request/reply NATS Msg: captures the responded payload.
 */
function createMockMsg(payload: Record<string, unknown>, reply = '_INBOX.test') {
  const responses: string[] = [];
  const respond = jest.fn((data: string | Uint8Array) => {
    responses.push(typeof data === 'string' ? data : new TextDecoder().decode(data));
    return true;
  });
  return {
    data: toBytes(payload),
    reply,
    respond,
    getReply: (): CancelReply | undefined =>
      responses.length > 0 ? (JSON.parse(responses[0]) as CancelReply) : undefined,
  };
}

describe('handleCancelOrderRequest (request/reply)', () => {
  let engine: MatchingEngine;
  let mockNc: ReturnType<typeof createMockNatsConnection>;
  let ctx: HandlerContext;

  const loanToken = '0x1234567890123456789012345678901234567890';
  const owner = '0x1111111111111111111111111111111111111111';
  const stranger = '0x2222222222222222222222222222222222222222';
  const maturity = 1704067200;

  beforeEach(() => {
    engine = new MatchingEngine();
    mockNc = createMockNatsConnection();
    ctx = { nc: mockNc as unknown as HandlerContext['nc'], engine };
  });

  function restingOrder() {
    const order = createLendLimitOrder({
      walletAddress: owner,
      loanToken,
      markets: marketsFromMaturities([maturity]),
      originalAmount: '1000000',
      remainingAmount: '1000000',
      settlementFeeAmount: '10000',
      rate: 500,
    });
    engine.submitOrder(order);
    return order;
  }

  it('replies CANCELLED, removes the order, and publishes orders.status', () => {
    const order = restingOrder();
    const msg = createMockMsg({
      orderId: order.orderId,
      walletAddress: owner,
      timestamp: Date.now(),
    });

    handleCancelOrderRequest(ctx, msg as never);

    const reply = msg.getReply();
    expect(reply).toEqual({
      outcome: 'CANCELLED',
      orderId: order.orderId,
      remainingAmount: '1000000',
    });
    // Reply conforms to the shared contract
    expect(cancelReplySchema.safeParse(reply).success).toBe(true);
    // Order is gone from the book
    expect(engine.hasOrder(order.orderId)).toBe(false);
    // orders.status CANCELLED published for orderbook/WS + DB writer
    const statusMsgs = mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS);
    expect(statusMsgs.length).toBe(1);
    expect(JSON.parse(statusMsgs[0].data).status).toBe('CANCELLED');
  });

  it('replies NOT_OWNER and leaves the order in the book when the wallet does not own it', () => {
    const order = restingOrder();
    const msg = createMockMsg({
      orderId: order.orderId,
      walletAddress: stranger,
      timestamp: Date.now(),
    });

    handleCancelOrderRequest(ctx, msg as never);

    expect(msg.getReply()).toEqual({ outcome: 'NOT_OWNER', orderId: order.orderId });
    expect(engine.hasOrder(order.orderId)).toBe(true);
    expect(mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS).length).toBe(0);
  });

  it('replies NOT_FOUND when the order is not in the book', () => {
    const orderId = generateOrderId();
    const msg = createMockMsg({ orderId, walletAddress: owner, timestamp: Date.now() });

    handleCancelOrderRequest(ctx, msg as never);

    expect(msg.getReply()).toEqual({ outcome: 'NOT_FOUND', orderId });
    expect(mockNc.getMessagesForTopic(NATS_TOPICS.ORDERS_STATUS).length).toBe(0);
  });

  it('does not respond when the message cannot be parsed (requester rejects on timeout)', () => {
    const msg = createMockMsg({ orderId: 'not-a-uuid', walletAddress: owner });

    handleCancelOrderRequest(ctx, msg as never);

    expect(msg.respond).not.toHaveBeenCalled();
  });

  it('does not throw or respond when there is no reply subject', () => {
    const order = restingOrder();
    const msg = createMockMsg(
      { orderId: order.orderId, walletAddress: owner, timestamp: Date.now() },
      ''
    );

    expect(() => handleCancelOrderRequest(ctx, msg as never)).not.toThrow();
    expect(msg.respond).not.toHaveBeenCalled();
    // The cancel still took effect (side effect happens before the reply guard)
    expect(engine.hasOrder(order.orderId)).toBe(false);
  });
});

// L1: the legacy fire-and-forget `orders.cancel` subject and its handler were
// retired (the backend publishes cancels only to `orders.cancel.request`). Guard
// against accidental reintroduction.
describe('legacy fire-and-forget cancel path retired', () => {
  it('no longer exports handleCancelOrder', () => {
    const handlers = require('../services/message-handlers');
    expect(handlers.handleCancelOrder).toBeUndefined();
  });

  it('no longer defines a legacy ORDERS_CANCEL topic constant', () => {
    expect((NATS_TOPICS as Record<string, string>).ORDERS_CANCEL).toBeUndefined();
    // The request/reply subject is the only cancel subject that remains.
    expect(NATS_TOPICS.ORDERS_CANCEL_REQUEST).toBe('orders.cancel.request');
  });
});
