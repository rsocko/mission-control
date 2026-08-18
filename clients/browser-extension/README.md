# Mission Control — Save to Triage (Browser Extension)

Chrome/Edge/Brave (Manifest V3) extension that quick-captures the current
page — or a right-clicked link — to Mission Control's Triage Queue.

For install/configure/use instructions, see the shared
[`clients/SETUP-GUIDE.md`](../SETUP-GUIDE.md#1-browser-extension-chrome--edge--brave).

## Structure

```
browser-extension/
├── manifest.json              MV3 manifest: permissions, content scripts,
│                              web_accessible_resources, keyboard shortcut
├── popup.html                 Popup UI (settings, quick capture, sources)
├── popup.js / popup/          Popup shell plus focused capture, send-tabs,
│                              and DOM modules
├── background.js / background/
│                              Service worker event wiring and bulk-import relay
├── shared/capture-client.js   Canonical URL guard and capture payload/client
├── content-scripts/
│   ├── capture.js             Extracts page metadata (title, OG tags,
│   │                          canonical URL) on request — no auto-run logic
│   └── import/
│       ├── common.js          Shared fetch relay, pagination, batch submission,
│       │                      progress, and bounded-error orchestration
│       ├── reddit-import.js   Paginates reddit.com/user/<you>/saved.json
│       ├── instagram-import.js Paginates /api/v1/feed/saved/posts/ via relay
│       └── facebook-import.js Scroll + DOM-scrape facebook.com/saved
├── page-fetch-relay.js        MAIN-world fetch/observation relay used by
│                              platform importers with page-session context
└── icons/                     Toolbar/extension icons
```
_\* popup.css doesn't exist — styles are inlined in `popup.html`._

## What's implemented (MVP)

- Quick capture via popup or `Ctrl+Shift+S`
- Right-click context menu ("Save to Mission Control Triage") on pages/links
- Settings (server URL + capture key) stored in `chrome.storage.sync`
- Badge feedback (✓ / !) on capture success/failure
- Sources dashboard listing Reddit, Instagram, Facebook, YouTube, TikTok,
  Pinterest with "Go →" links to each platform's saved/library page
- **Bulk import** for Reddit, Instagram, Facebook, TikTok, Pinterest, and X:
  when the popup is
  opened on a matching tab, the "Go →" button becomes "Import" and streams
  live progress while it paginates/scrapes the platform's saved items and
  submits them to `POST /api/triage/import/bulk`

## Bulk import details

| Platform  | Technique | Notes |
|-----------|-----------|-------|
| Reddit    | `GET reddit.com/user/<you>/saved.json` (direct fetch, cookie auth) | Paginates via `after` cursor; covers saved posts + comments |
| Instagram | `GET /api/v1/feed/saved/posts/` via the MAIN-world `page-fetch-relay.js` | Needs `csrftoken` cookie + `x-ig-app-id` scraped from inline `<script>` tags; paginates via `next_max_id` |
| Facebook  | DOM scraping of `facebook.com/saved` with auto-scroll | No stable public/private JSON endpoint exists for Saved items, so this scrolls the rendered page and scrapes visible post/video/photo links instead of hitting Facebook's undocumented GraphQL API |

All importers normalize items to the same shape as the single-item capture flow
and are deduplicated server-side by `sourceId`/canonical URL, so re-running
an import is safe and only ingests new items.

See [`docs/STASHT-EXTENSION-REVERSE-ENGINEERING.md`](../../docs/STASHT-EXTENSION-REVERSE-ENGINEERING.md)
for the research this was based on.

YouTube remains a dashboard link rather than a browser-extension bulk importer.
