export function prepareExternalNavigation(opensExternal: boolean): Window | null {
  if (!opensExternal) return null;
  const popup = window.open('about:blank', '_blank');
  if (popup) popup.opener = null;
  return popup;
}

export function completeExternalNavigation(
  popup: Window | null,
  url: string,
  navigateCurrentWindow: (target: string) => void = target => window.location.assign(target),
): void {
  if (popup && !popup.closed) {
    popup.location.replace(url);
    return;
  }
  navigateCurrentWindow(url);
}

export function cancelExternalNavigation(popup: Window | null): void {
  if (popup && !popup.closed) popup.close();
}
