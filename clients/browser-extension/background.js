/**
 * Mission Control — Save to Triage (Background Service Worker)
 *
 * Handles the Ctrl+Shift+S keyboard shortcut by capturing the active tab
 * and sending it to the Mission Control capture API.
 *
 * Uses chrome.alarms instead of setTimeout for badge clearing because
 * MV3 service workers can be terminated between events — timers are
 * not guaranteed to fire.
 */

const BADGE_ALARM = 'clear-badge';

// ─── Badge helpers ───────────────────────────────────────────────────────────

function showBadge(tabId, text, color) {
  chrome.action.setBadgeText({ text, tabId });
  chrome.action.setBadgeBackgroundColor({ color, tabId });
  // Store tabId so the alarm handler knows which tab to clear
  chrome.storage.session.set({ badgeTabId: tabId });
  // chrome.alarms minimum is 0.5 minutes in production, but in dev
  // mode (unpacked extension) shorter periods work. We use delayInMinutes
  // for reliability; 0.05 min ≈ 3 seconds.
  chrome.alarms.create(BADGE_ALARM, { delayInMinutes: 0.05 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== BADGE_ALARM) return;
  const { badgeTabId } = await chrome.storage.session.get('badgeTabId');
  chrome.action.setBadgeText({ text: '', tabId: badgeTabId });
  chrome.storage.session.remove('badgeTabId');
});


// ─── Shared capture logic ────────────────────────────────────────────────────

function isInternalUrl(url) {
  return !url || url.startsWith('chrome://') || url.startsWith('chrome-extension://') ||
    url.startsWith('edge://') || url.startsWith('about:');
}

/**
 * Sends a URL/title/description to the Mission Control triage capture API.
 * Used by the keyboard shortcut and the context menu -- the popup has its
 * own inline copy so it can show live status/errors to the user.
 *
 * When a tabId is provided, requests rich metadata from the content script
 * (OG tags, platform detection) to send a more complete capture.
 */
async function captureToTriage({ url, title, description, tabId }) {
  const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);
  if (!apiUrl || !captureKey) {
    chrome.action.openPopup();
    return;
  }

  // Request rich metadata from the content script if possible
  let pageMeta = {};
  if (tabId != null) {
    try {
      pageMeta = await chrome.tabs.sendMessage(tabId, { type: 'mc-extract-page-metadata' }) || {};
    } catch { /* content script not available — proceed with basic data */ }
  }

  const thumbnailUrl = pageMeta.ogImage || pageMeta.twitterImage || undefined;
  const detectedPlatform = pageMeta.detectedPlatform || null;
  const resolvedTitle = pageMeta.ogTitle || title || undefined;
  const resolvedDescription = description || pageMeta.ogDescription || undefined;

  try {
    const response = await fetch(`${apiUrl}/api/triage/capture`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-triage-capture-key': captureKey,
      },
      body: JSON.stringify({
        url,
        title: resolvedTitle,
        description: resolvedDescription,
        thumbnailUrl,
        client: 'browser',
        sourcePlatform: detectedPlatform || 'browser_extension',
        ...(pageMeta.platformMeta && { platformMeta: pageMeta.platformMeta }),
      }),
    });

    if (tabId != null) {
      showBadge(tabId, response.ok ? '\u2713' : '!', response.ok ? '#22c55e' : '#ef4444');
    }
  } catch {
    if (tabId != null) showBadge(tabId, '!', '#ef4444');
  }
}

// ─── Keyboard shortcut handler ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-to-triage') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url || isInternalUrl(tab.url)) return;

  await captureToTriage({ url: tab.url, title: tab.title, tabId: tab.id });
});

// ─── Context menu ────────────────────────────────────────────────────────────

const CONTEXT_MENU_ID = 'mc-save-to-triage';

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: CONTEXT_MENU_ID,
    title: 'Save to Mission Control Triage',
    contexts: ['page', 'link'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;

  // Prefer the right-clicked link target; fall back to the page itself.
  const url = info.linkUrl || info.pageUrl || tab?.url;
  if (!url || isInternalUrl(url)) return;

  await captureToTriage({ url, title: tab?.title, tabId: tab?.id });
});

