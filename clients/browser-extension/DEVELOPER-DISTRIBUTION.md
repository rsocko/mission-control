# Developer Distribution (Self-Hosted)

Guide for distributing the extension from mission-control.example during active development,
before publishing to stores.

---

## How It Works

1. You package the extension and host the `.zip` + a `version.json` on mission-control.example
2. The extension periodically checks `version.json` for a newer version
3. If an update is available, it shows a browser notification to the user
4. User downloads the new zip, extracts, and reloads in `chrome://extensions`

---

## Setup on mission-control.example

Host these files at a stable URL path (e.g., `/extension/`):

### `/extension/version.json`
```json
{
  "version": "1.0.1",
  "downloadUrl": "https://mission-control.example/extension/mission-control-extension-latest.zip",
  "changelog": "Fixed badge icon on dark theme"
}
```

### `/extension/mission-control-extension-latest.zip`
The packaged extension zip (output of `node scripts/package.mjs`).

---

## Extension Update Checker

Add this to `background.js` to enable self-hosted update notifications:

```js
// --- Self-hosted update check ---
const UPDATE_CHECK_URL = 'https://mission-control.example/extension/version.json';
const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

async function checkForUpdate() {
  try {
    const res = await fetch(UPDATE_CHECK_URL);
    if (!res.ok) return;
    const { version, downloadUrl, changelog } = await res.json();
    const current = chrome.runtime.getManifest().version;
    if (version !== current) {
      chrome.notifications.create('mc-update-available', {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: `Mission Control v${version} Available`,
        message: changelog || 'A new version is available.',
        buttons: [{ title: 'Download Update' }],
        requireInteraction: true,
      });
    }
  } catch (e) {
    // Silently fail — network might be unavailable
  }
}

// Check on install/startup
chrome.runtime.onInstalled.addListener(checkForUpdate);
chrome.runtime.onStartup.addListener(checkForUpdate);

// Periodic check via alarms
chrome.alarms.create('mc-update-check', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'mc-update-check') checkForUpdate();
});

// Handle notification button click
chrome.notifications.onButtonClicked.addListener((notifId, btnIdx) => {
  if (notifId === 'mc-update-available' && btnIdx === 0) {
    chrome.tabs.create({ url: UPDATE_CHECK_URL.replace('version.json', '') });
  }
});
```

> **Note:** Add `"notifications"` to the `permissions` array in `manifest.json`
> if not already present.

---

## User Install Flow (First Time)

1. Go to `https://mission-control.example/extension/`
2. Download the `.zip`
3. Extract to a permanent folder (e.g., `~/mission-control-extension/`)
4. Open `chrome://extensions` (or `edge://extensions`)
5. Enable **Developer mode** (toggle in top-right)
6. Click **"Load unpacked"** → select the extracted folder
7. Configure: click the extension icon → Settings → enter server URL and capture key

---

## User Update Flow (When Notified)

1. Click the notification or visit `https://mission-control.example/extension/`
2. Download the new `.zip`
3. Extract to the **same folder** (overwrite)
4. Go to `chrome://extensions` → click the **reload (↻)** icon on the extension card

---

## Deployment Script

After packaging, deploy to your server:

```bash
# Package
cd clients/browser-extension
node scripts/package.mjs

# Update version.json (manual or scripted)
VERSION=$(node -p "require('./manifest.json').version")
echo "{\"version\":\"$VERSION\",\"downloadUrl\":\"https://mission-control.example/extension/mission-control-extension-latest.zip\",\"changelog\":\"\"}" > dist/version.json

# Upload to server (adjust for your deploy method)
scp dist/mission-control-extension-v${VERSION}.zip yourserver:/var/www/mission-control.example/extension/mission-control-extension-latest.zip
scp dist/version.json yourserver:/var/www/mission-control.example/extension/version.json
```

---

## Limitations vs Store Distribution

| Aspect | Self-Hosted | Chrome/Edge Store |
|--------|-------------|-------------------|
| Install friction | High (5+ steps) | One click |
| Auto-update | ❌ Manual reload | ✅ Automatic |
| Security warnings | "Developer mode" banner | None |
| Update notifications | ✅ Via our checker | ✅ Built-in |
| Review process | None | 1-3 days |
| Iteration speed | Instant | Hours-to-days |

**Recommendation:** Use self-hosted during active development, then transition to
Unlisted/Hidden store listings once the extension stabilizes.
