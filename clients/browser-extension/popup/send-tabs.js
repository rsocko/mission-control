(function (root) {
  function createSendTabsController({ byId, closeTransientUi }) {
    let currentTabs = [];

    function renderTrigger(container) {
      const trigger = document.createElement('button');
      trigger.className = 'send-tabs-trigger';
      trigger.type = 'button';
      trigger.id = 'sendTabsTrigger';
      trigger.innerHTML = `
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
          <line x1="8" y1="21" x2="16" y2="21"/>
          <line x1="12" y1="17" x2="12" y2="21"/>
        </svg>
        Send Tabs to Triage
      `;
      trigger.addEventListener('click', openView);
      container.appendChild(trigger);
    }

    async function openView() {
      byId('main').classList.remove('visible');
      byId('sendTabsView').classList.add('visible');

      const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      currentTabs = (await chrome.tabs.query({ currentWindow: true }))
        .filter((tab) => !MCCapture.isInternalUrl(tab.url));
      renderTabList(currentTabs, activeTab?.id);
      updateCount();
    }

    function renderTabList(tabs, activeTabId) {
      const list = byId('tabsList');
      const countEl = byId('tabsCount');
      if (!tabs.length) {
        list.innerHTML = '<div style="padding:12px;text-align:center;color:#64748b;font-size:11px;">No capturable tabs open.</div>';
        countEl.textContent = '0 tabs';
        return;
      }

      list.innerHTML = '';
      for (const tab of tabs) {
        const label = document.createElement('label');
        label.className = 'tab-item';
        label.dataset.tabId = String(tab.id);

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.className = 'tab-checkbox';
        checkbox.dataset.tabId = String(tab.id);
        checkbox.checked = tab.id !== activeTabId;

        const favicon = document.createElement('img');
        favicon.className = 'tab-item-favicon';
        favicon.src = tab.favIconUrl || 'icons/icon-16.png';
        favicon.alt = '';
        favicon.addEventListener('error', () => { favicon.src = 'icons/icon-16.png'; });

        const info = document.createElement('div');
        info.className = 'tab-item-info';
        const title = document.createElement('div');
        title.className = 'tab-item-title';
        title.textContent = tab.title || 'Untitled';
        const url = document.createElement('div');
        url.className = 'tab-item-url';
        url.textContent = tab.url;

        info.append(title, url);
        label.append(checkbox, favicon, info);
        list.appendChild(label);
      }
    }

    function updateCount() {
      const checked = document.querySelectorAll('.tab-checkbox:checked').length;
      const total = document.querySelectorAll('.tab-checkbox').length;
      byId('tabsCount').textContent = `${checked}/${total} selected`;
      byId('tabsSendBtn').disabled = checked === 0;
    }

    async function sendSelected() {
      const sendBtn = byId('tabsSendBtn');
      const statusEl = byId('tabsStatus');
      const closeTabs = byId('tabsCloseThem').checked;
      const selectedIds = [...document.querySelectorAll('.tab-checkbox:checked')]
        .map((checkbox) => Number.parseInt(checkbox.dataset.tabId, 10));
      if (!selectedIds.length) return;

      sendBtn.disabled = true;
      sendBtn.textContent = 'Sending...';
      statusEl.style.display = 'none';
      statusEl.className = 'tabs-status';

      try {
        const response = await chrome.runtime.sendMessage({
          type: 'mc-send-tabs-batch',
          tabs: currentTabs
            .filter((tab) => selectedIds.includes(tab.id))
            .map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, favIconUrl: tab.favIconUrl })),
          batchNote: byId('tabsBatchNote').value.trim(),
          closeTabs,
        });
        if (response?.error) throw new Error(response.error);

        const imported = response?.imported ?? 0;
        const skipped = response?.skipped ?? 0;
        const closed = response?.closed ?? 0;
        const hasErrors = (response?.errors?.length ?? 0) > 0;
        let message = `Done! ${imported} saved`;
        if (skipped) message += `, ${skipped} skipped`;
        if (closeTabs && closed) message += `, ${closed} tabs closed`;
        if (hasErrors) message += ' (some items had errors)';
        statusEl.textContent = message;
        statusEl.className = hasErrors ? 'tabs-status error' : 'tabs-status success';
        if (closeTabs && closed) setTimeout(closeTransientUi, 2000);
      } catch (error) {
        statusEl.textContent = `Error: ${error.message || 'Failed to send tabs'}`;
        statusEl.className = 'tabs-status error';
      } finally {
        statusEl.style.display = 'block';
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send to Triage';
      }
    }

    byId('tabsBackBtn').onclick = () => {
      byId('sendTabsView').classList.remove('visible');
      byId('main').classList.add('visible');
    };
    const selectAll = byId('tabsSelectAll');
    selectAll.onchange = () => {
      document.querySelectorAll('.tab-checkbox').forEach((checkbox) => { checkbox.checked = selectAll.checked; });
      updateCount();
    };
    byId('tabsList').onchange = (event) => {
      if (!event.target.classList.contains('tab-checkbox')) return;
      updateCount();
      const checkboxes = [...document.querySelectorAll('.tab-checkbox')];
      selectAll.checked = checkboxes.every((checkbox) => checkbox.checked);
      selectAll.indeterminate = !selectAll.checked && checkboxes.some((checkbox) => checkbox.checked);
    };
    byId('tabsSendBtn').onclick = sendSelected;

    return { renderTrigger };
  }

  root.MCPopupSendTabs = { createSendTabsController };
})(globalThis);
