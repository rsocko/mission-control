import {
  NATIVE_CONTRACT_VERSION,
  type NativeBridgeEvent,
  type NativeBridgeRequest,
  type NativeBridgeResponse,
  parseNativeBridgeEvent,
  parseNativeBridgeResponse,
} from './contract';
import {
  getMCNativeContext,
  type NativeContextWindow,
} from './context';

export const NATIVE_BRIDGE_CAPABILITIES = [
  'badge',
  'externalLinks',
  'haptics',
  'push',
  'shareCaptureStatus',
] as const;

export const NATIVE_BRIDGE_ACTIONS = [
  'bootstrap',
  'requestPushPermission',
  'hapticFeedback',
  'openURL',
  'setBadge',
] as const;

export type NativeBridgeCapability = (typeof NATIVE_BRIDGE_CAPABILITIES)[number];
export type NativeBridgeAction = NativeBridgeRequest['action'];
export type NativeBridgeEventAction = NativeBridgeEvent['action'];
export type NativeBridgeRequestFor<Action extends NativeBridgeAction> =
  Extract<NativeBridgeRequest, { action: Action }>;
export type NativeBridgeEventFor<Action extends NativeBridgeEventAction> =
  Extract<NativeBridgeEvent, { action: Action }>;
export type NativeBridgeResponseFor<Action extends NativeBridgeAction> =
  Extract<NativeBridgeResponse, { action: Action }> | Extract<NativeBridgeResponse, { ok: false }>;

export interface MCNativeBridge {
  readonly contractVersion: typeof NATIVE_CONTRACT_VERSION;
  readonly capabilities: readonly NativeBridgeCapability[];
  readonly supportedActions: readonly NativeBridgeAction[];
  request<Action extends NativeBridgeAction>(
    action: Action,
    payload: NativeBridgeRequestFor<Action>['payload'],
  ): Promise<NativeBridgeResponseFor<Action>>;
  addEventListener<Action extends NativeBridgeEventAction>(
    action: Action,
    listener: (event: NativeBridgeEventFor<Action>) => void,
  ): () => void;
}

export interface NativeBridgeWindow extends NativeContextWindow {
  mcNativeBridge?: unknown;
}

function isStringArraySubset(
  value: unknown,
  allowed: readonly string[],
): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && allowed.includes(item))
    && new Set(value).size === value.length;
}

export function getMCNativeBridge(
  windowObject: NativeBridgeWindow,
  configuredOrigin: string,
): MCNativeBridge | null {
  if (!getMCNativeContext(windowObject, configuredOrigin)) {
    return null;
  }

  const value = windowObject.mcNativeBridge;
  if (
    typeof value !== 'object'
    || value === null
    || Array.isArray(value)
    || !Object.isFrozen(value)
  ) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.contractVersion !== NATIVE_CONTRACT_VERSION
    || !isStringArraySubset(candidate.capabilities, NATIVE_BRIDGE_CAPABILITIES)
    || !isStringArraySubset(candidate.supportedActions, NATIVE_BRIDGE_ACTIONS)
    || typeof candidate.request !== 'function'
    || typeof candidate.addEventListener !== 'function'
  ) {
    return null;
  }

  return value as MCNativeBridge;
}

export async function requestMCNativeBridge<Action extends NativeBridgeAction>(options: {
  action: Action;
  configuredOrigin: string;
  payload: NativeBridgeRequestFor<Action>['payload'];
  windowObject: NativeBridgeWindow;
}): Promise<NativeBridgeResponseFor<Action>> {
  const bridge = getMCNativeBridge(options.windowObject, options.configuredOrigin);
  if (!bridge) {
    throw new Error('Native bridge is unavailable');
  }

  const value = await bridge.request(options.action, options.payload);
  const parsed = parseNativeBridgeResponse(value);
  if (!parsed.success || parsed.data.action !== options.action) {
    throw new Error('Native bridge returned an invalid response');
  }
  return parsed.data as NativeBridgeResponseFor<Action>;
}

export function addMCNativeBridgeEventListener<Action extends NativeBridgeEventAction>(options: {
  action: Action;
  configuredOrigin: string;
  listener: (event: NativeBridgeEventFor<Action>) => void;
  windowObject: NativeBridgeWindow;
}): () => void {
  const bridge = getMCNativeBridge(options.windowObject, options.configuredOrigin);
  if (!bridge) {
    throw new Error('Native bridge is unavailable');
  }

  return bridge.addEventListener(options.action, (value) => {
    const parsed = parseNativeBridgeEvent(value);
    if (parsed.success && parsed.data.action === options.action) {
      options.listener(parsed.data as NativeBridgeEventFor<Action>);
    }
  });
}
