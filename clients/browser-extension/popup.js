/**
 * Mission Control — Save to Triage (Popup Script)
 *
 * Context-aware popup UI:
 * - On importable sites: shows bulk import CTA + page save
 * - On normal pages: shows page capture + quick-link pills
 * - On internal pages: shows quick-link pills only
 */

const $ = MCPopupDom.byId;
const escapeHtml = MCPopupDom.escapeHtml;
const isSidePanel = new URLSearchParams(window.location.search).get('surface') === 'sidepanel';

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
let initRequestId = 0;
let panelWindowId = null;

function closeTransientUi() {
  if (!isSidePanel) window.close();
}

const captureController = MCPopupCapture.createCaptureController({
  byId: $,
  getCurrentTab: () => currentTab,
  closeTransientUi,
});
const sendTabsController = MCPopupSendTabs.createSendTabsController({
  byId: $,
  closeTransientUi,
});

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const requestId = ++initRequestId;
  const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);

  if (requestId !== initRequestId) return;
  if (!apiUrl || !captureKey) {
    showSetup(apiUrl, captureKey);
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (requestId !== initRequestId) return;
  currentTab = tab;
  if (isSidePanel && panelWindowId == null) panelWindowId = tab?.windowId ?? null;

  const isInternal = MCCapture.isInternalUrl(tab?.url);

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
  sendTabsController.renderTrigger(container);
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
          await chrome.tabs.update(currentTab.id, { url: targetUrl });
          closeTransientUi();
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
    saveBtn.addEventListener('click', captureController.savePage);
  }

  // Enter in note field
  const noteField = $('noteField');
  if (noteField) {
    noteField.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        captureController.savePage();
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

  const terminalErrors = Array.isArray(message.errors)
    ? message.errors.filter((error) => typeof error === 'string' && error.trim())
    : [];
  const state = {
    imported: message.imported ?? 0,
    skipped: message.skipped ?? 0,
    done: !!message.done,
    error: message.error || terminalErrors[0] || null,
  };
  setImportState(message.platform, state.done ? null : state);

  const btn = $('importBtn');
  const statusEl = $('importStatus');
  if (!btn || !statusEl) return;

  const isPassive = SOURCES.find((s) => s.id === message.platform)?.livePassive;
  const counts = `${message.imported ?? 0} imported, ${message.skipped ?? 0} skipped`;

  if (message.error) {
    statusEl.textContent = message.error;
    statusEl.className = 'import-status error';
    btn.disabled = false;
    btn.textContent = isPassive ? 'Start Capture' : 'Import Saved Items';
    delete btn.dataset.capturing;
    return;
  }

  if (message.done && terminalErrors.length) {
    const remaining = terminalErrors.length > 1 ? ` (+${terminalErrors.length - 1} more)` : '';
    statusEl.textContent = `Finished with errors - ${counts}. ${terminalErrors[0]}${remaining}`;
    statusEl.className = 'import-status error';
    btn.disabled = false;
    btn.textContent = isPassive ? 'Start Capture' : 'Import Saved Items';
    delete btn.dataset.capturing;
    return;
  }

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

$('openSidePanelBtn').addEventListener('click', async () => {
  const statusEl = $('status');
  try {
    const tab = currentTab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (!Number.isInteger(tab?.windowId)) throw new Error('No active browser window');
    await chrome.sidePanel.open({ windowId: tab.windowId });
    closeTransientUi();
  } catch (err) {
    statusEl.textContent = `Could not open side panel: ${err.message || 'Unsupported browser'}`;
    statusEl.className = 'status error';
  }
});

$('openMcBtn').addEventListener('click', async () => {
  const { apiUrl } = await chrome.storage.sync.get(['apiUrl']);
  if (apiUrl) {
    chrome.tabs.create({ url: apiUrl });
    closeTransientUi();
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

// ─── Start ───────────────────────────────────────────────────────────────────

if (isSidePanel) {
  $('openSidePanelBtn').style.display = 'none';
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (panelWindowId == null || windowId === panelWindowId) init();
  });
  chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (
      tab.active &&
      (panelWindowId == null || tab.windowId === panelWindowId) &&
      (changeInfo.url || changeInfo.status === 'complete')
    ) {
      init();
    }
  });
} else if (!chrome.sidePanel?.open) {
  $('openSidePanelBtn').style.display = 'none';
}

init();
