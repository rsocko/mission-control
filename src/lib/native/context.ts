import {
  isTrustedNativeBridgeDocument,
  NATIVE_CONTRACT_VERSION,
} from './contract';

export interface MCNativeContext {
  platform: 'ios';
  contractVersion: typeof NATIVE_CONTRACT_VERSION;
}

export interface NativeContextWindow {
  location: {
    href: string;
  };
  isMCNativeApp?: unknown;
  MCNativeContext?: unknown;
}

function parseNativeContext(value: unknown): MCNativeContext | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'contractVersion' || keys[1] !== 'platform') {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.platform !== 'ios'
    || candidate.contractVersion !== NATIVE_CONTRACT_VERSION
  ) {
    return null;
  }

  return {
    platform: candidate.platform,
    contractVersion: candidate.contractVersion,
  };
}

/**
 * Reads the non-secret UI capability hint injected by the iOS host.
 * Authentication and authorization must never depend on this value.
 */
export function getMCNativeContext(
  windowObject: NativeContextWindow,
  configuredOrigin: string,
): MCNativeContext | null {
  if (
    windowObject.isMCNativeApp !== true
    || !isTrustedNativeBridgeDocument(windowObject.location.href, configuredOrigin)
  ) {
    return null;
  }

  return parseNativeContext(windowObject.MCNativeContext);
}

export function isMCNativeApp(
  windowObject: NativeContextWindow,
  configuredOrigin: string,
): boolean {
  return getMCNativeContext(windowObject, configuredOrigin) !== null;
}