// ─── Bulk import (Reddit/Instagram/Facebook/TikTok/Pinterest saved-items,
// Twitter/X passive bookmarks+likes capture) ─────────────────────────────────
//
// Platform content scripts fetch/scrape saved items themselves, then send
// normalized batches here. We POST to the Mission Control API from the
// service worker rather than the content script so requests aren't subject
// to the page's Content-Security-Policy, and so we reuse the extension's
// stored apiUrl/captureKey without exposing them to page-context code.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'mc-import-progress') {
    // Persist import state so the popup can restore it when reopened
    const key = `importState_${message.platform}`;
    if (message.done || message.error) {
      chrome.storage.session.remove(key);
    } else {
      chrome.storage.session.set({
        [key]: {
          imported: message.imported ?? 0,
          skipped: message.skipped ?? 0,
          done: false,
          live: !!message.live,
          hint: message.hint || undefined,
        },
      });
    }
    return undefined;
  }

  // ─── Send Tabs to Triage (batch save + optional close) ─────────────────
  if (message?.type === 'mc-send-tabs-batch') {
    (async () => {
      const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);
      if (!apiUrl || !captureKey) {
        sendResponse({ error: 'Mission Control is not configured — open the extension popup and save your settings first.' });
        return;
      }

      const tabs = Array.isArray(message.tabs) ? message.tabs : [];
      if (tabs.length === 0) {
        sendResponse({ error: 'No tabs to send.' });
        return;
      }

      // Generate a batch ID to group these items in MC
      const batchId = crypto.randomUUID();
      const batchLabel = message.batchNote || `Tabs ${new Date().toLocaleString()}`;

      // Build items for bulk import
      const allItems = tabs.map((tab) => ({
        sourcePlatform: 'browser_tabs',
        sourceId: `tab-${batchId}-${tab.id}`,
        sourceUrl: tab.url,
        title: tab.title || tab.url,
        capturedAt: new Date().toISOString(),
        rawMetadata: {
          batchId,
          batchLabel,
          favIconUrl: tab.favIconUrl || null,
          originalTabId: tab.id,
        },
      }));

      // Chunk into batches of 100 (API limit)
      const CHUNK_SIZE = 100;
      let totalImported = 0;
      let totalSkipped = 0;
      const allErrors = [];

      try {
        for (let i = 0; i < allItems.length; i += CHUNK_SIZE) {
          const chunk = allItems.slice(i, i + CHUNK_SIZE);
          const response = await fetch(`${apiUrl}/api/triage/import/bulk`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-triage-capture-key': captureKey,
            },
            body: JSON.stringify({ items: chunk }),
          });

          const data = await response.json().catch(() => ({}));
          if (!response.ok) {
            sendResponse({ error: data.error || `Bulk import failed: ${response.status}` });
            return;
          }

          totalImported += data.imported ?? 0;
          totalSkipped += data.skipped ?? 0;
          if (Array.isArray(data.errors)) allErrors.push(...data.errors);
        }

        // Only close tabs if there were no errors and closeTabs was requested
        let closed = 0;
        if (message.closeTabs && allErrors.length === 0) {
          const tabIds = tabs.map(t => t.id);
          const results = await Promise.allSettled(
            tabIds.map(id => chrome.tabs.remove(id))
          );
          closed = results.filter(r => r.status === 'fulfilled').length;
        }

        sendResponse({
          imported: totalImported,
          skipped: totalSkipped,
          errors: allErrors,
          closed,
          batchId,
        });
      } catch (err) {
        sendResponse({ error: err.message || 'Network error reaching Mission Control' });
      }
    })();

    return true; // keep message channel open for async response
  }

  if (message?.type !== 'mc-bulk-import-batch') return undefined;

  (async () => {
    const { apiUrl, captureKey } = await chrome.storage.sync.get(['apiUrl', 'captureKey']);
    if (!apiUrl || !captureKey) {
      sendResponse({ error: 'Mission Control is not configured — open the extension popup and save your settings first.' });
      return;
    }

    try {
      const response = await fetch(`${apiUrl}/api/triage/import/bulk`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-triage-capture-key': captureKey,
        },
        body: JSON.stringify({ items: message.items, refreshThumbnails: true }),
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        sendResponse({ error: data.error || `Bulk import request failed: ${response.status}` });
        return;
      }

      sendResponse({ imported: data.imported ?? 0, skipped: data.skipped ?? 0, errors: data.errors ?? [] });
    } catch (err) {
      sendResponse({ error: err.message || 'Network error reaching Mission Control' });
    }
  })();

  return true; // keep the message channel open for the async sendResponse above
});

