import { describe, expect, it } from 'vitest';
import {
  getMCNativeContext,
  isMCNativeApp,
  type NativeContextWindow,
} from '@/lib/native/context';

function nativeWindow(documentUrl: string): NativeContextWindow {
  return {
    location: { href: documentUrl },
    isMCNativeApp: true,
    MCNativeContext: {
      platform: 'ios',
      contractVersion: 1,
    },
  };
}

describe('iOS native context', () => {
  const trustedOrigin = 'https://mc.example.com';

  it('accepts the declared context only on the exact trusted origin', () => {
    const context = getMCNativeContext(
      nativeWindow('https://mc.example.com/today?source=ios'),
      trustedOrigin,
    );

    expect(context).toEqual({
      platform: 'ios',
      contractVersion: 1,
    });
    expect(isMCNativeApp(
      nativeWindow('https://mc.example.com/projects/roadmap'),
      trustedOrigin,
    )).toBe(true);
  });

  it.each([
    'https://mc.example.com.evil.test/today',
    'https://sub.mc.example.com/today',
    'https://mc.example.com:444/today',
    'http://mc.example.com/today',
  ])('rejects injected-looking state outside the trusted origin: %s', (documentUrl) => {
    expect(getMCNativeContext(nativeWindow(documentUrl), trustedOrigin)).toBeNull();
  });

  it('rejects missing, malformed, version-mismatched, and extended contexts', () => {
    const candidates: NativeContextWindow[] = [
      {
        ...nativeWindow('https://mc.example.com/today'),
        isMCNativeApp: false,
      },
      {
        ...nativeWindow('https://mc.example.com/today'),
        MCNativeContext: { platform: 'android', contractVersion: 1 },
      },
      {
        ...nativeWindow('https://mc.example.com/today'),
        MCNativeContext: { platform: 'ios', contractVersion: 2 },
      },
      {
        ...nativeWindow('https://mc.example.com/today'),
        MCNativeContext: {
          platform: 'ios',
          contractVersion: 1,
          authorization: 'admin',
        },
      },
    ];

    for (const candidate of candidates) {
      expect(getMCNativeContext(candidate, trustedOrigin)).toBeNull();
    }
  });

  it('does not inspect or rely on User-Agent', () => {
    const browserLikeWindow = nativeWindow('https://mc.example.com/today') as NativeContextWindow & {
      navigator: { userAgent: string };
    };
    browserLikeWindow.navigator = { userAgent: 'Plain Browser' };

    expect(isMCNativeApp(browserLikeWindow, trustedOrigin)).toBe(true);
  });
});
