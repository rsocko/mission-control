(function (root) {
  function createCaptureController({ byId, getCurrentTab, closeTransientUi }) {
    async function savePage() {
      const tab = getCurrentTab();
      if (MCCapture.isInternalUrl(tab?.url)) return;

      const saveBtn = byId('saveBtn');
      const statusEl = byId('status');
      const noteField = byId('noteField');

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      statusEl.style.display = 'none';
      statusEl.className = 'status';

      try {
        const { data } = await MCCapture.capture({
          url: tab.url,
          title: tab.title,
          description: noteField?.value.trim() || undefined,
          tabId: tab.id,
        });
        statusEl.textContent = `Saved! Relevance score: ${data.item?.aiRelevanceScore ?? '?'}`;
        statusEl.className = 'status success';
        setTimeout(closeTransientUi, 1500);
      } catch (error) {
        statusEl.textContent = error.code === 'CAPTURE_FAILED'
          ? `Error: ${error.message}`
          : `Network error: ${error.message || 'Could not reach server'}`;
        statusEl.className = 'status error';
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save to Triage';
      }
    }

    return { savePage };
  }

  root.MCPopupCapture = { createCaptureController };
})(globalThis);
