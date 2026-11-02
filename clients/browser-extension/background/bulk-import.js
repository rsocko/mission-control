(function () {
  const CONFIG_ERROR = 'Mission Control is not configured — open the extension popup and save your settings first.';

  async function postBulkItems(items, options = {}, expectedApiUrl) {
    const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);
    if (!apiUrl || !captureKey) throw new Error(CONFIG_ERROR);
    if (expectedApiUrl != null && apiUrl !== expectedApiUrl) {
      throw new Error('Mission Control settings changed during this import. Reload the source tab and start again.');
    }

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
      // Refreshed items already exist; count them as acknowledged duplicates.
      skipped: (data.skipped ?? 0) + (data.refreshed ?? 0),
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

  async function importBatch(message, sender) {
    const key = `importState_${message.platform}`;
    const data = await chrome.storage.session.get(key);
    const state = data[key];
    if (!state || state.done || state.tabId !== sender.tab?.id || state.runId !== message.runId) {
      throw new Error('This import is no longer active. Start a new import from the extension.');
    }
    return postBulkItems(message.items, { refreshThumbnails: true }, state.apiUrl);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === 'mc-send-tabs-batch') {
      sendTabs(message)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error.message || 'Network error reaching Mission Control' }));
      return true;
    }

    if (message?.type === 'mc-bulk-import-batch') {
      importBatch(message, sender)
        .then(sendResponse)
        .catch((error) => sendResponse({ error: error.message || 'Network error reaching Mission Control' }));
      return true;
    }

    return undefined;
  });
})();
