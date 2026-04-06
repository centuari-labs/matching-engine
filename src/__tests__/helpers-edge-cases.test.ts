import {
  subtractBigNumbers,
  calculateProRataSettlementFee,
  calculateMakerFee,
  calculateTakerFee,
  createOrderComparator,
  compareBigNumbers,
  validateTokenAddress,
} from '../utils/helpers';
import { OrderSide } from '../types/orders';
import {
  createLendLimitOrder,
  createBorrowLimitOrder,
  createLendMarketOrder,
  createBorrowMarketOrder,
} from './factories/order-factory';

describe('subtractBigNumbers', () => {
  it('throws when a < b', () => {
    expect(() => subtractBigNumbers('5', '10')).toThrow(
      'Result of subtraction cannot be negative'
    );
  });

  it('throws when subtracting 1 from 0', () => {
    expect(() => subtractBigNumbers('0', '1')).toThrow(
      'Result of subtraction cannot be negative'
    );
  });

  it('returns "0" when both operands are zero', () => {
    expect(subtractBigNumbers('0', '0')).toBe('0');
  });

  it('returns correct difference for normal values', () => {
    expect(subtractBigNumbers('10', '5')).toBe('5');
  });

  it('handles very large numbers', () => {
    expect(subtractBigNumbers('999999999999999999999999', '1')).toBe(
      '999999999999999999999998'
    );
  });
});

describe('calculateProRataSettlementFee', () => {
  it('rounds up with ceiling division', () => {
    // ceil(10 * 3 / 9) = ceil(3.33) = 4
    expect(calculateProRataSettlementFee('10', '3', '9')).toBe('4');
  });

  it('returns exact value when evenly divisible', () => {
    // 10 * 5 / 10 = 5
    expect(calculateProRataSettlementFee('10', '5', '10')).toBe('5');
  });

  it('returns "0" when originalAmount is "0"', () => {
    expect(calculateProRataSettlementFee('10', '5', '0')).toBe('0');
  });

  it('returns totalFee for a full fill', () => {
    expect(
      calculateProRataSettlementFee('10000', '1000000', '1000000')
    ).toBe('10000');
  });

  it('returns "0" when totalFee is "0"', () => {
    expect(calculateProRataSettlementFee('0', '500', '1000')).toBe('0');
  });

  it('rounds up small fee on small match', () => {
    // ceil(1 * 1 / 10) = ceil(0.1) = 1
    expect(calculateProRataSettlementFee('1', '1', '10')).toBe('1');
  });

  it('handles large values correctly', () => {
    // 10000000000 * 500000000 / 1000000000 = 5000000000
    expect(
      calculateProRataSettlementFee(
        '10000000000',
        '500000000',
        '1000000000'
      )
    ).toBe('5000000000');
  });
});

describe('calculateMakerFee', () => {
  it('returns "0" for 0 BPS', () => {
    expect(calculateMakerFee('1000000', 0)).toBe('0');
  });

  it('floors to "0" when amount is too small', () => {
    // floor(1 * 10 / 10000) = floor(0.001) = 0
    expect(calculateMakerFee('1', 10)).toBe('0');
  });

  it('floors to "0" when product is below 10000', () => {
    // floor(9999 * 1 / 10000) = floor(0.9999) = 0
    expect(calculateMakerFee('9999', 1)).toBe('0');
  });

  it('returns "1" at the exact threshold', () => {
    // floor(10000 * 1 / 10000) = 1
    expect(calculateMakerFee('10000', 1)).toBe('1');
  });

  it('returns full amount at max BPS (10000)', () => {
    // floor(1000000 * 10000 / 10000) = 1000000
    expect(calculateMakerFee('1000000', 10000)).toBe('1000000');
  });
});

describe('calculateTakerFee', () => {
  it('returns "0" for 0 BPS', () => {
    expect(calculateTakerFee('1000000', 0)).toBe('0');
  });

  it('returns full amount at max BPS (10000)', () => {
    expect(calculateTakerFee('1000000', 10000)).toBe('1000000');
  });
});

