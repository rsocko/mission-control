/**
 * Mission Control — Save to Triage (Popup Script)
 *
 * Context-aware popup UI:
 * - On importable sites: shows bulk import CTA + page save
 * - On normal pages: shows page capture + quick-link pills
 * - On internal pages: shows quick-link pills only
 */

const $ = (id) => document.getElementById(id);

const SOURCES = [
  { id: 'reddit', name: 'Reddit', icon: 'icons/sources/reddit.svg', url: 'https://www.reddit.com/user/me/saved/', hostMatch: 'reddit.com', importable: true, readyPattern: /\/(?:user|u)\/[^/]+\/saved/i },
  { id: 'instagram', name: 'Instagram', icon: 'icons/sources/instagram.svg', url: 'https://www.instagram.com/', hostMatch: 'instagram.com', importable: true, readyPattern: /instagram\.com\/[^/]+\/saved\/(all-posts|[^/]+\/\d+)/i },
  { id: 'facebook', name: 'Facebook', icon: 'icons/sources/facebook.svg', url: 'https://www.facebook.com/saved', hostMatch: 'facebook.com', importable: true, readyPattern: /facebook\.com\/(saved|save)(\/|$)/i },
  { id: 'youtube', name: 'YouTube', icon: 'icons/sources/youtube.svg', url: 'https://www.youtube.com/feed/library', importable: false },
  { id: 'tiktok', name: 'TikTok', icon: 'icons/sources/tiktok.svg', url: 'https://www.tiktok.com/', hostMatch: 'tiktok.com', importable: true, readyPattern: /tiktok\.com\/@[^/]+/i },
  { id: 'pinterest', name: 'Pinterest', icon: 'icons/sources/pinterest.svg', url: 'https://www.pinterest.com/', hostMatch: 'pinterest.com', importable: true, readyPattern: /pinterest\.com\/[^_][^/]+\/?$/i },
  {
    id: 'twitter',
    name: 'X / Twitter',
    icon: 'icons/sources/twitter.svg',
    url: 'https://x.com/i/bookmarks',
    hostMatch: ['x.com', 'twitter.com'],
    importable: true,
    // X's Bookmarks/Likes API is undocumented and rotates often, so instead of
    // one-click auto-pagination (like Instagram/TikTok), this passively
    // captures tweets as the user scrolls their own timeline. The popup shows
    // a Start/Finish toggle instead of a single "Import" action.
    livePassive: true,
    readyPattern: /\/(i\/bookmarks|[^/]+\/likes)/i,
  },
];

let currentTab = null;

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);

  if (!apiUrl || !captureKey) {
    showSetup(apiUrl, captureKey);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab;

  const isInternal = tab?.url && (
    tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') ||
    tab.url.startsWith('edge://') || tab.url.startsWith('about:')
  );

  let activeHost = '';
  try { activeHost = tab?.url ? new URL(tab.url).hostname : ''; } catch { activeHost = ''; }

  const matchesHost = (source) => {
    const patterns = Array.isArray(source.hostMatch) ? source.hostMatch : [source.hostMatch];
    return patterns.some((p) => activeHost.includes(p));
  };
  const matchedSource = SOURCES.find(s => s.importable && matchesHost(s));

  showMain();
  showOpenMcBtn();
  renderDynamicContent({ tab, isInternal, matchedSource });
}

function showSetup(apiUrl, captureKey) {
  $('setup').classList.add('visible');
  $('main').classList.remove('visible');
  if (apiUrl) $('apiUrl').value = apiUrl;
  if (captureKey) $('captureKey').value = captureKey;
}

function showMain() {
  $('setup').classList.remove('visible');
  $('main').classList.add('visible');
}

async function showOpenMcBtn() {
  const { apiUrl } = await chrome.storage.sync.get(['apiUrl']);
  const btn = $('openMcBtn');
  if (btn) btn.style.display = apiUrl ? '' : 'none';
}

// ─── Smart rendering ─────────────────────────────────────────────────────────

