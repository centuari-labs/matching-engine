import { MatchingEngine } from '../core/matching-engine';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  DEFAULT_LOAN_TOKEN,
} from './factories/order-factory';
import {
  ethereumAddressSchema,
  lendLimitOrderSchema,
} from '../types/orders';

/**
 * M-6 audit fix tests.
 *
 * Ethereum addresses are case-insensitive. Two strings that differ
 * only in case ("0xAbC..." vs "0xabc...") refer to the same wallet
 * and the same ERC-20 contract. The matching engine must:
 *
 * 1. Normalize addresses to lowercase at Zod parse time, so anything
 *    flowing through `orderSchema` is canonicalized.
 * 2. Refuse to self-match the same wallet even when the two sides
 *    arrived in different casing (defense-in-depth at compare sites
 *    in matching-engine.ts).
 * 3. Match orders for the same loan token regardless of the casing
 *    used by the submitter.
 *
 * Audit reference: M-6.
 */
describe('M-6: ethereumAddressSchema normalization', () => {
  it('lowercases mixed-case addresses on parse', () => {
    const mixed = '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01';
    const parsed = ethereumAddressSchema.parse(mixed);
    expect(parsed).toBe(mixed.toLowerCase());
  });

  it('leaves already-lowercase addresses unchanged', () => {
    const lower = '0xabcdef0123456789abcdef0123456789abcdef01';
    expect(ethereumAddressSchema.parse(lower)).toBe(lower);
  });

  it('rejects malformed addresses before lowercasing', () => {
    expect(() => ethereumAddressSchema.parse('0xZZZ')).toThrow();
  });

  it('normalizes addresses inside an order via the union schema', () => {
    const upperWallet = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const upperToken = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const raw = createLendLimitOrder({
      walletAddress: upperWallet,
      loanToken: upperToken,
    });
    const parsed = lendLimitOrderSchema.parse(raw);
    expect(parsed.walletAddress).toBe(upperWallet.toLowerCase());
    expect(parsed.loanToken).toBe(upperToken.toLowerCase());
  });
});

describe('M-6: case-insensitive matching behavior', () => {
  const LENDER = '0xCAFE000000000000000000000000000000000001';
  const BORROWER = '0xBEEF000000000000000000000000000000000002';

  it('prevents self-match when the same wallet submits both sides in different casing', () => {
    const engine = new MatchingEngine();
    const sameWalletUpper = '0xDEAD000000000000000000000000000000000003';
    const sameWalletLower = sameWalletUpper.toLowerCase();

    const lend = createLendLimitOrder({
      walletAddress: sameWalletUpper,
      rate: 500,
      originalAmount: '1000000',
      remainingAmount: '1000000',
    });
    const borrow = createBorrowLimitOrder({
      walletAddress: sameWalletLower,
      rate: 500,
      originalAmount: '1000000',
      remainingAmount: '1000000',
    });

    engine.submitOrder(lend);
    const result = engine.submitOrder(borrow);

    expect(result.matches).toHaveLength(0);
  });

  it('matches counterparties whose addresses differ only in casing on the same loan token', () => {
    const engine = new MatchingEngine();

    const upperToken = DEFAULT_LOAN_TOKEN.toUpperCase().replace('0X', '0x');

    const lend = createLendLimitOrder({
      walletAddress: LENDER.toUpperCase().replace('0X', '0x'),
      loanToken: upperToken,
      rate: 500,
      originalAmount: '1000000',
      remainingAmount: '1000000',
    });
    const borrow = createBorrowLimitOrder({
      walletAddress: BORROWER.toLowerCase(),
      loanToken: DEFAULT_LOAN_TOKEN, // already lowercase
      rate: 500,
      originalAmount: '1000000',
      remainingAmount: '1000000',
    });

    engine.submitOrder(lend);
    const result = engine.submitOrder(borrow);

    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches[0];
    expect(match.lenderWallet).toBe(LENDER.toLowerCase());
    expect(match.borrowerWallet).toBe(BORROWER.toLowerCase());
  });
});
