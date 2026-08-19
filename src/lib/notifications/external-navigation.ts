import {
  getMCNativeBridge,
  requestMCNativeBridge,
  type NativeBridgeWindow,
} from '@/lib/native/bridge';

function getNativeExternalLinksBridge(): NativeBridgeWindow | null {
  const windowObject = window as unknown as NativeBridgeWindow;
  const bridge = getMCNativeBridge(windowObject, window.location.origin);
  if (
    !bridge?.capabilities.includes('externalLinks')
    || !bridge.supportedActions.includes('openURL')
  ) {
    return null;
  }
  return windowObject;
}

export function prepareExternalNavigation(opensExternal: boolean): Window | null {
  if (!opensExternal) return null;
  if (getNativeExternalLinksBridge()) return null;
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  return popup;
}

export async function completeExternalNavigation(
  popup: Window | null,
  url: string,
  navigateCurrentWindow: (target: string) => void = target => window.location.assign(target),
): Promise<void> {
  const nativeWindow = getNativeExternalLinksBridge();
  if (nativeWindow) {
    const response = await requestMCNativeBridge({
      action: 'openURL',
      configuredOrigin: window.location.origin,
      payload: { url },
      windowObject: nativeWindow,
    });
    if (!response.ok || !response.result.opened) {
      throw new Error(response.ok ? 'Native host did not open the URL' : response.error.message);
    }
    return;
  }

  if (popup && !popup.closed) {
    popup.location.replace(url);
    return;
  }
  navigateCurrentWindow(url);
}

export function cancelExternalNavigation(popup: Window | null): void {
  if (popup && !popup.closed) popup.close();
}
