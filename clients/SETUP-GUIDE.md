# Triage Capture Clients — Setup Guide

Universal capture for Mission Control's Triage Queue from any device or browser.

---

## Prerequisites

1. **Mission Control running** at a known URL (e.g., `http://localhost:3099`)
2. **Capture key configured** — set the `MC_TRIAGE_CAPTURE_KEY` environment variable:
   ```bash
   # .env.local
   MC_TRIAGE_CAPTURE_KEY=your-secret-key-here
   ```
   If unset, the capture API accepts all requests (development mode).

---

## 1. Browser Extension (Chrome / Edge / Brave)

### Install

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable **Developer mode** (toggle in top-right)
3. Click **Load unpacked**
4. Select the `clients/browser-extension/` folder

The extension requests `host_permissions` for `http://*/*` and `https://*/*` to
allow cross-origin API calls to your Mission Control server. Chrome will show a
permissions prompt on install.

### Configure

1. Click the extension icon in the toolbar
2. Enter your **Mission Control URL** (e.g., `http://localhost:3099`)
3. Enter your **Capture Key** (the `MC_TRIAGE_CAPTURE_KEY` value)
4. Click **Save Configuration**

### Use

| Action | How |
|--------|-----|
| **Popup capture** | Click extension icon → review page info → **Save to Triage** |
| **Persistent imports** | Click extension icon → **Keep open in side panel** → choose an import source |
| **Keyboard shortcut** | Press `Ctrl+Shift+S` (`⌘+Shift+S` on Mac) — captures instantly, no popup |
| **Right-click capture** | Right-click a page or link → **Save to Mission Control Triage** |
| **Add a note** | Type in the note field before saving (popup only) |

### Sources dashboard

The popup and persistent side panel list supported import platforms. The side
panel stays visible while navigating to a platform's saved-items page, then
refreshes its import action when that page is ready.

> **Shortcut conflict:** `Ctrl+Shift+S` may conflict with "Save As" on some
> browsers. You can rebind it at `chrome://extensions/shortcuts`.

### What gets captured

- Page URL
- Page title
- Optional note (as `description`)
- Source tagged as `browser_extension`

### Badge indicators

| Badge | Meaning |
|-------|---------|
| **✓** (green) | Successfully saved |
| **!** (red) | Failed — check URL/key configuration |

---

## 2. iOS Shortcut

### Install

1. Open **Shortcuts** app on iPhone/iPad
2. Follow the step-by-step build instructions in [`ios-shortcut/README.md`](ios-shortcut/README.md)
3. Replace `REPLACE_WITH_YOUR_MC_URL` and `REPLACE_WITH_YOUR_KEY` with your values

Alternatively, use the JSON definition in `ios-shortcut/save-to-triage.shortcut.json`
as a reference for the exact action structure.

### Configure

| Setting | Value |
|---------|-------|
| **MC URL** | Your server's IP/hostname (e.g., `http://192.0.2.10:3099`) |
| **Capture Key** | Your `MC_TRIAGE_CAPTURE_KEY` value |
| **Share Sheet** | Enable in shortcut settings → "Show in Share Sheet" |

### Use

1. In any app (Reddit, Safari, YouTube, Instagram…), tap **Share**
2. Scroll down and tap **Save to Triage**
3. A notification confirms the capture

### Network access

Your phone must be able to reach Mission Control:

| Method | Setup |
|--------|-------|
| **Same Wi-Fi** | Use local IP (e.g., `http://192.0.2.10:3099`) |
| **Tailscale** | Use Tailscale IP or MagicDNS hostname |
| **Cloudflare Tunnel** | Use your tunnel domain (HTTPS) |

---

## API Reference

Both clients call the same endpoint:

```
POST /api/triage/capture
```

### Headers

| Header | Value |
|--------|-------|
| `Content-Type` | `application/json` |
| `Authorization` | `Bearer <MC_TRIAGE_CAPTURE_KEY>` |

Or use the custom header: `X-Triage-Capture-Key: <key>`

### Request Body

```json
{
  "url": "https://reddit.com/r/homelab/...",
  "title": "Optional title override",
  "description": "Optional note or context",
  "sharedText": "Full text from share sheet",
  "client": "browser" | "ios",
  "sourcePlatform": "browser_extension" | "ios_share"
}
```

Only `url` is required. All other fields are optional.

### Response (201 Created)

```json
{
  "item": {
    "id": "abc-123",
    "title": "Resolved page title",
    "status": "pending",
    "contentType": "link",
    "aiRelevanceScore": 72,
    "aiSuggestedActions": [
      { "actionType": "save_karakeep", "confidence": 0.78, "reason": "..." }
    ]
  }
}
```

### Error Responses

| Status | Body | Cause |
|--------|------|-------|
| 400 | `{ "error": "url is required" }` | Missing or empty URL |
| 401 | `{ "error": "Unauthorized capture request" }` | Invalid or missing capture key |
| 500 | `{ "error": "Failed to capture triage item" }` | Server error during ingest |

---

## Security Notes

- The capture key is a shared secret — treat it like a password
- Use HTTPS if exposing Mission Control beyond your local network
- The browser extension stores the key in Chrome's `sync` storage (encrypted at rest)
- The iOS Shortcut embeds the key directly — don't share the shortcut file
- If the key is compromised, rotate it by changing `MC_TRIAGE_CAPTURE_KEY` and
  updating both clients
