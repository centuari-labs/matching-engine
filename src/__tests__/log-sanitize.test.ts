import { truncatePayload } from '../utils/log-sanitize';

/**
 * M-16 audit fix tests.
 *
 * `truncatePayload` is used in DB-writer error paths to keep
 * full request bodies out of error logs. The function must:
 * - Pass small strings through unchanged.
 * - Truncate long strings with a stable correlation hash so
 *   operators can correlate two log lines from the same bad
 *   payload without persisting the body.
 * - Handle non-string inputs via cycle-safe stringify.
 * - Never throw, even on inputs JSON.stringify rejects
 *   (cyclic refs, BigInt, etc.).
 */
describe('M-16: truncatePayload', () => {
  it('passes short strings through unchanged', () => {
    const input = 'a small error payload';
    expect(truncatePayload(input)).toBe(input);
  });

  it('truncates strings longer than maxLen and appends sha256 hash', () => {
    const input = 'x'.repeat(1024);
    const result = truncatePayload(input);

    expect(result.length).toBeLessThan(input.length);
    expect(result).toMatch(/^x{64}\.\.\.\[truncated, sha256=[0-9a-f]{16}, len=1024\]$/);
  });

  it('produces a stable hash so repeated truncations correlate', () => {
    const input = 'y'.repeat(2000);
    expect(truncatePayload(input)).toBe(truncatePayload(input));
  });

  it('stringifies non-string input via safe JSON before truncation', () => {
    const obj = { wallet: '0xabc', amount: '1000' };
    expect(truncatePayload(obj)).toBe(JSON.stringify(obj));
  });

  it('handles cyclic references without throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;

    expect(() => truncatePayload(cyclic)).not.toThrow();
    expect(truncatePayload(cyclic)).toMatch(/^\[unserializable: object\]$/);
  });

  it('respects custom maxLen as truncation threshold', () => {
    const input = 'abcdefghij'; // 10 chars
    expect(truncatePayload(input, 100)).toBe(input);
    // Below threshold: triggers truncation. Preview is up to 64 chars
    // (full string here since it is 10 chars). Hash + length still
    // appended for correlation.
    expect(truncatePayload(input, 5)).toMatch(/^abcdefghij\.\.\.\[truncated, sha256=[0-9a-f]{16}, len=10\]$/);
  });
});
