# Publishing the Browser Extension

This guide covers how to publish the Mission Control browser extension to the
Chrome Web Store and Microsoft Edge Add-ons store.

---

## Prerequisites

- [ ] [Chrome Web Store Developer Account](https://chrome.google.com/webstore/devconsole) ($5 one-time fee)
- [ ] [Microsoft Partner Center Account](https://partner.microsoft.com/en-us/dashboard/microsoftedge/overview) (free)
- [ ] Screenshots (see `store-assets/README.md` for dimensions)
- [ ] Extension icon at 128×128 (already exists in `icons/icon-128.png`)

---

## Release Flow

```
┌─────────────────────────────────────────────────────────┐
│  1. Bump version                                         │
│     cd clients/browser-extension                         │
│     node scripts/bump-version.mjs patch                  │
│                                                          │
│  2. Commit & tag                                         │
│     git add manifest.json                                │
│     git commit -m "ext: bump to vX.Y.Z"                  │
│     git tag ext-vX.Y.Z                                   │
│                                                          │
│  3. Push (triggers CI)                                   │
│     git push origin main --tags                          │
│                                                          │
│  4. GitHub Actions packages the .zip and creates a       │
│     GitHub Release with the artifact attached            │
│                                                          │
│  5. Download .zip from the Release, then upload to:      │
│     • Chrome Web Store Developer Dashboard               │
│     • Edge Add-ons Partner Center                        │
│                                                          │
│  6. Wait for store review (typically 1-3 days initial,   │
│     hours for subsequent updates)                        │
└─────────────────────────────────────────────────────────┘
```

---

## Chrome Web Store — First-Time Setup

1. Go to https://chrome.google.com/webstore/devconsole
2. Pay the $5 registration fee
3. Click **"New Item"** → upload the `.zip`
4. Fill in the listing:
   - **Name:** Mission Control — Save to Triage
   - **Description:** Copy from `store-assets/description.txt`
   - **Category:** Productivity
   - **Language:** English
   - **Screenshots:** Upload from `store-assets/`
   - **Icon:** Already embedded in the zip
5. Under **Visibility:**
   - Choose **Unlisted** — won't appear in search, only accessible via direct URL
   - (You can change to Public later when ready)
6. Submit for review

### Subsequent Updates

1. Go to your extension in the Developer Dashboard
2. Click **"Package"** → **"Upload new package"**
3. Upload the new `.zip` from the GitHub Release
4. Bump the version in the store listing if prompted
5. Submit for review

---

## Edge Add-ons — First-Time Setup

1. Go to https://partner.microsoft.com/en-us/dashboard/microsoftedge/overview
2. Sign in with a Microsoft account (no fee)
3. Click **"Create new extension"** → upload the `.zip`
4. Fill in the listing:
   - **Name:** Mission Control — Save to Triage
   - **Description:** Copy from `store-assets/description.txt`
   - **Category:** Productivity
   - **Screenshots:** Upload from `store-assets/`
5. Under **Availability:**
   - Choose **Hidden** — only accessible via direct URL
6. Submit for certification

### Subsequent Updates

1. Go to your extension in the Partner Center
2. Click **"Update"** → upload new `.zip`
3. Submit for certification

---

## Visibility Options Reference

| Store | Option | Behavior |
|-------|--------|----------|
| Chrome | **Unlisted** | Not in search; install via direct URL only |
| Chrome | **Private** | Only specific Google accounts (you configure a list) |
| Chrome | **Public** | Anyone can find and install |
| Edge | **Hidden** | Not in search; install via direct URL only |
| Edge | **Public** | Anyone can find and install |

**Recommendation for mission-control.example (private app):** Use **Unlisted** (Chrome) and **Hidden** (Edge). Share the store links on your mission-control.example site or directly with users.

---

## Self-Hosted Developer Distribution (While Iterating)

For rapid iteration before publishing to stores, you can host the extension zip
on mission-control.example for manual install. See `DEVELOPER-DISTRIBUTION.md` for the
version-check notification system that prompts users to update.

---

## Store Listing Assets Checklist

```
clients/browser-extension/store-assets/
├── description.txt          ✅ Store description copy
├── screenshot-1.png         ⬜ TODO: Capture popup in action
├── screenshot-2.png         ⬜ TODO: Capture context menu
├── promo-small.png          ⬜ Optional: 440×280 promotional tile
└── promo-marquee.png        ⬜ Optional: 1400×560 marquee banner
```

---

## Useful Links

- [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
- [Chrome Extension Publishing Docs](https://developer.chrome.com/docs/webstore/publish/)
- [Edge Add-ons Partner Center](https://partner.microsoft.com/en-us/dashboard/microsoftedge/overview)
- [Edge Extension Publishing Docs](https://learn.microsoft.com/en-us/microsoft-edge/extensions-chromium/publish/publish-extension)
- [GitHub Actions Workflow](.github/workflows/extension-release.yml)
