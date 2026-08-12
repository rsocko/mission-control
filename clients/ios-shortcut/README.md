# iOS Shortcut — Save to Mission Control Triage

This document describes how to create an iOS Shortcut that captures any shared
content (URLs, text, images) and sends it to Mission Control's Triage Queue.

---

## Quick Setup

### 1. Create the Shortcut

Open the **Shortcuts** app on your iPhone/iPad and create a new shortcut:

**Name:** `Save to Triage`
**Icon:** 📥 (inbox tray) or ⚡ (lightning bolt)
**Color:** Indigo/Purple

### 2. Build the Actions

Add these actions in order:

```
┌─────────────────────────────────────────────┐
│ 1. Receive [Any] input from [Share Sheet]   │
│    ☑ Show in Share Sheet                    │
│    If there's no input: [Stop and Respond]  │
│                                             │
│ 2. Set variable "sharedInput" to            │
│    [Shortcut Input]                         │
│                                             │
│ 3. Get URLs from [sharedInput]              │
│    Set variable "capturedUrl" to [URLs]     │
│                                             │
│ 4. IF [capturedUrl] [has any value]         │
│    │                                        │
│    │  5. Get Contents of URL                │
│    │     URL: YOUR_MC_URL/api/triage/capture│
│    │     Method: POST                       │
│    │     Headers:                           │
│    │       Content-Type: application/json   │
│    │       Authorization: Bearer YOUR_KEY   │
│    │     Request Body (JSON):               │
│    │     {                                  │
│    │       "url": [capturedUrl],            │
│    │       "title": [Name of sharedInput],  │
│    │       "sharedText": [sharedInput],     │
│    │       "client": "ios",                 │
│    │       "sourcePlatform": "ios_share"    │
│    │     }                                  │
│    │                                        │
│    │  6. Show Notification                  │
│    │     Title: "Saved to Triage ✓"         │
│    │     Body: [capturedUrl]                │
│    │                                        │
│    │ OTHERWISE                              │
│    │                                        │
│    │  7. Show Alert                         │
│    │     "No URL found in shared content"   │
│    │                                        │
│    └ End IF                                 │
└─────────────────────────────────────────────┘
```

### 3. Configure Your Values

Replace these placeholders:

| Placeholder | Value | Example |
|-------------|-------|---------|
| `YOUR_MC_URL` | Your Mission Control server URL | `http://192.0.2.10:3099` |
| `YOUR_KEY` | Your `MC_TRIAGE_CAPTURE_KEY` env var value | `my-secret-capture-key-123` |

### 4. Enable Share Sheet

In the shortcut settings:
- Toggle **Show in Share Sheet** → ON
- Under **Share Sheet Types**, select: URLs, Safari web pages, Text

---

## How It Works

1. You're browsing Reddit/Instagram/YouTube/any app
2. Tap **Share** → scroll to **Save to Triage**
3. The shortcut extracts the URL from shared content
4. POSTs it to Mission Control's capture endpoint
5. Shows a confirmation notification
6. Item appears in your Triage Queue within seconds

---

## API Contract

```
POST /api/triage/capture
Authorization: Bearer <MC_TRIAGE_CAPTURE_KEY>
Content-Type: application/json

{
  "url": "https://reddit.com/r/homelab/comments/...",
  "title": "Optional title override",
  "sharedText": "Full shared text from the app",
  "client": "ios",
  "sourcePlatform": "ios_share"
}
```

**Response (201):**
```json
{
  "item": {
    "id": "uuid",
    "title": "...",
    "status": "pending",
    "aiRelevanceScore": 72,
    "aiSuggestedActions": [...]
  }
}
```

---

## Advanced: Add a Note Before Saving

To add a personal note to captured items, insert an **Ask for Input** action
before the API call:

```
4a. Ask for Input
    Prompt: "Add a note (optional)"
    Input Type: Text
    Default: (empty)
    Set variable "userNote" to [Provided Input]
```

Then add `"description": [userNote]` to the request body JSON.

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Could not connect to server" | Ensure MC is running and reachable from your phone (same network or via tunnel) |
| 401 Unauthorized | Check that `MC_TRIAGE_CAPTURE_KEY` matches the Bearer token |
| "No URL found" | The shared content didn't contain a parseable URL — try sharing from the browser |
| Shortcut doesn't appear in Share Sheet | Go to Shortcuts → your shortcut → ⓘ → ensure "Show in Share Sheet" is enabled |

---

## Network Requirements

Mission Control must be reachable from your phone:
- **Local network**: Use your Mac/PC's local IP (e.g., `http://192.0.2.10:3099`)
- **Remote access**: Use a tunnel service (Tailscale, Cloudflare Tunnel, ngrok)
- **HTTPS**: Required if using a public tunnel; not needed for local network
