# iOS Shortcut — Distribution & Updates

Guide for distributing the "Save to Triage" iOS Shortcut and notifying users of updates.

---

## Distribution Options

| Method | Install Friction | Auto-Update | Best For |
|--------|-----------------|-------------|----------|
| **iCloud link** | One tap | ❌ | Sharing with specific people |
| **Link on mission-control.example** | One tap (same link) | ❌ | Landing page for all users |
| **Embed version-check** | N/A | ⚠️ Prompts user | Notifying users of new versions |

---

## Publishing the Shortcut

### 1. Create & Export via iCloud

1. Build the shortcut on your iPhone/iPad (or import `save-to-triage.shortcut.json`)
2. Open **Shortcuts** app → long-press your shortcut → **Share**
3. Tap **"Copy iCloud Link"**
4. You'll get a URL like: `https://www.icloud.com/shortcuts/abc123def456`

### 2. Host on mission-control.example

Add an install section to your site. The iCloud link opens the Shortcuts app directly:

```html
<a href="https://www.icloud.com/shortcuts/YOUR_ID_HERE"
   class="install-button">
  Install iOS Shortcut
</a>
```

Alternatively, host a redirect endpoint:

```
GET /shortcut/install → 302 → https://www.icloud.com/shortcuts/...
```

This lets you update the redirect target without changing your site content.

---

## Version-Check Mechanism

Since iOS Shortcuts have no built-in auto-update, we embed a version check
that runs before each capture. If the server reports a newer version, the
user sees an alert with a link to install the update.

### Server Endpoint

Add this to your Mission Control API:

```
GET /api/shortcut/version

Response:
{
  "version": "1.2.0",
  "installUrl": "https://www.icloud.com/shortcuts/abc123def456",
  "changelog": "Added note-taking before save"
}
```

### Shortcut Version Constant

The shortcut stores its own version as a text action at the top. On each run,
it calls `/api/shortcut/version` — if the server version is newer, it shows
an alert with an "Update" button that opens the iCloud install link.

See the updated shortcut JSON: `save-to-triage.shortcut.json`

---

## Update Flow

```
┌─────────────────────────────────────────────────────────┐
│  1. Make changes to the shortcut on your device          │
│                                                          │
│  2. Re-export: Share → Copy iCloud Link                  │
│     (or delete old shared link first to keep same URL)   │
│                                                          │
│  3. Update the server:                                   │
│     • Bump version in /api/shortcut/version response     │
│     • Update installUrl if the iCloud link changed       │
│                                                          │
│  4. Next time any user runs the shortcut, they'll see:   │
│     "Update Available (v1.2.0) — Added note-taking..."   │
│     [Update Now]  [Skip]                                 │
│                                                          │
│  5. "Update Now" opens the iCloud link → user taps       │
│     "Add Shortcut" → replaces their old copy             │
└─────────────────────────────────────────────────────────┘
```

---

## Keeping the Same iCloud Link

When you re-share a shortcut, Apple generates a **new** iCloud link each time.
To avoid breaking existing installs:

**Option A — Redirect endpoint (recommended):**
Host `/shortcut/install` on mission-control.example that 302-redirects to the current
iCloud link. Update the redirect when you publish a new version. The
version-check response points to your redirect URL, not the raw iCloud link.

**Option B — Delete and re-share:**
In the Shortcuts app → go to the shortcut → ⓘ → "Manage Shared Shortcut" →
"Stop Sharing" → then re-share. Sometimes Apple reuses the same link (not
guaranteed).

**Option C — Direct file hosting:**
Export the `.shortcut` file and host it directly on mission-control.example. iOS will
open it in the Shortcuts app when downloaded. This gives you full control
over the URL but requires the correct MIME type:
```
Content-Type: application/x-apple-shortcut
```

---

## Server Implementation

Add to your API routes:

```typescript
// src/app/api/shortcut/version/route.ts

const SHORTCUT_VERSION = '1.0.0';
const SHORTCUT_INSTALL_URL = 'https://mission-control.example/shortcut/install';
const SHORTCUT_CHANGELOG = 'Initial release';

export function GET() {
  return Response.json({
    version: SHORTCUT_VERSION,
    installUrl: SHORTCUT_INSTALL_URL,
    changelog: SHORTCUT_CHANGELOG,
  });
}
```

> Consider storing these values in your database or environment variables
> so you can update without redeploying.

---

## Comparison to Browser Extension

| Aspect | iOS Shortcut | Browser Extension |
|--------|-------------|-------------------|
| Store/marketplace | ❌ None exists | ✅ Chrome/Edge stores |
| Review process | None | 1-3 days |
| Install friction | One tap (iCloud link) | One click (store) |
| Auto-update | ❌ Manual re-import | ✅ Store handles it |
| Update notification | ✅ Built into shortcut | ✅ Built into extension |
| Versioning | Manual (text constant) | manifest.json version field |
| Distribution control | Share link = access | Unlisted/Hidden listing |
