---
title: "Triage Enhancements — Content Extraction, Resurfacing & Richer Capture"
status: proposed
created: 2026-07-23
last_reviewed: 2026-07-23
category: design
related:
  - "[Triage Queue](triage-queue.md)"
  - "[Triage Feature Doc](../../features/triage.md)"
inspiration:
  - "LikePost iOS app — auto-categorization, structured extraction, smart resurfacing"
  - "mymind — AI-powered extraction, visual cards, natural language retrieval"
---

# Triage Enhancements — Design Spec

## Overview

This spec covers four enhancement areas identified by analyzing apps like LikePost and mymind that go beyond basic link saving. These build on the existing Triage Queue infrastructure (schema, iOS Shortcut, browser extension) to add deeper intelligence and richer capture.

---

## 1. Deeper Content Extraction

### Problem

Currently, the browser extension (`capture.js`) only extracts Open Graph metadata (title, description, image). The iOS Shortcut sends a URL and optional text. Neither captures structured information *from within* the saved content — e.g., a recipe's ingredients, a product's price, an article's key quotes, or a repo's tech stack.

### Proposed Approach

#### A. Client-Side Enrichment (Browser Extension)

Expand `capture.js` and platform-specific content scripts to extract richer structured data:

| Platform | Additional Fields |
|----------|------------------|
| YouTube | Duration, channel, view count, publish date, chapters |
| Reddit | Subreddit, score, comment count, post type (text/link/image) |
| GitHub | Stars, language, last commit, description, topics |
| Twitter/X | Author handle, like count, media URLs, thread detection |
| Product pages | Price, brand, availability (via JSON-LD / schema.org) |
| Recipes | Ingredients, cook time, servings (via schema.org Recipe) |
| Articles | Author, publish date, reading time, key quotes |

Implementation: Add a `structured-extractors/` module that checks for JSON-LD, Microdata, and platform-specific DOM patterns. Falls back to OG meta when no structured data is found.

#### B. Server-Side AI Enrichment (Post-Save)

For items where client-side extraction is insufficient:

1. On ingest, fetch the page content (already have `page-fetch-relay.js` scaffolding)
2. Pass to AI with a prompt requesting structured extraction
3. Store results in the existing `rawMetadata` JSON field
4. Update `aiCategories` and `aiSummary` based on extracted structure

#### C. Schema Changes

Add to `triage_items`:
```
extractedFields: text('extracted_fields', { mode: 'json' }).default('{}')
extractionStatus: text('extraction_status').default('pending') // pending | partial | complete | failed
extractionSource: text('extraction_source') // 'client' | 'server-ai' | 'both'
```

---

## 2. Richer Content Type Matching

### Problem

Content type detection currently relies on URL pattern matching (`urlPatterns`) and keyword hints (`keywordHints`) in the `triage_content_types` registry. This misses nuance — e.g., a GitHub link could be a repo, an issue, a discussion, a gist, or a PR.

### Proposed Approach

#### A. Hierarchical Content Types

Support parent/child type relationships:

```
code
  ├── repo
  ├── gist
  ├── issue
  └── pull-request
media
  ├── video
  ├── podcast
  └── music
reference
  ├── article
  ├── documentation
  └── tutorial
commerce
  ├── product
  ├── deal
  └── wishlist-item
```

#### B. Multi-Signal Detection

Score content types using multiple signals weighted together:

1. **URL structure** (existing) — path segments, query params
2. **JSON-LD / schema.org type** (new) — strongest signal when present
3. **OG type** (new) — `og:type` meta tag
4. **Extracted fields** (new) — presence of price → product, ingredients → recipe
5. **AI classification** (existing) — fallback when heuristics are ambiguous

#### C. Content Type Confidence

Add a confidence score to type assignment so the UI can surface "unsure" items for manual classification, improving the model over time.

---

## 3. Smart Resurfacing

### Problem

Once items are saved and processed, they're static. There's no mechanism to proactively bring relevant saved items back to attention at the right time — unlike LikePost's contextual resurfacing or mymind's serendipity browsing.

### Proposed Approach

#### A. Trigger-Based Resurfacing

Define triggers that cause saved items to resurface:

| Trigger | Example |
|---------|---------|
| **Time-based** | "You saved this 30 days ago and never acted on it" |
| **Context match** | "You're working on a React project — here's a React library you saved" |
| **Calendar proximity** | "You saved 3 restaurants in Denver — your trip is next week" |
| **Related task** | "You created a task about auth — here's an auth article you triaged" |
| **Decay prevention** | Items approaching a "stale" threshold get one last nudge |

#### B. Resurfacing UI

- **Dashboard widget** — "Rediscover" card showing 1–3 contextually relevant saved items
- **Triage sidebar section** — "Resurface" filter showing items triggered for review
- **Daily digest** (optional) — Part of the existing routines system

#### C. Relevance Scoring for Resurfacing

Use the existing `aiRelevanceScore` plus temporal decay and context signals:

```
resurfaceScore = baseRelevance * decayFactor * contextBoost
```

Where:
- `decayFactor` decreases over time (items lose urgency)
- `contextBoost` increases when current activity matches saved item topics

#### D. Schema Changes

```
resurfacedAt: text('resurfaced_at')
resurfaceCount: integer('resurface_count').default(0)
resurfaceTrigger: text('resurface_trigger') // what caused it to resurface
```

---

## 4. Richer iOS Share Sheet Capture

### Problem

The current iOS Shortcut sends a URL + optional user note. It doesn't leverage iOS Shortcuts' built-in actions to extract richer data before sending to Mission Control.

### Proposed Approach

#### A. Enhanced Shortcut Actions

Before POSTing to the webhook, the shortcut should:

1. **Get Article from URL** — Extract article body text, author, publish date
2. **Get Name of Source App** — Record which app the share came from (Safari, Reddit, Instagram, etc.)
3. **Get Selected Text** — If user highlighted text before sharing, include it as a quote
4. **Get Images** — If sharing from Photos or a post with images, send thumbnail data
5. **Get Clipboard** — Optionally include clipboard context

#### B. Enhanced Webhook Payload

Expand the POST body from:
```json
{ "url": "...", "notes": "..." }
```

To:
```json
{
  "url": "...",
  "notes": "...",
  "sourceApp": "com.reddit.Reddit",
  "selectedText": "This is the highlighted quote...",
  "articleBody": "First 500 chars of extracted article...",
  "articleAuthor": "Jane Doe",
  "articlePublishDate": "2026-07-20",
  "thumbnailBase64": "...",
  "capturedAt": "2026-07-23T00:40:00Z"
}
```

#### C. Server-Side Handling

The ingest endpoint already accepts `rawMetadata` — route these new fields there and use them to:
- Pre-populate `aiSummary` with the article excerpt
- Set `sourcePlatform` from `sourceApp` bundle ID mapping
- Store `selectedText` as a user-annotated highlight

---

## Implementation Priority

| Enhancement | Effort | Impact | Priority |
|-------------|--------|--------|----------|
| Richer iOS Share Sheet | Low | Medium | P1 — Quick win |
| Deeper Content Extraction (client-side) | Medium | High | P2 — High value |
| Richer Content Type Matching | Medium | Medium | P3 — Builds on extraction |
| Smart Resurfacing | High | High | P4 — Needs data to accumulate first |

---

## Related Issues

- Deeper Content Extraction → GitHub Issue TBD
- Richer Content Type Matching → GitHub Issue TBD
- Smart Resurfacing → GitHub Issue TBD
- Richer iOS Share Sheet Capture → GitHub Issue TBD
