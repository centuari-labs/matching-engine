/**
 * M1: connection URLs with embedded credentials must not be logged in
 * cleartext. `maskUrl` strips userinfo and returns a `scheme://host` form.
 */

import { maskUrl } from '../utils/mask-url';

describe('M1: maskUrl', () => {
  it('strips password-only userinfo (redis style)', () => {
    expect(maskUrl('redis://:supersecret@redis.internal:6379')).toBe('redis://redis.internal:6379');
  });

  it('strips user:pass userinfo (nats style)', () => {
    expect(maskUrl('nats://user:pass@nats.internal:4222')).toBe('nats://nats.internal:4222');
  });

  it('strips credentials from a postgres connection string', () => {
    expect(maskUrl('postgres://admin:hunter2@db.internal:5432/centuari')).toBe(
      'postgres://db.internal:5432'
    );
  });

  it('leaves a credential-free URL host intact', () => {
    expect(maskUrl('nats://localhost:4222')).toBe('nats://localhost:4222');
  });

  it('masks each member of a comma-separated server list', () => {
    expect(maskUrl('nats://u:p@a.internal:4222,nats://u:p@b.internal:4222')).toBe(
      'nats://a.internal:4222,nats://b.internal:4222'
    );
  });

  it('never echoes an unparseable value', () => {
    expect(maskUrl('not a url with :secret@ in it')).toBe('[redacted-url]');
  });

  it('returns a redacted sentinel for empty/nullish input', () => {
    expect(maskUrl('')).toBe('[redacted-url]');
    expect(maskUrl(undefined)).toBe('[redacted-url]');
    expect(maskUrl(null)).toBe('[redacted-url]');
  });

  it('output never contains the original password', () => {
    const secret = 'topSecretPass123';
    const masked = maskUrl(`redis://:${secret}@host:6379`);
    expect(masked).not.toContain(secret);
  });
});
