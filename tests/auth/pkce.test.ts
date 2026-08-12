import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generatePkceChallenge, storePkceVerifier, consumePkceVerifier, isPkceEnabled } from '@/lib/auth/pkce';
import { createHash } from 'node:crypto';

describe('PKCE', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isPkceEnabled', () => {
    it('returns false when no env vars are set', () => {
      delete process.env.MS_PUBLIC_CLIENT;
      delete process.env.MS_PUBLIC_CLIENT_WORK;
      delete process.env.MS_PUBLIC_CLIENT_PERSONAL;
      expect(isPkceEnabled('work')).toBe(false);
      expect(isPkceEnabled('personal')).toBe(false);
    });

    it('returns true when generic MS_PUBLIC_CLIENT is true', () => {
      process.env.MS_PUBLIC_CLIENT = 'true';
      expect(isPkceEnabled('work')).toBe(true);
      expect(isPkceEnabled('personal')).toBe(true);
    });

    it('respects account-type-specific override', () => {
      process.env.MS_PUBLIC_CLIENT = 'false';
      process.env.MS_PUBLIC_CLIENT_WORK = 'true';
      expect(isPkceEnabled('work')).toBe(true);
      expect(isPkceEnabled('personal')).toBe(false);
    });

    it('is case insensitive', () => {
      process.env.MS_PUBLIC_CLIENT_WORK = 'True';
      expect(isPkceEnabled('work')).toBe(true);
    });
  });

  describe('generatePkceChallenge', () => {
    it('generates a valid verifier and challenge', () => {
      const { verifier, challenge, challengeMethod } = generatePkceChallenge();

      expect(verifier).toHaveLength(43); // 32 bytes base64url = 43 chars
      expect(challengeMethod).toBe('S256');

      // Verify challenge is SHA-256 of verifier
      const expectedChallenge = createHash('sha256').update(verifier).digest('base64url');
      expect(challenge).toBe(expectedChallenge);
    });

    it('generates unique verifiers each call', () => {
      const a = generatePkceChallenge();
      const b = generatePkceChallenge();
      expect(a.verifier).not.toBe(b.verifier);
    });
  });

  describe('storePkceVerifier / consumePkceVerifier', () => {
    it('stores and retrieves a verifier', () => {
      storePkceVerifier('test-instance-1', 'my-verifier');
      const result = consumePkceVerifier('test-instance-1');
      expect(result).toBe('my-verifier');
    });

    it('returns null after consuming (single use)', () => {
      storePkceVerifier('test-instance-2', 'one-time');
      consumePkceVerifier('test-instance-2');
      const result = consumePkceVerifier('test-instance-2');
      expect(result).toBeNull();
    });

    it('returns null for unknown instance', () => {
      expect(consumePkceVerifier('nonexistent')).toBeNull();
    });
  });
});