function renderDynamicContent({ tab, isInternal, matchedSource }) {
  const container = $('dynamicContent');
  let html = '';

  // Import banner (if on an importable site)
  if (matchedSource) {
    const importLabel = matchedSource.livePassive ? 'Start Capture' : 'Import Saved Items';
    const desc = matchedSource.livePassive
      ? `Passively captures tweets as you scroll your Bookmarks or Likes tab (no auto-pagination, so nothing changes about how ${matchedSource.name} works).`
      : `Bulk-import your saved items from ${matchedSource.name} into Mission Control's Triage Queue.`;

    // Check if user is on the correct page for this platform's import to work.
    // Each source declares a readyPattern — if the current URL doesn't match,
    // we show a redirect button instead of the (broken) import button.
    let needsRedirect = false;
    let redirectUrl = '';
    if (matchedSource.readyPattern && tab?.url) {
      if (!matchedSource.readyPattern.test(tab.url)) {
        needsRedirect = true;
        redirectUrl = matchedSource.url;  // default redirect target from source config
      }
    }

    // When not on the correct page, show a "Go to Saved & Import" button instead
    // of the import button (which would silently import 0 items).
    const primaryBtnLabel = needsRedirect ? 'Go to Saved & Import' : importLabel;
    const primaryBtnClass = needsRedirect ? 'btn-import btn-redirect-primary' : 'btn-import';

    html += `
      <div class="import-banner" id="importBanner" data-source-id="${matchedSource.id}" data-needs-redirect="${needsRedirect}" data-redirect-url="${redirectUrl}">
        <div class="import-banner-header">
          <img class="import-banner-icon" src="${matchedSource.icon}" alt="${matchedSource.name}" />
          <span class="import-banner-title">Import from ${matchedSource.name}</span>
        </div>
        <div class="import-banner-desc">
          ${needsRedirect
            ? `Navigate to your saved items page to import from ${matchedSource.name}. The import needs to run from that page.`
            : desc}
        </div>
        <button class="${primaryBtnClass}" id="importBtn" type="button">${primaryBtnLabel}</button>
        <div class="import-status" id="importStatus"></div>
      </div>
    `;
  }

  // Page capture card (if capturable page)
  if (tab?.url && !isInternal) {
    if (matchedSource) {
      html += `<div class="divider"><span class="divider-text">or save this page</span></div>`;
    }
    html += `
      <div class="capture-card">
        <div class="page-title" id="pageTitle">${escapeHtml(tab.title || 'Untitled page')}</div>
        <div class="page-url">${escapeHtml(tab.url)}</div>
        <textarea class="note-field" id="noteField" rows="1" placeholder="Add a note (optional)"></textarea>
        <button class="btn btn-primary" id="saveBtn">Save to Triage</button>
      </div>
    `;
  } else if (isInternal) {
    html += `<div class="empty-state">Cannot capture browser internal pages.</div>`;
  }

  // Quick-link pills — show all platforms (full grid or collapsible)
  const otherSources = SOURCES.filter(s => s.importable && s.id !== matchedSource?.id);
  if (otherSources.length) {
    if (!matchedSource) {
      // Full grid when not on any importable site
      html += `
        <div class="quick-links">
          <div class="quick-links-header">Import saved items from</div>
          <div class="quick-links-grid">
            ${otherSources.map(s => `
              <button class="quick-link" data-url="${s.url}" type="button">
                <img class="quick-link-icon" src="${s.icon}" alt="${s.name}" />${s.name}
              </button>
            `).join('')}
          </div>
        </div>
      `;
    } else {
      // Collapsed toggle when already on an importable site
      html += `
        <div class="quick-links collapsed">
          <button class="quick-links-toggle" id="otherSourcesToggle" type="button">
            <span class="toggle-icons">${otherSources.slice(0, 3).map(s => `<img src="${s.icon}" alt="${s.name}" class="toggle-icon-mini" />`).join('')}</span>
            <span class="toggle-label">Import from other sources</span>
            <span class="toggle-arrow">&#x25BC;</span>
          </button>
          <div class="quick-links-grid hidden" id="otherSourcesGrid">
            ${otherSources.map(s => `
              <button class="quick-link" data-url="${s.url}" type="button">
                <img class="quick-link-icon" src="${s.icon}" alt="${s.name}" />${s.name}
              </button>
            `).join('')}
          </div>
        </div>
      `;
    }
  }

  container.innerHTML = html;
  bindEvents(matchedSource);

  // Add "Send All Tabs" trigger button (always shown in main view)
  renderSendTabsTrigger(container);
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

/**
 * Resolve the best redirect URL for a platform's import page.
 * Platforms like Instagram need the username from the current URL to build
 * the saved-page URL; others use the source's default `url`.
 * Falls back to querying the content script if the username isn't in the URL.
 */
async function resolveRedirectUrl(source, currentUrl) {
  if (source.id === 'instagram' && currentUrl) {
    const usernameMatch = currentUrl.match(/instagram\.com\/([A-Za-z0-9._]+)/);
    let username = usernameMatch?.[1];
    const reserved = ['p', 'reel', 'reels', 'explore', 'direct', 'stories', 'accounts'];
    if (username && !reserved.includes(username)) {
      return `https://www.instagram.com/${username}/saved/all-posts/`;
    }
    // Username not in URL — ask the content script for the logged-in username
    if (currentTab?.id) {
      try {
        const resp = await chrome.tabs.sendMessage(currentTab.id, { type: 'mc-get-instagram-username' });
        if (resp?.username) {
          return `https://www.instagram.com/${resp.username}/saved/all-posts/`;
        }
      } catch { /* content script unreachable — fall through */ }
    }
  }
  return source.url;
}

// ─── Event binding ───────────────────────────────────────────────────────────

function bindEvents(matchedSource) {
  // Import button
  if (matchedSource) {
    const importBtn = $('importBtn');
    const banner = $('importBanner');
    const needsRedirect = banner?.dataset.needsRedirect === 'true';

    if (importBtn) {
      importBtn.addEventListener('click', async () => {
        if (needsRedirect) {
          // Navigate to the correct page — import will be available there
          const targetUrl = await resolveRedirectUrl(matchedSource, currentTab?.url);
          chrome.tabs.update(currentTab.id, { url: targetUrl });
          window.close();
        } else if (matchedSource.livePassive && importBtn.dataset.capturing === 'true') {
          finishCapture(matchedSource);
        } else {
          startImport(matchedSource);
        }
      });
    }
  }

  // Save button
  const saveBtn = $('saveBtn');
  if (saveBtn) {
    saveBtn.addEventListener('click', savePage);
  }

  // Enter in note field
  const noteField = $('noteField');
  if (noteField) {
    noteField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        savePage();
      }
    });
  }

  // Other sources toggle
  const toggle = $('otherSourcesToggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const grid = $('otherSourcesGrid');
      grid.classList.toggle('hidden');
      toggle.querySelector('.toggle-arrow').textContent = grid.classList.contains('hidden') ? '\u25BC' : '\u25B2';
    });
  }

  // Quick-link pills
  document.querySelectorAll('.quick-link').forEach(btn => {
    btn.addEventListener('click', () => {
      chrome.tabs.create({ url: btn.dataset.url });
    });
  });
}

