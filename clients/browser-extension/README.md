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

### Local history and repeat imports

The extension stores checkpoints in this browser profile's `chrome.storage.local`,
separately for each Mission Control URL, source account, and feed/collection/board.
These checkpoints survive closing the popup, restarting the browser, and reloading
the extension; they are not synced to other browsers. Existing imports made before
this feature need one pass to establish a local checkpoint.

- **Reddit and Instagram:** check the newest saved items first. Once the previous
  item-ID boundary is reached, a completed history stops there; an unfinished
  history resumes its saved pagination cursor. Page limits, interrupted tabs,
  expired cursors, and failed submissions never count as full completion.
- **Pinterest and TikTok:** record history independently for each board/collection
  and avoid resubmitting acknowledged items. These lists are not assumed to be
  strictly newest-saved-first, so they still paginate rather than using a cutoff
  that could miss reordered items.
- **Facebook and X:** avoid resubmitting locally recorded items when the account
  can be identified. Facebook's scroll-stall limit and X's **Finish** action end
  the current run but do not prove that all historical items were captured.
  If the account cannot be identified safely, history is isolated to that run
  rather than risking skipped items after switching accounts.

The source card shows the last successful import/checkpoint time, its feed scope,
and whether full history was confirmed. For chronological API feeds it also links
to the oldest reached item. This is based on saved-list order, **not** the post's
publication date; saving an old post can put it at the top of the list.

Use **Rescan saved history** before importing to clear this source's local
checkpoints for the current Mission Control URL. It does not delete imported
Triage items. This is also the recovery path for expired cursors, or when you want
to refresh previously imported metadata/thumbnails instead of skipping known
items. Rescanning is disabled while that source is importing.

### Tabs and the shared side panel

The browser side panel is intentionally shared across tabs, but each import belongs
to its originating tab and source. Switching tabs or reopening the popup restores
that tab's progress; updates from another source never overwrite its import card.
Other running imports appear in a source-labeled notice with **View import tab**.
Different sources can import concurrently. Only one tab may import a given source
at a time, preventing conflicting writes to its local history.

Closing or fully reloading the source tab marks the run interrupted and releases
its source lock. Switching tabs and ordinary SPA navigation do not stop it.
Changing the Mission Control URL during a run rejects further batches/checkpoint
writes so history cannot be applied to a different destination.

X recognizes both `/i/bookmarks` and the newer `/i/history` route (which contains
Bookmarks and Likes), as well as profile Likes pages. **Start Capture** observes
requests generated by X itself: use X's in-app navigation and scroll to load
items, then **Finish** when done. It does not automatically paginate X.

See [`docs/STASHT-EXTENSION-REVERSE-ENGINEERING.md`](../../docs/STASHT-EXTENSION-REVERSE-ENGINEERING.md)
for the research this was based on.

YouTube remains a dashboard link rather than a browser-extension bulk importer.
