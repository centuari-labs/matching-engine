import { MATCH_ID_NAMESPACE, deriveMatchId } from '../core/match-id';
import { matchSchema } from '../types/matches';
import { ExecutionEngine } from '../core/execution-engine';
import { DEFAULT_LOAN_TOKEN, DEFAULT_MATURITY } from './factories/order-factory';

/**
 * M-2 audit fix tests.
 *
 * Two concerns:
 * 1. `deriveMatchId` is deterministic, collision-free across legitimate
 *    inputs, format-stable (UUID v5), and accepted by `matchSchema`.
 * 2. `ExecutionEngine.recordMatch` dedups duplicates in memory and
 *    returns null on duplicate so callers can skip side effects.
 *
 * Golden vector locks the namespace + algorithm together — a regression
 * here would silently break settlement-engine deduplication.
 */
describe('M-2: deriveMatchId', () => {
  const baseParams = {
    lendOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    borrowOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    matchedAmount: '1000000',
    lendRemainingAfter: '500000',
    borrowRemainingAfter: '0',
  };

  describe('MATCH_ID_NAMESPACE constant', () => {
    it('is pinned to the exact value committed in source', () => {
      // Golden snapshot: regenerating MATCH_ID_NAMESPACE invalidates every
      // post-fix matchId. If this test fails, do NOT update it — find out
      // who changed the constant and revert.
      expect(MATCH_ID_NAMESPACE).toBe('6697f9f3-58f4-4c55-af1a-3bbd3ef8e17b');
    });

    it('is a valid UUID v4 string', () => {
      expect(MATCH_ID_NAMESPACE).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });
  });

  describe('determinism', () => {
    it('returns the same id for identical inputs across calls', () => {
      const first = deriveMatchId(baseParams);
      const second = deriveMatchId(baseParams);
      expect(first).toBe(second);
    });

    it('matches a frozen golden vector', () => {
      // Locks the entire derivation: namespace + seed format + uuidv5
      // hash output. If you change ANY of these without bumping the
      // namespace, this test will catch it.
      const id = deriveMatchId(baseParams);
      // Computed once via the implementation; assert exact value.
      expect(id).toBe('f6c5d532-df6b-5e14-b95e-2434317447bd');
    });
  });

  describe('field sensitivity (collision avoidance)', () => {
    it('returns a different id when lendOrderId differs', () => {
      const a = deriveMatchId(baseParams);
      const b = deriveMatchId({
        ...baseParams,
        lendOrderId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      });
      expect(a).not.toBe(b);
    });

    it('returns a different id when borrowOrderId differs', () => {
      const a = deriveMatchId(baseParams);
      const b = deriveMatchId({
        ...baseParams,
        borrowOrderId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      });
      expect(a).not.toBe(b);
    });

    it('returns a different id when matchedAmount differs', () => {
      const a = deriveMatchId(baseParams);
      const b = deriveMatchId({ ...baseParams, matchedAmount: '999999' });
      expect(a).not.toBe(b);
    });

    it('returns a different id when lendRemainingAfter differs', () => {
      const a = deriveMatchId(baseParams);
      const b = deriveMatchId({ ...baseParams, lendRemainingAfter: '400000' });
      expect(a).not.toBe(b);
    });

    it('returns a different id when borrowRemainingAfter differs', () => {
      const a = deriveMatchId(baseParams);
      const b = deriveMatchId({ ...baseParams, borrowRemainingAfter: '100' });
      expect(a).not.toBe(b);
    });
  });

  describe('format', () => {
    it('returns a valid UUID v5 string', () => {
      const id = deriveMatchId(baseParams);
      // UUID v5 has version `5` in the 13th hex character.
      expect(id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    it('passes matchSchema.parse', () => {
      const id = deriveMatchId(baseParams);
      // Build a full Match shape around the derived id and parse.
      const fullMatch = {
        matchId: id,
        marketId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        lendOrderId: baseParams.lendOrderId,
        borrowOrderId: baseParams.borrowOrderId,
        lenderWallet: '0x1111111111111111111111111111111111111111',
        borrowerWallet: '0x2222222222222222222222222222222222222222',
        matchedAmount: baseParams.matchedAmount,
        rate: 500,
        loanToken: DEFAULT_LOAN_TOKEN,
        maturity: DEFAULT_MATURITY,
        timestamp: Date.now(),
        borrowerIsTaker: false,
        makerFeeAmount: '1000',
        takerFeeAmount: '2000',
        lenderSettlementFeeAmount: '5000',
        borrowerSettlementFeeAmount: '5000',
      };
      expect(() => matchSchema.parse(fullMatch)).not.toThrow();
    });
  });
});

describe('M-2: ExecutionEngine.recordMatch dedup', () => {
  let engine: ExecutionEngine;
  let warnSpy: jest.SpyInstance;

  const matchParams = {
    marketId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    lendOrderId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    borrowOrderId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    lenderWallet: '0x1111111111111111111111111111111111111111',
    borrowerWallet: '0x2222222222222222222222222222222222222222',
    matchedAmount: '1000000',
    lendRemainingAfter: '500000',
    borrowRemainingAfter: '0',
    rate: 500,
    loanToken: DEFAULT_LOAN_TOKEN,
    maturity: DEFAULT_MATURITY,
    borrowerIsTaker: false,
    makerFeeAmount: '1000',
    takerFeeAmount: '2000',
    lenderSettlementFeeAmount: '5000',
    borrowerSettlementFeeAmount: '5000',
  };

  beforeEach(() => {
    engine = new ExecutionEngine();
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('records the first match normally', () => {
    const match = engine.recordMatch(matchParams);
    expect(match).not.toBeNull();
    expect(match!.matchId).toBeDefined();
    expect(engine.matchCount).toBe(1);
  });

  it('returns null on a second call with identical params (same derived matchId)', () => {
    const first = engine.recordMatch(matchParams);
    const second = engine.recordMatch(matchParams);
    expect(second).toBeNull();
    expect(engine.matchCount).toBe(1); // not 2 — dedup blocked the duplicate
    expect(first!.matchId).toBe(deriveMatchId(matchParams));
  });

  it('warns on duplicate matchId', () => {
    engine.recordMatch(matchParams);
    engine.recordMatch(matchParams);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Duplicate match rejected:')
    );
  });

  it('does NOT pollute matches Map or indexing arrays on duplicate', () => {
    engine.recordMatch(matchParams);
    const sizeBefore = engine.matchCount;
    const lendMatchesBefore = engine.getMatchesForOrder(matchParams.lendOrderId);

    engine.recordMatch(matchParams);

    expect(engine.matchCount).toBe(sizeBefore);
    expect(engine.getMatchesForOrder(matchParams.lendOrderId)).toEqual(lendMatchesBefore);
  });

  it('different inputs produce distinct matchIds and both record', () => {
    const a = engine.recordMatch(matchParams);
    const b = engine.recordMatch({ ...matchParams, matchedAmount: '500000' });

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.matchId).not.toBe(b!.matchId);
    expect(engine.matchCount).toBe(2);
  });
});
