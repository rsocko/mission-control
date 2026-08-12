/**
 * Challenge/bot-wall page detector.
 *
 * Detects Cloudflare, Akamai, PerimeterX, and similar challenge pages
 * so the embed resolver can discard garbage metadata.
 */

const CHALLENGE_TITLES = new Set([
  'just a moment...',
  'attention required! | cloudflare',
  'one moment, please...',
  'access denied',
  'access to this page has been denied',
  'robot check',
  'are you a robot?',
  'pardon our interruption',
  'human verification',
  'verify you are human',
  'vercel security checkpoint',
  'please wait...',
  'checking your browser',
]);

const BODY_MARKERS = [
  'cf_chl_opt',
  'cf-browser-verification',
  'px-captcha',
  'captcha-delivery.com',
  'checking your browser before accessing',
  'enable javascript and cookies to continue',
];

const MAX_HTML_SIZE_FOR_BODY_CHECK = 100 * 1024; // 100KB

export function isLikelyChallengePage(options: { title?: string; html?: string }): boolean {
  const { title, html } = options;

  // Check title against known challenge page titles
  if (title) {
    const normalized = title.toLowerCase().trim();
    if (CHALLENGE_TITLES.has(normalized)) return true;
  }

  // Check HTML body markers only if HTML is small enough to avoid false positives
  if (html && html.length <= MAX_HTML_SIZE_FOR_BODY_CHECK) {
    const lowerHtml = html.toLowerCase();
    for (const marker of BODY_MARKERS) {
      if (lowerHtml.includes(marker)) return true;
    }
  }

  return false;
}
