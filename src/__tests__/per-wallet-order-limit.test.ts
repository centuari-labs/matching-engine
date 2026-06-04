/**
 * M3: the in-memory order book must be bounded per wallet. A single wallet may
 * not rest more than MAX_OPEN_ORDERS_PER_WALLET open orders; further limit
 * orders are rejected with a clear error.
 */

import { MatchingEngine, MAX_OPEN_ORDERS_PER_WALLET } from '../core/matching-engine';
import { OrderBook } from '../core/order-book';
import { createLendLimitOrder } from './factories/order-factory';
import { generateOrderId } from '../utils/helpers';

const WALLET = '0x1111111111111111111111111111111111111111';

describe('M3: per-wallet open-order limit', () => {
  describe('OrderBook.getWalletOrderCount', () => {
    it('tracks add/remove per wallet (count lookup is case-insensitive)', () => {
      const book = new OrderBook();
      const id1 = generateOrderId();
      const id2 = generateOrderId();

      book.addOrder(createLendLimitOrder({ orderId: id1, walletAddress: WALLET }));
      book.addOrder(createLendLimitOrder({ orderId: id2, walletAddress: WALLET }));
      expect(book.getWalletOrderCount(WALLET)).toBe(2);
      // Lookup tolerates differing case from the stored (lowercase) wallet.
      expect(book.getWalletOrderCount(WALLET.toUpperCase())).toBe(2);

      book.removeOrder(id1);
      expect(book.getWalletOrderCount(WALLET)).toBe(1);

      book.removeOrder(id2);
      expect(book.getWalletOrderCount(WALLET)).toBe(0);
    });

    it('clear() resets per-wallet counts', () => {
      const book = new OrderBook();
      book.addOrder(createLendLimitOrder({ walletAddress: WALLET }));
      expect(book.getWalletOrderCount(WALLET)).toBe(1);
      book.clear();
      expect(book.getWalletOrderCount(WALLET)).toBe(0);
    });
  });

  describe('MatchingEngine.submitOrder enforcement', () => {
    it('rejects a new limit order once the wallet is at the cap', () => {
      const engine = new MatchingEngine();

      // Fill the book to the cap for one wallet. Use a far-future maturity and a
      // single resting side so nothing matches/fills (orders stay resting).
      for (let i = 0; i < MAX_OPEN_ORDERS_PER_WALLET; i++) {
        engine.submitOrder(
          createLendLimitOrder({ orderId: generateOrderId(), walletAddress: WALLET })
        );
      }

      // The next order from the same wallet must be rejected.
      expect(() =>
        engine.submitOrder(
          createLendLimitOrder({ orderId: generateOrderId(), walletAddress: WALLET })
        )
      ).toThrow(/Per-wallet open-order limit reached/);
    });

    it('allows other wallets past one wallet hitting the cap', () => {
      const engine = new MatchingEngine();
      const other = '0x2222222222222222222222222222222222222222';

      for (let i = 0; i < MAX_OPEN_ORDERS_PER_WALLET; i++) {
        engine.submitOrder(
          createLendLimitOrder({ orderId: generateOrderId(), walletAddress: WALLET })
        );
      }

      expect(() =>
        engine.submitOrder(
          createLendLimitOrder({ orderId: generateOrderId(), walletAddress: other })
        )
      ).not.toThrow();
    });

    it('allows a wallet to place again after cancelling an order at the cap', () => {
      const engine = new MatchingEngine();
      const ids: string[] = [];

      for (let i = 0; i < MAX_OPEN_ORDERS_PER_WALLET; i++) {
        const id = generateOrderId();
        ids.push(id);
        engine.submitOrder(createLendLimitOrder({ orderId: id, walletAddress: WALLET }));
      }

      // Free one slot, then a new order should be accepted.
      engine.cancelOrder(ids[0], WALLET);
      expect(() =>
        engine.submitOrder(
          createLendLimitOrder({ orderId: generateOrderId(), walletAddress: WALLET })
        )
      ).not.toThrow();
    });
  });
});