// ─── Import ──────────────────────────────────────────────────────────────────

async function startImport(source) {
  const btn = $('importBtn');
  const statusEl = $('importStatus');

  // Prevent double-click
  const existing = await getImportState(source.id);
  if (existing && !existing.done) return;

  btn.disabled = false;
  if (source.livePassive) {
    btn.textContent = 'Finish';
    btn.dataset.capturing = 'true';
  } else {
    btn.disabled = true;
    btn.textContent = 'Importing...';
  }
  statusEl.textContent = 'Starting import...';
  statusEl.className = 'import-status';
  await setImportState(source.id, { imported: 0, skipped: 0, done: false });

  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: 'mc-start-import', platform: source.id });
  } catch {
    statusEl.textContent = 'Could not reach the page. Try reloading it first.';
    statusEl.className = 'import-status error';
    btn.disabled = false;
    btn.textContent = source.livePassive ? 'Start Capture' : 'Import Saved Items';
    delete btn.dataset.capturing;
    await setImportState(source.id, null);
  }
}

async function finishCapture(source) {
  const btn = $('importBtn');
  const statusEl = $('importStatus');

  btn.disabled = true;
  btn.textContent = 'Finishing...';

  try {
    await chrome.tabs.sendMessage(currentTab.id, { type: 'mc-stop-import', platform: source.id });
  } catch {
    statusEl.textContent = 'Could not reach the page to finish. It may still be capturing.';
    statusEl.className = 'import-status error';
    btn.disabled = false;
    btn.textContent = 'Finish';
  }
}

