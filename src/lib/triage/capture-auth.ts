import { safeEqual } from '@/lib/api/trusted-request';

/**
 * Shared auth check for endpoints invoked by the browser extension
 * (single-page capture + bulk import). Both accept the same
 * `x-capture-key` / `x-triage-capture-key` header or `Authorization: Bearer` token.
 */
export function hasValidTriageCaptureKey(request: Request): boolean {
  const expected = process.env.MC_TRIAGE_CAPTURE_KEY;
  if (!expected) return true;

  const keyHeader = request.headers.get('x-triage-capture-key')
    ?? request.headers.get('x-capture-key');
  if (keyHeader && safeEqual(keyHeader, expected)) return true;

  const authHeader = request.headers.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return safeEqual(authHeader.slice('Bearer '.length).trim(), expected);
  }

  return false;
}
