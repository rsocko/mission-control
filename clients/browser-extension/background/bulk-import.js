(function () {
  const CONFIG_ERROR = 'Mission Control is not configured — open the extension popup and save your settings first.';

  async function postBulkItems(items, options = {}) {
    const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);
    if (!apiUrl || !captureKey) throw new Error(CONFIG_ERROR);

    const response = await fetch(`${apiUrl}/api/triage/import/bulk`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-triage-capture-key': captureKey,
      },
      body: JSON.stringify({ items, ...options }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Bulk import failed: ${response.status}`);
    return {
      imported: data.imported ?? 0,
      skipped: data.skipped ?? 0,
      errors: Array.isArray(data.errors) ? data.errors : [],
    };
  }

  async function sendTabs(message) {
    const tabs = Array.isArray(message.tabs)
      ? message.tabs.filter((tab) => !MCCapture.isInternalUrl(tab?.url))
      : [];
    if (!tabs.length) throw new Error('No tabs to send.');

    const batchId = crypto.randomUUID();
    const batchLabel = message.batchNote || `Tabs ${new Date().toLocaleString()}`;
    const capturedAt = new Date().toISOString();
    const items = tabs.map((tab) => ({
      sourcePlatform: 'browser_tabs',
      sourceId: `tab-${batchId}-${tab.id}`,
      sourceUrl: tab.url,
      title: tab.title || tab.url,
      capturedAt,
      rawMetadata: {
        batchId,
        batchLabel,
        favIconUrl: tab.favIconUrl || null,
        originalTabId: tab.id,
      },
    }));

    let imported = 0;
    let skipped = 0;
    const errors = [];
    for (let index = 0; index < items.length; index += 100) {
      const result = await postBulkItems(items.slice(index, index + 100));
      imported += result.imported;
      skipped += result.skipped;
      errors.push(...result.errors);
    }

    let closed = 0;
    if (message.closeTabs && errors.length === 0) {
      const results = await Promise.allSettled(tabs.map((tab) => chrome.tabs.remove(tab.id)));
      closed = results.filter((result) => result.status === 'fulfilled').length;
    }

    return { imported, skipped, errors, closed, batchId };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'mc-send-tabs-batch') {
      sendTabs(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error.message || 'Network error reaching Mission Control' }));
      return true;
    }

    if (message?.type === 'mc-bulk-import-batch') {
      postBulkItems(message.items, { refreshThumbnails: true })
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error.message || 'Network error reaching Mission Control' }));
      return true;
    }

    return undefined;
  });
})();