// Live progress from content scripts
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'mc-import-progress') return;

  const state = {
    imported: message.imported ?? 0,
    skipped: message.skipped ?? 0,
    done: !!message.done,
    error: message.error || null,
  };
  setImportState(message.platform, state.done ? null : state);

  const btn = $('importBtn');
  const statusEl = $('importStatus');
  if (!btn || !statusEl) return;

  const isPassive = SOURCES.find((s) => s.id === message.platform)?.livePassive;

  if (message.error) {
    statusEl.textContent = message.error;
    statusEl.className = 'import-status error';
    btn.disabled = false;
    btn.textContent = isPassive ? 'Start Capture' : 'Import Saved Items';
    delete btn.dataset.capturing;
    return;
  }

  const counts = `${message.imported ?? 0} imported, ${message.skipped ?? 0} skipped`;
  if (message.done) {
    statusEl.textContent = `Done - ${counts}`;
    statusEl.className = 'import-status success';
    btn.disabled = false;
    btn.textContent = isPassive ? 'Start Capture' : 'Import Saved Items';
    delete btn.dataset.capturing;
  } else if (isPassive) {
    statusEl.textContent = message.hint ? `${counts} — ${message.hint}` : `Capturing... ${counts}`;
    statusEl.className = 'import-status';
    btn.disabled = false;
    btn.textContent = 'Finish';
    btn.dataset.capturing = 'true';
  } else {
    statusEl.textContent = `Importing... ${counts}`;
  }
});

// ─── Save page ───────────────────────────────────────────────────────────────

