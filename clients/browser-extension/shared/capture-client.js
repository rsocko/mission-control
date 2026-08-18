(function (root) {
  const INTERNAL_PROTOCOLS = new Set([
    'about:',
    'chrome:',
    'chrome-extension:',
    'devtools:',
    'edge:',
  ]);

  function isInternalUrl(url) {
    if (!url) return true;
    try {
      const parsed = new URL(url);
      return INTERNAL_PROTOCOLS.has(parsed.protocol) || !['http:', 'https:'].includes(parsed.protocol);
    } catch {
      return true;
    }
  }

  function buildCapturePayload({ url, title, description, pageMeta = {} }) {
    const platformMeta = pageMeta.platformMeta && typeof pageMeta.platformMeta === 'object'
      ? pageMeta.platformMeta
      : undefined;

    return {
      url,
      title: pageMeta.ogTitle || pageMeta.twitterTitle || title || undefined,
      description: description || pageMeta.ogDescription || pageMeta.twitterDescription ||
        pageMeta.metaDescription || undefined,
      thumbnailUrl: pageMeta.thumbnailUrl || pageMeta.ogImage || pageMeta.twitterImage ||
        platformMeta?.thumbnailUrl || undefined,
      client: 'browser',
      sourcePlatform: pageMeta.detectedPlatform || 'browser_extension',
      ...(platformMeta && { platformMeta }),
    };
  }

  async function getPageMetadata(tabId) {
    if (tabId == null) return {};
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'mc-extract-page-metadata' }) || {};
    } catch {
      return {};
    }
  }

  async function capture({ url, title, description, tabId }) {
    if (isInternalUrl(url)) {
      const error = new Error('Cannot capture browser internal pages.');
      error.code = 'INTERNAL_URL';
      throw error;
    }

    const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);
    if (!apiUrl || !captureKey) {
      const error = new Error('Mission Control is not configured.');
      error.code = 'NOT_CONFIGURED';
      throw error;
    }

    const pageMeta = await getPageMetadata(tabId);
    const payload = buildCapturePayload({ url, title, description, pageMeta });
    const response = await fetch(`${apiUrl}/api/triage/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-triage-capture-key': captureKey,
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(data.error || response.statusText || `Capture failed: ${response.status}`);
      error.code = 'CAPTURE_FAILED';
      error.response = response;
      throw error;
    }

    return { data, payload, response };
  }

  root.MCCapture = { buildCapturePayload, capture, getPageMetadata, isInternalUrl };
})(globalThis);