describe('createOrderComparator', () => {
  describe('LEND side', () => {
    const compare = createOrderComparator(OrderSide.Lend);

    it('sorts limit orders by rate ascending', () => {
      const low = createLendLimitOrder({ rate: 100, timestamp: 1000 });
      const high = createLendLimitOrder({ rate: 500, timestamp: 1000 });

      expect(compare(low, high)).toBeLessThan(0);
      expect(compare(high, low)).toBeGreaterThan(0);
    });

    it('sorts market orders after all limit orders', () => {
      const limit = createLendLimitOrder({ rate: 9999, timestamp: 1000 });
      const market = createLendMarketOrder({ timestamp: 1000 });

      expect(compare(limit, market)).toBeLessThan(0);
    });

    it('breaks ties on same rate by earlier timestamp first', () => {
      const earlier = createLendLimitOrder({ rate: 500, timestamp: 1000 });
      const later = createLendLimitOrder({ rate: 500, timestamp: 2000 });

      expect(compare(earlier, later)).toBeLessThan(0);
    });

    it('sorts two market orders by timestamp', () => {
      const first = createLendMarketOrder({ timestamp: 1000 });
      const second = createLendMarketOrder({ timestamp: 2000 });

      expect(compare(first, second)).toBeLessThan(0);
    });
  });

  describe('BORROW side', () => {
    const compare = createOrderComparator(OrderSide.Borrow);

    it('sorts limit orders by rate descending', () => {
      const low = createBorrowLimitOrder({ rate: 100, timestamp: 1000 });
      const high = createBorrowLimitOrder({ rate: 500, timestamp: 1000 });

      expect(compare(high, low)).toBeLessThan(0);
      expect(compare(low, high)).toBeGreaterThan(0);
    });

    it('sorts market orders after all limit orders', () => {
      const limit = createBorrowLimitOrder({ rate: 1, timestamp: 1000 });
      const market = createBorrowMarketOrder({ timestamp: 1000 });

      expect(compare(limit, market)).toBeLessThan(0);
    });

    it('breaks ties on same rate by earlier timestamp first', () => {
      const earlier = createBorrowLimitOrder({ rate: 500, timestamp: 1000 });
      const later = createBorrowLimitOrder({ rate: 500, timestamp: 2000 });

      expect(compare(earlier, later)).toBeLessThan(0);
    });

    it('sorts two market orders by timestamp', () => {
      const first = createBorrowMarketOrder({ timestamp: 1000 });
      const second = createBorrowMarketOrder({ timestamp: 2000 });

      expect(compare(first, second)).toBeLessThan(0);
    });
  });
});

describe('compareBigNumbers', () => {
  it('treats leading zeros as equal', () => {
    expect(compareBigNumbers('00100', '100')).toBe(0);
  });

  it('treats pure zeros as equal', () => {
    expect(compareBigNumbers('000', '0')).toBe(0);
  });

  it('returns negative when a < b with different lengths', () => {
    expect(compareBigNumbers('99', '100')).toBeLessThan(0);
  });

  it('returns positive when a > b with same length', () => {
    expect(compareBigNumbers('200', '100')).toBeGreaterThan(0);
  });
});

describe('validateTokenAddress', () => {
  it('returns true for a valid lowercase address', () => {
    expect(
      validateTokenAddress('0x1234567890123456789012345678901234567890')
    ).toBe(true);
  });

  it('returns true for a valid uppercase address', () => {
    expect(
      validateTokenAddress('0xABCDEF0123456789ABCDEF0123456789ABCDEF01')
    ).toBe(true);
  });

  it('returns false when missing 0x prefix', () => {
    expect(
      validateTokenAddress('1234567890123456789012345678901234567890')
    ).toBe(false);
  });

  it('returns false for a short address', () => {
    expect(validateTokenAddress('0x12345')).toBe(false);
  });

  it('returns false for invalid hex characters', () => {
    expect(
      validateTokenAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')
    ).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(validateTokenAddress('')).toBe(false);
  });
});
