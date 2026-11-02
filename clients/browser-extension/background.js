importScripts('shared/capture-client.js', 'background/bulk-import.js');

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


async function captureToTriage({ url, title, description, tabId }) {
  try {
    await MCCapture.capture({ url, title, description, tabId });
    if (tabId != null) showBadge(tabId, '\u2713', '#22c55e');
  } catch (error) {
    if (error.code === 'NOT_CONFIGURED') {
      chrome.action.openPopup();
      return;
    }
    if (tabId != null) showBadge(tabId, '!', '#ef4444');
  }
}

// ─── Keyboard shortcut handler ───────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'save-to-triage') return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (MCCapture.isInternalUrl(tab?.url)) return;

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
  if (MCCapture.isInternalUrl(url)) return;

  await captureToTriage({ url, title: tab?.title, tabId: tab?.id });
});

// Serialize state transitions so two popups cannot launch the same source.
let importQueue = Promise.resolve();

async function handleImportMessage(message, sender) {
  const key = `importState_${message.platform}`;
  const data = await chrome.storage.session.get(key);
  const state = data[key];

  if (message.type === 'mc-reset-import-history') {
    if (state && !state.done && Number.isInteger(state.tabId)) throw new Error('Finish this source import before clearing its checkpoint.');
    const { apiUrl } = await chrome.storage.sync.get('apiUrl');
    const histories = await chrome.storage.local.get(null);
    const keys = Object.keys(histories).filter((historyKey) => {
      if (!historyKey.startsWith('importCheckpoint_')) return false;
      const [destination, platform] = JSON.parse(historyKey.slice('importCheckpoint_'.length));
      return destination === apiUrl && platform === message.platform;
    });
    await chrome.storage.local.remove([...keys, `lastImport_${message.platform}`]);
    return {};
  }

  if (message.type === 'mc-request-import') {
    if (state && !state.done && Number.isInteger(state.tabId)) {
      throw new Error('This source is already importing in another tab. Return to that tab to follow its progress.');
    }
    const tab = await chrome.tabs.get(message.tabId);
    const { apiUrl } = await chrome.storage.sync.get('apiUrl');
    const runId = crypto.randomUUID();
    await chrome.storage.session.set({
      [key]: { platform: message.platform, tabId: tab.id, url: tab.url, apiUrl, runId, imported: 0, skipped: 0, done: false },
    });
    try {
      const response = await chrome.tabs.sendMessage(tab.id, {
        type: 'mc-start-import', platform: message.platform, runId,
      });
      if (!response?.started) throw new Error('The page did not start the import. Reload it and try again.');
    } catch (error) {
      await chrome.storage.session.set({ [key]: { ...state, tabId: tab.id, done: true, error: error.message } });
      throw error;
    }
    return { started: true };
  }

  if (!state || sender.tab?.id !== state.tabId || message.runId !== state.runId || state.done) {
    return { error: 'This import is no longer active. Start a new import from the extension.' };
  }
  if (message.type === 'mc-import-progress') {
    await chrome.storage.session.set({
      [key]: { ...state, ...message, done: !!message.done || !!message.error },
    });
    return {};
  }

  const { apiUrl } = await chrome.storage.sync.get('apiUrl');
  if (state.apiUrl !== apiUrl) throw new Error('Mission Control settings changed during this import. Finish or reload the source tab, then start again.');
  const historyKey = `importCheckpoint_${JSON.stringify([apiUrl, message.platform, message.scope])}`;
  if (message.type === 'mc-get-import-checkpoint') {
    const history = await chrome.storage.local.get(historyKey);
    return { checkpoint: history[historyKey] || null };
  }
  if (message.type === 'mc-save-import-checkpoint') {
    await chrome.storage.local.set({
      [historyKey]: message.checkpoint,
      [`lastImport_${message.platform}`]: {
        scope: message.scope,
        apiUrl,
        lastImportedAt: message.checkpoint.lastImportedAt,
        earliestItem: message.checkpoint.earliestItem,
        ordered: message.checkpoint.ordered,
        completed: message.checkpoint.completed,
      },
    });
    return {};
  }
  return {};
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!['mc-request-import', 'mc-import-progress', 'mc-get-import-checkpoint', 'mc-save-import-checkpoint', 'mc-reset-import-history'].includes(message?.type)) {
    return undefined;
  }
  importQueue = importQueue.then(() => handleImportMessage(message, sender))
    .then(sendResponse, (error) => {
      console.error('[MC Triage] Import state update failed:', error);
      sendResponse({ error: error.message || 'Could not save import progress.' });
    });
  return true;
});

async function interruptTabImports(tabId) {
  const states = await chrome.storage.session.get(null);
  for (const [key, state] of Object.entries(states)) {
    if (key.startsWith('importState_') && state.tabId === tabId && !state.done) {
      await chrome.storage.session.set({
        [key]: { ...state, done: true, error: 'Import interrupted by a page reload or closed tab. Run again to continue.' },
      });
    }
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  importQueue = importQueue.then(() => interruptTabImports(tabId)).catch(console.error);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    importQueue = importQueue.then(() => interruptTabImports(tabId)).catch(console.error);
  }
});
