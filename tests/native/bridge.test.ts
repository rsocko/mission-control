import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  NATIVE_BRIDGE_ACTIONS,
  NATIVE_BRIDGE_CAPABILITIES,
  addMCNativeBridgeEventListener,
  getMCNativeBridge,
  requestMCNativeBridge,
  type MCNativeBridge,
  type NativeBridgeWindow,
} from '@/lib/native/bridge';
import {
  parseNativeBridgeEvent,
  parseNativeBridgeRequest,
  parseNativeBridgeResponse,
} from '@/lib/native/contract';

const trustedOrigin = 'https://mc.example.com';
const requestId = '8cf177a0-e46a-46fa-824c-4c34004e2423';

function bridgeWindow(bridge: MCNativeBridge): NativeBridgeWindow {
  return {
    location: { href: `${trustedOrigin}/today` },
    isMCNativeApp: true,
    MCNativeContext: Object.freeze({ platform: 'ios', contractVersion: 1 }),
    mcNativeBridge: bridge,
  };
}

function fakeBridge(overrides: Partial<MCNativeBridge> = {}): MCNativeBridge {
  return Object.freeze({
    contractVersion: 1,
    capabilities: Object.freeze([...NATIVE_BRIDGE_CAPABILITIES]),
    supportedActions: Object.freeze([...NATIVE_BRIDGE_ACTIONS]),
    request: vi.fn(async (action: string) => ({
      version: 1,
      requestId,
      action,
      ok: true,
      result: { count: 4 },
    })),
    addEventListener: vi.fn(() => () => undefined),
    ...overrides,
  }) as MCNativeBridge;
}

describe('iOS native bridge client', () => {
  it('uses the shared fixtures in both runtime schemas', () => {
    const fixturePath = resolve(
      process.cwd(),
      'contracts/fixtures/mobile-ios-native-v1.json',
    );
    const fixtures = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      requests: unknown[];
      responses: unknown[];
      events: unknown[];
    };

    expect(fixtures.requests).toHaveLength(5);
    fixtures.requests.forEach((request) => {
      expect(parseNativeBridgeRequest(request).success).toBe(true);
    });
    fixtures.responses.forEach((response) => {
      expect(parseNativeBridgeResponse(response).success).toBe(true);
    });
    fixtures.events.forEach((event) => {
      expect(parseNativeBridgeEvent(event).success).toBe(true);
    });
  });

  it('detects only a frozen v1 bridge on the exact trusted origin', () => {
    const bridge = fakeBridge();
    expect(getMCNativeBridge(bridgeWindow(bridge), trustedOrigin)).toBe(bridge);
    expect(getMCNativeBridge({
      ...bridgeWindow(bridge),
      location: { href: 'https://evil.example/today' },
    }, trustedOrigin)).toBeNull();
    expect(getMCNativeBridge(bridgeWindow({
      ...bridge,
      contractVersion: 2,
    } as unknown as MCNativeBridge), trustedOrigin)).toBeNull();
    expect(getMCNativeBridge(bridgeWindow({
      ...bridge,
      capabilities: ['push', 'push'],
    } as unknown as MCNativeBridge), trustedOrigin)).toBeNull();
    expect(getMCNativeBridge(bridgeWindow({ ...bridge }), trustedOrigin)).toBeNull();
  });

  it('validates action-correlated structured responses', async () => {
    const bridge = fakeBridge({
      request: vi.fn(async () => ({
        version: 1,
        requestId,
        action: 'setBadge',
        ok: true,
        result: { count: 4 },
      })),
    });

    await expect(requestMCNativeBridge({
      action: 'setBadge',
      configuredOrigin: trustedOrigin,
      payload: { count: 4 },
      windowObject: bridgeWindow(bridge),
    })).resolves.toMatchObject({ ok: true, result: { count: 4 } });

    const mismatched = fakeBridge({
      request: vi.fn(async () => ({
        version: 1,
        requestId,
        action: 'openURL',
        ok: true,
        result: { opened: true },
      })),
    });
    await expect(requestMCNativeBridge({
      action: 'setBadge',
      configuredOrigin: trustedOrigin,
      payload: { count: 4 },
      windowObject: bridgeWindow(mismatched),
    })).rejects.toThrow('invalid response');
  });

  it('drops malformed and action-mismatched native events', () => {
    let nativeListener: ((event: never) => void) | undefined;
    const listener = vi.fn();
    const bridge = fakeBridge({
      addEventListener: vi.fn((_action, callback) => {
        nativeListener = callback as (event: never) => void;
        return () => undefined;
      }),
    });

    addMCNativeBridgeEventListener({
      action: 'networkStatus',
      configuredOrigin: trustedOrigin,
      listener,
      windowObject: bridgeWindow(bridge),
    });

    nativeListener?.({
      version: 1,
      requestId,
      action: 'networkStatus',
      payload: { status: 'online' },
    } as never);
    nativeListener?.({
      version: 1,
      requestId,
      action: 'authenticationChanged',
      payload: { state: 'authenticated' },
    } as never);
    nativeListener?.({ deviceToken: 'secret' } as never);

    expect(listener).toHaveBeenCalledTimes(1);
  });
});
