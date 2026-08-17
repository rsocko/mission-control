export const MODAL_DIALOG_SELECTOR = [
  '[role="dialog"][aria-modal="true"]',
  '[role="alertdialog"]',
].join(', ');

export function isModalDialogOpen(root: ParentNode = document): boolean {
  return root.querySelector(MODAL_DIALOG_SELECTOR) !== null;
}

export function shouldBlockGlobalShortcut(event: KeyboardEvent): boolean {
  return event.defaultPrevented || isModalDialogOpen();
}
