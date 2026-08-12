import { afterEach, describe, expect, it } from 'vitest';
import { publicRuntimeRelease, resolveRuntimeRelease } from '@/lib/runtime/release';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

describe('runtime release', () => {
  it('prefers the explicit deployment revision', () => {
    process.env.MC_DEPLOYMENT_REVISION = 'sha-fff0872';
    process.env.MC_BUILD_SHA = 'fff0872b93abc64b';
    expect(resolveRuntimeRelease()).toBe('sha-fff0872');
  });

  it('does not expose unsafe environment content', () => {
    expect(publicRuntimeRelease('sha-good_1.2')).toBe('sha-good_1.2');
    expect(publicRuntimeRelease('contains whitespace and private text')).toBe('invalid');
    expect(publicRuntimeRelease('x'.repeat(65))).toBe('invalid');
    expect(publicRuntimeRelease(null)).toBe('unreported');
  });
});