async function savePage() {
  if (!currentTab?.url) return;

  const saveBtn = $('saveBtn');
  const statusEl = $('status');
  const noteField = $('noteField');

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  statusEl.style.display = 'none';
  statusEl.className = 'status';

  const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);

  // Request rich metadata from the content script (OG tags, platform-specific data)
  let pageMeta = {};
  try {
    pageMeta = await chrome.tabs.sendMessage(currentTab.id, { type: 'mc-extract-page-metadata' }) || {};
  } catch { /* content script may not be injected yet — proceed with basic data */ }

  // Use the detected platform if available (groups item with the real source)
  const detectedPlatform = pageMeta.detectedPlatform || null;
  const captureMeta = pageMeta.platformMeta && typeof pageMeta.platformMeta === 'object'
    ? pageMeta.platformMeta
    : undefined;

  // Build the thumbnail URL from OG image or twitter:image
  const thumbnailUrl = pageMeta.thumbnailUrl || pageMeta.ogImage || pageMeta.twitterImage || captureMeta?.thumbnailUrl || undefined;

  // Prefer OG title over tab title; use note or OG description as description
  const title = pageMeta.ogTitle || pageMeta.twitterTitle || currentTab.title || undefined;
  const userNote = noteField?.value.trim();
  const description = userNote || pageMeta.ogDescription || pageMeta.twitterDescription || pageMeta.metaDescription || undefined;

  try {
    const response = await fetch(`${apiUrl}/api/triage/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-triage-capture-key': captureKey,
      },
      body: JSON.stringify({
        url: currentTab.url,
        title,
        description,
        thumbnailUrl,
        client: 'browser',
        // Send the real platform if detected, so the server groups correctly.
        // For unknown sites, send 'browser_extension' as before — the server
        // will confirm via its own detection.
        sourcePlatform: detectedPlatform || 'browser_extension',
        // Pass platform-specific metadata so the server can store it
        ...(captureMeta && { platformMeta: captureMeta }),
      }),
    });

    if (response.ok) {
      const data = await response.json();
      statusEl.textContent = `Saved! Relevance score: ${data.item?.aiRelevanceScore ?? '?'}`;
      statusEl.className = 'status success';
      setTimeout(() => window.close(), 1500);
    } else {
      const err = await response.json().catch(() => ({}));
      statusEl.textContent = `Error: ${err.error || response.statusText}`;
      statusEl.className = 'status error';
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save to Triage';
    }
  } catch (err) {
    statusEl.textContent = `Network error: ${err.message || 'Could not reach server'}`;
    statusEl.className = 'status error';
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save to Triage';
  }
}

// ─── Config ──────────────────────────────────────────────────────────────────

function showConfigError(msg) {
  const el = $('configError');
  if (!el) return;
  el.textContent = msg;
  el.style.display = 'block';
}

function hideConfigError() {
  const el = $('configError');
  if (el) el.style.display = 'none';
}

$('saveConfig').addEventListener('click', async () => {
  hideConfigError();
  const apiUrl = $('apiUrl').value.trim().replace(/\/+$/, '');
  const captureKey = $('captureKey').value.trim();

  if (!apiUrl) {
    $('apiUrl').focus();
    showConfigError('Please enter your Mission Control URL.');
    return;
  }
  if (!captureKey) {
    $('captureKey').focus();
    showConfigError('Please enter your Capture Key (MC_TRIAGE_CAPTURE_KEY from your .env file).');
    return;
  }

  await chrome.storage.sync.set({ apiUrl, captureKey });
  init();
});

$('settingsBtn').addEventListener('click', async () => {
  const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);
  showSetup(apiUrl, captureKey);
});

$('openMcBtn').addEventListener('click', async () => {
  const { apiUrl } = await chrome.storage.sync.get(['apiUrl']);
  if (apiUrl) {
    chrome.tabs.create({ url: apiUrl });
    window.close();
  }
});

// ─── Import state persistence ────────────────────────────────────────────────

function importStateKey(platform) { return `importState_${platform}`; }

async function getImportState(platform) {
  const key = importStateKey(platform);
  const data = await chrome.storage.session.get(key);
  return data[key] || null;
}

async function setImportState(platform, state) {
  const key = importStateKey(platform);
  if (state) {
    await chrome.storage.session.set({ [key]: state });
  } else {
    await chrome.storage.session.remove(key);
  }
}

// ─── Send Tabs to Triage ─────────────────────────────────────────────────────

function renderSendTabsTrigger(container) {
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
  trigger.addEventListener('click', openSendTabsView);
  container.appendChild(trigger);
}

function isInternalUrl(url) {
  return !url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') || url.startsWith('about:') || url.startsWith('devtools://');
}

let sendTabsCurrentTabs = [];

async function openSendTabsView() {
  $('main').classList.remove('visible');
  $('sendTabsView').classList.add('visible');

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const validTabs = tabs.filter(t => !isInternalUrl(t.url));

  sendTabsCurrentTabs = validTabs;
  renderTabList(validTabs, activeTab?.id);
  updateTabsCount();
}

function renderTabList(tabs, activeTabId) {
  const list = $('tabsList');
  const countEl = $('tabsCount');

  if (tabs.length === 0) {
    list.innerHTML = '<div style="padding:12px;text-align:center;color:#64748b;font-size:11px;">No capturable tabs open.</div>';
    countEl.textContent = '0 tabs';
    return;
  }

  countEl.textContent = `${tabs.length} tab${tabs.length !== 1 ? 's' : ''}`;

  // Build tab list using DOM APIs to avoid innerHTML injection risks
  list.innerHTML = '';
  for (const tab of tabs) {
    const label = document.createElement('label');
    label.className = 'tab-item';
    label.dataset.tabId = String(tab.id);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tab-checkbox';
    checkbox.dataset.tabId = String(tab.id);
    // Deselect the active tab by default (closing it would dismiss the popup)
    checkbox.checked = tab.id !== activeTabId;

    const favicon = document.createElement('img');
    favicon.className = 'tab-item-favicon';
    favicon.src = tab.favIconUrl || 'icons/icon-16.png';
    favicon.alt = '';
    favicon.addEventListener('error', () => { favicon.src = 'icons/icon-16.png'; });

    const info = document.createElement('div');
    info.className = 'tab-item-info';

    const titleEl = document.createElement('div');
    titleEl.className = 'tab-item-title';
    titleEl.textContent = tab.title || 'Untitled';

    const urlEl = document.createElement('div');
    urlEl.className = 'tab-item-url';
    urlEl.textContent = tab.url;

    info.appendChild(titleEl);
    info.appendChild(urlEl);
    label.appendChild(checkbox);
    label.appendChild(favicon);
    label.appendChild(info);
    list.appendChild(label);
  }
}

// Bind send-tabs events once (uses onclick to avoid listener accumulation)
(function bindSendTabsEventsOnce() {
  $('tabsBackBtn').onclick = () => {
    $('sendTabsView').classList.remove('visible');
    $('main').classList.add('visible');
  };

  const selectAll = $('tabsSelectAll');
  selectAll.onchange = () => {
    document.querySelectorAll('.tab-checkbox').forEach(cb => { cb.checked = selectAll.checked; });
    updateTabsCount();
  };

  $('tabsList').onchange = (e) => {
    if (e.target.classList.contains('tab-checkbox')) {
      updateTabsCount();
      const allBoxes = [...document.querySelectorAll('.tab-checkbox')];
      selectAll.checked = allBoxes.every(cb => cb.checked);
      selectAll.indeterminate = !selectAll.checked && allBoxes.some(cb => cb.checked);
    }
  };

  $('tabsSendBtn').onclick = () => sendTabsToTriage(sendTabsCurrentTabs);
})();

function updateTabsCount() {
  const checked = document.querySelectorAll('.tab-checkbox:checked').length;
  const total = document.querySelectorAll('.tab-checkbox').length;
  $('tabsCount').textContent = `${checked}/${total} selected`;
  const btn = $('tabsSendBtn');
  if (btn) btn.disabled = checked === 0;
}

async function sendTabsToTriage(allTabs) {
  const sendBtn = $('tabsSendBtn');
  const statusEl = $('tabsStatus');
  const closeTabs = $('tabsCloseThem').checked;
  const batchNote = $('tabsBatchNote').value.trim();

  // Get selected tab IDs
  const selectedIds = [...document.querySelectorAll('.tab-checkbox:checked')]
    .map(cb => parseInt(cb.dataset.tabId, 10));

  if (selectedIds.length === 0) return;

  const selectedTabs = allTabs.filter(t => selectedIds.includes(t.id));

  sendBtn.disabled = true;
  sendBtn.textContent = 'Sending...';
  statusEl.style.display = 'none';
  statusEl.className = 'tabs-status';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'mc-send-tabs-batch',
      tabs: selectedTabs.map(t => ({ id: t.id, url: t.url, title: t.title, favIconUrl: t.favIconUrl })),
      batchNote,
      closeTabs,
    });

    if (response?.error) {
      statusEl.textContent = response.error;
      statusEl.className = 'tabs-status error';
      statusEl.style.display = 'block';
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send to Triage';
      return;
    }

    const imported = response?.imported ?? 0;
    const skipped = response?.skipped ?? 0;
    const closed = response?.closed ?? 0;
    const hasErrors = (response?.errors?.length ?? 0) > 0;

    let msg = `Done! ${imported} saved`;
    if (skipped) msg += `, ${skipped} skipped`;
    if (closeTabs && closed > 0) msg += `, ${closed} tabs closed`;
    if (hasErrors) msg += ` (some items had errors)`;

    statusEl.textContent = msg;
    statusEl.className = hasErrors ? 'tabs-status error' : 'tabs-status success';
    statusEl.style.display = 'block';
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send to Triage';

    // If we closed tabs, close the popup after a brief moment
    if (closeTabs && closed > 0) {
      setTimeout(() => window.close(), 2000);
    }
  } catch (err) {
    statusEl.textContent = `Error: ${err.message || 'Failed to send tabs'}`;
    statusEl.className = 'tabs-status error';
    statusEl.style.display = 'block';
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send to Triage';
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

init();
