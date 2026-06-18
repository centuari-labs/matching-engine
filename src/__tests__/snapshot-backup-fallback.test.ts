/**
 * M2: a corrupted `latest.json` must fall back to the on-disk `backup.json`
 * (read + Zod-validated) instead of silently starting with an empty book.
 *
 * Uses a real temp directory and a real (disabled) Redis so the only viable
 * fallback is the backup file.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { SnapshotService } from '../services/snapshot-service';
import { OrderBook } from '../core/order-book';
import { ExecutionEngine } from '../core/execution-engine';
import { createLendLimitOrder } from './factories/order-factory';

describe('M2: SnapshotService backup.json fallback', () => {
  const testDir = path.join(__dirname, '../../test-snapshots-backup-fallback');

  async function cleanup(): Promise<void> {
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => undefined);
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  it('recovers from backup.json when latest.json is corrupt (Redis disabled)', async () => {
    const service = new SnapshotService(testDir, null, false);
    const orderBook = new OrderBook();
    const executionEngine = new ExecutionEngine();

    // First save: creates latest.json (no backup yet).
    orderBook.addOrder(createLendLimitOrder());
    await service.saveSnapshot(orderBook, executionEngine);

    // Second save: rotates the first latest.json into backup.json and writes a
    // fresh latest.json. backup.json now holds a valid 1-order book.
    orderBook.addOrder(
      createLendLimitOrder({
        orderId: '99999999-9999-9999-9999-999999999999',
        walletAddress: '0x3333333333333333333333333333333333333333',
      })
    );
    await service.saveSnapshot(orderBook, executionEngine);

    // Corrupt latest.json so the primary read fails.
    const latestPath = path.join(testDir, 'latest.json');
    await fs.writeFile(latestPath, '{ this is : not valid json', 'utf-8');

    // Load must NOT return null / empty — it must recover the prior good book
    // from backup.json.
    const loaded = await service.loadSnapshot();
    expect(loaded).not.toBeNull();
    expect(loaded!.orders.length).toBe(1); // backup held the first (1-order) save
  });

  it('returns null when latest.json is corrupt and no backup exists', async () => {
    const service = new SnapshotService(testDir, null, false);
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'latest.json'), 'not json', 'utf-8');

    const loaded = await service.loadSnapshot();
    expect(loaded).toBeNull();
  });

  it('ignores a corrupt backup.json and returns null (does not throw)', async () => {
    const service = new SnapshotService(testDir, null, false);
    await fs.mkdir(testDir, { recursive: true });
    await fs.writeFile(path.join(testDir, 'latest.json'), 'not json', 'utf-8');
    await fs.writeFile(path.join(testDir, 'backup.json'), 'also not json', 'utf-8');

    await expect(service.loadSnapshot()).resolves.toBeNull();
  });
});
