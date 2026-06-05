import { updateOrderMessageSchema, orderUpdatedMessageSchema } from '../types/messages';
import { generateOrderId } from '../utils/helpers';

const validWallet = '0x1111111111111111111111111111111111111111';

describe('updateOrderMessageSchema', () => {
  it('should accept a valid update with originalAmount and rate', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      originalAmount: '2000000',
      rate: 500,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should accept a valid update with only rate', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      rate: 750,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should reject message with no update fields (refine)', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-digit string amounts', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      originalAmount: '12.5',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject negative string amounts', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      originalAmount: '-100',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-UUID orderId', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: 'not-a-uuid',
      walletAddress: validWallet,
      rate: 500,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject invalid wallet address', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: 'not-an-address',
      rate: 500,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should default timestamp when not provided', () => {
    const before = Date.now();
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      rate: 500,
    });
    const after = Date.now();

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timestamp).toBeGreaterThanOrEqual(before);
      expect(result.data.timestamp).toBeLessThanOrEqual(after);
    }
  });

  it('should accept quantity field as an alternative to originalAmount', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      quantity: '5000000',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should accept amount field as an alternative', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      amount: '5000000',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should accept settlementFee as an alternative to settlementFeeAmount', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      settlementFee: '50000',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  // L2: the update path must enforce the same [1, 10000] bps cap the placement
  // path enforces (backend create-order.dto.ts), otherwise an update can push
  // rate above the placement-time bound.
  it('should reject rate above the 10000-bps cap', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      rate: 10001,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should reject rate below the minimum of 1 bps', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      rate: 0,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('should accept rate at the 10000-bps cap boundary', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      rate: 10000,
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should accept an update that omits rate entirely', () => {
    const result = updateOrderMessageSchema.safeParse({
      orderId: generateOrderId(),
      walletAddress: validWallet,
      originalAmount: '2000000',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });
});

describe('orderUpdatedMessageSchema', () => {
  it('should accept a valid event shape', () => {
    const result = orderUpdatedMessageSchema.safeParse({
      orderId: generateOrderId(),
      originalAmount: '2000000',
      remainingAmount: '1000000',
      rate: 500,
      settlementFeeAmount: '20000',
      remainingSettlementFeeAmount: '10000',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(true);
  });

  it('should reject when required fields are missing', () => {
    const result = orderUpdatedMessageSchema.safeParse({
      orderId: generateOrderId(),
      // Missing all other required fields
    });
    expect(result.success).toBe(false);
  });

  it('should reject non-positive rate', () => {
    const result = orderUpdatedMessageSchema.safeParse({
      orderId: generateOrderId(),
      originalAmount: '2000000',
      remainingAmount: '1000000',
      rate: 0,
      settlementFeeAmount: '20000',
      remainingSettlementFeeAmount: '10000',
      timestamp: Date.now(),
    });
    expect(result.success).toBe(false);
  });
});
