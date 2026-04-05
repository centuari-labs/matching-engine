/**
 * Disk Persistence Service Tests
 *
 * Tests for flushing and loading unpublished matches to/from disk.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { DiskPersistenceService } from '../services/disk-persistence-service';
import { createMatch } from './factories/match-factory';

describe('DiskPersistenceService', () => {
  let tempDir: string;
  let service: DiskPersistenceService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'disk-persist-test-'));
    service = new DiskPersistenceService(tempDir);
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('flush', () => {
    it('should write matches as JSON Lines', async () => {
      const matches = [createMatch(), createMatch()];

      await service.flush(matches);

      const content = await fs.readFile(path.join(tempDir, 'unpublished-matches.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).matchId).toBe(matches[0].matchId);
      expect(JSON.parse(lines[1]).matchId).toBe(matches[1].matchId);
    });

    it('should not create file for empty array', async () => {
      await service.flush([]);

      const exists = await service.exists();
      expect(exists).toBe(false);
    });

    it('should create directory if it does not exist', async () => {
      const nestedDir = path.join(tempDir, 'nested', 'dir');
      const nestedService = new DiskPersistenceService(nestedDir);

      await nestedService.flush([createMatch()]);

      const exists = await nestedService.exists();
      expect(exists).toBe(true);
    });

    it('should overwrite existing file', async () => {
      const match1 = createMatch();
      const match2 = createMatch();

      await service.flush([match1]);
      await service.flush([match2]);

      const content = await fs.readFile(path.join(tempDir, 'unpublished-matches.jsonl'), 'utf-8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).matchId).toBe(match2.matchId);
    });
  });

  describe('load', () => {
    it('should read and validate matches', async () => {
      const matches = [createMatch(), createMatch()];
      await service.flush(matches);

      const loaded = await service.load();

      expect(loaded).toHaveLength(2);
      expect(loaded[0].matchId).toBe(matches[0].matchId);
      expect(loaded[1].matchId).toBe(matches[1].matchId);
    });

    it('should delete file after successful load', async () => {
      await service.flush([createMatch()]);

      await service.load();

      const exists = await service.exists();
      expect(exists).toBe(false);
    });

    it('should skip malformed lines with a warning', async () => {
      const match = createMatch();
      const content = JSON.stringify(match) + '\n' + 'not-valid-json\n';
      await fs.writeFile(path.join(tempDir, 'unpublished-matches.jsonl'), content, 'utf-8');

      const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const loaded = await service.load();

      expect(loaded).toHaveLength(1);
      expect(loaded[0].matchId).toBe(match.matchId);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Skipping malformed line'));

      warnSpy.mockRestore();
    });

    it('should throw when file does not exist', async () => {
      await expect(service.load()).rejects.toThrow();
    });
  });

  describe('exists', () => {
    it('should return false when no file exists', async () => {
      expect(await service.exists()).toBe(false);
    });

    it('should return true after flush', async () => {
      await service.flush([createMatch()]);
      expect(await service.exists()).toBe(true);
    });

    it('should return false after load (file deleted)', async () => {
      await service.flush([createMatch()]);
      await service.load();
      expect(await service.exists()).toBe(false);
    });
  });
});
