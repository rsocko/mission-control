/**
 * Tests for src/mcp/public-url.ts resolution logic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolvePublicUrl } from '@/mcp/public-url';

const ENV_KEYS = [
  'MC_PUBLIC_URL',
  'NEXTAUTH_URL',
  'NEXT_PUBLIC_BASE_URL',
  'MC_HOSTNAME',
  'MS_REDIRECT_URI',
  'MC_BASE_URL',
];

describe('public-url resolution', () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('uses MC_PUBLIC_URL when set', () => {
    process.env.MC_PUBLIC_URL = 'https://my-mc.example.com';
    expect(resolvePublicUrl()).toBe('https://my-mc.example.com');
  });

  it('strips trailing slashes from explicit URLs', () => {
    process.env.MC_PUBLIC_URL = 'https://my-mc.example.com///';
    expect(resolvePublicUrl()).toBe('https://my-mc.example.com');
  });

  it('falls back to NEXTAUTH_URL', () => {
    process.env.NEXTAUTH_URL = 'https://nextauth.example.com';
    expect(resolvePublicUrl()).toBe('https://nextauth.example.com');
  });

  it('falls back to NEXT_PUBLIC_BASE_URL', () => {
    process.env.NEXT_PUBLIC_BASE_URL = 'https://public-base.example.com';
    expect(resolvePublicUrl()).toBe('https://public-base.example.com');
  });

  it('constructs from MC_HOSTNAME', () => {
    process.env.MC_HOSTNAME = 'mission-control.example';
    expect(resolvePublicUrl()).toBe('https://mission-control.example');
  });

  it('derives origin from MS_REDIRECT_URI', () => {
    process.env.MS_REDIRECT_URI = 'https://mission-control.example/api/auth/microsoft/callback';
    expect(resolvePublicUrl()).toBe('https://mission-control.example');
  });

  it('handles MS_REDIRECT_URI with port', () => {
    process.env.MS_REDIRECT_URI = 'https://mission-control.example:8443/api/auth/microsoft/callback';
    expect(resolvePublicUrl()).toBe('https://mission-control.example:8443');
  });

  it('falls through on malformed MS_REDIRECT_URI', () => {
    process.env.MS_REDIRECT_URI = 'not-a-valid-url';
    process.env.MC_BASE_URL = 'http://localhost:4000';
    expect(resolvePublicUrl()).toBe('http://localhost:4000');
  });

  it('falls back to MC_BASE_URL', () => {
    process.env.MC_BASE_URL = 'http://192.168.1.50:3099';
    expect(resolvePublicUrl()).toBe('http://192.168.1.50:3099');
  });

  it('uses localhost:3099 as final fallback', () => {
    expect(resolvePublicUrl()).toBe('http://localhost:3099');
  });

  it('MC_PUBLIC_URL takes priority over MS_REDIRECT_URI', () => {
    process.env.MC_PUBLIC_URL = 'https://explicit.example.com';
    process.env.MS_REDIRECT_URI = 'https://mission-control.example/api/auth/microsoft/callback';
    expect(resolvePublicUrl()).toBe('https://explicit.example.com');
  });

  it('MC_HOSTNAME takes priority over MS_REDIRECT_URI', () => {
    process.env.MC_HOSTNAME = 'hostname.example.com';
    process.env.MS_REDIRECT_URI = 'https://redirect.example.com/callback';
    expect(resolvePublicUrl()).toBe('https://hostname.example.com');
  });
});
