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

  return undefined;
});
