---
title: "Shipment Tracking"
status: pre-implementation
created: 2026-07-10
last_reviewed: 2026-07-22
category: design
context: "Fits Mission Control's role as a personal intelligence aggregator — packages are time-sensitive, arrive from multiple sources, and benefit from the same AI-extraction + deduplication approach used for tasks and alerts."
related:
  - "[Package Delivery Tracking](PACKAGE-DELIVERY-TRACKING.md)"
  - "[Connector Expansion Review](CONNECTOR-EXPANSION-REVIEW.md)"
  - "[Future Integrations](FUTURE-INTEGRATIONS.md)"
mockups:
  - "[mockup-shipments.html](../mockups/mockup-shipments.html)"
---

# Shipment Tracking — Design & Phased Implementation

> Automatically detect, track, and surface incoming packages in Mission Control.

---

## 1. Problem Statement

Shipping notifications arrive fragmented across sources — order confirmation emails, iMessage/SMS from carriers, Apple Pay receipts, and sometimes direct messages from senders. The result is:

- **No single place** to see what's coming and when
- **Duplicate awareness** (email confirmation + SMS notification + delivery alert = 3 records about 1 package)
- **No inferred arrival** when no tracking link is provided
- **No integration with daily planning** (My Day doesn't know a package needs someone home to receive it)

Mission Control already reads Outlook Email and RyMessage. Adding shipment awareness is a natural extension.

---

## 1.1 Scope, Goals, and First Implementation Path

### Goals

- Create a unified shipment view across retailers and carriers
- Turn shipment state changes into Mission Control alerts
- Optionally create action-oriented tasks when delivery requires follow-up
- Support both direct integrations and n8n-relayed events
- Preserve enough metadata for AI queries and future automation

### Non-Goals (Phase 1)

- Building full retailer-specific order management
- Replacing carrier portals with full shipment history UIs
- Supporting every carrier API before initial rollout
- Requiring public internet exposure for Mission Control

### Recommended first implementation

Start with **Home Assistant `mail_and_packages` relayed through n8n inbound webhooks** for fastest time-to-value and lowest operational risk, then add direct polling and carrier API enrichment in later phases.

### Target user-facing states

- `📦 Package arriving today from Amazon`
- `📦 Order shipped from Target`
- `⚠️ Package delivery exception — held at facility`
- `✅ Package delivered — FedEx at front door`

---

## 2. Architecture Overview

```
Sources
  ├── Outlook Email (order confirmations, shipping notifications)
  ├── RyMessage (carrier SMS, sender iMessages)
  └── (future) Amazon connector, Apple Wallet receipts

        ↓  raw alerts (already in DB)

ShipmentExtractor (AI + regex)
  ├── Scans new alerts for shipping signals
  ├── Extracts: tracking number, carrier, item description, sender
  └── Deduplicates by tracking number

        ↓  shipment records

ShipmentTracker (polling service)
  ├── Calls carrier APIs / aggregator API for live status
  ├── Infers expected arrival when not provided
  └── Detects status changes → creates system alerts

        ↓  events

Mission Control UI
  ├── /packages page — full shipments view
  ├── Dashboard widget — "In Transit" summary card
  ├── My Day — "Arriving Today / Tomorrow"
  └── Alert stream — "Delivered", "Out for Delivery", "Delayed"

        ↓  optional bridge

Home Assistant
  ├── Per-package sensor: status, ETA, carrier
  └── Automations: porch light on "Out for Delivery", etc.
```

---

## 3. Data Model

### New Table: `shipments`

```typescript
export const shipments = sqliteTable('shipments', {
  id: text('id').primaryKey(),

  // Identification
  trackingNumber: text('tracking_number').notNull(),   // normalized (uppercase, no spaces)
  carrier: text('carrier'),                             // usps | fedex | ups | dhl | amazon | other
  carrierConfidence: real('carrier_confidence'),        // 0-1, from detection

  // Description (human-readable)
  description: text('description'),   // "iPhone Case from Amazon", "Package from Mom"
  sender: text('sender'),             // extracted name / merchant

  // Status
  status: text('status').notNull().default('pending'),
  // Values: pending | in_transit | out_for_delivery | delivered | exception | unknown

  statusDetail: text('status_detail'), // "In transit — arrived Denver, CO sort facility"
  statusUpdatedAt: text('status_updated_at'),

  // Dates
  shippedAt: text('shipped_at'),
  expectedArrival: text('expected_arrival'),            // ISO date YYYY-MM-DD
  expectedArrivalSource: text('expected_arrival_source'),
  // Values: api | ai_inferred | message_text | carrier_heuristic
  expectedArrivalConfidence: real('expected_arrival_confidence'), // 0-1

  actualArrival: text('actual_arrival'),

  // Sources — tracking back to originating alerts
  sourceAlertIds: text('source_alert_ids', { mode: 'json' }).notNull().default('[]'),
  // array of alert.id values; multiple = same package detected from multiple messages

  // Tracking history (JSON array of {timestamp, status, detail, location})
  trackingHistory: text('tracking_history', { mode: 'json' }).notNull().default('[]'),

  // Polling
  lastPolledAt: text('last_polled_at'),
  pollIntervalMinutes: integer('poll_interval_minutes').notNull().default(60),
  pollEnabled: integer('poll_enabled', { mode: 'boolean' }).notNull().default(true),

  // Metadata
  externalTrackingUrl: text('external_tracking_url'),
  metadata: text('metadata', { mode: 'json' }).notNull().default('{}'),
  // Stores raw API response, AI extraction context, etc.

  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});
```

### Alert Integration

The existing `alerts` table gains a `shipmentId` link (optional migration):

```typescript
// Added to alerts table
shipmentId: text('shipment_id'),
```

No schema change required immediately — the link is stored in `shipments.sourceAlertIds`.

---

## 4. AI Extraction — ShipmentExtractor

### Trigger

On every sync, new alerts are passed through the extractor. The extractor runs:
1. **Regex pre-filter** — cheap check for tracking number patterns before spending AI tokens
2. **AI extraction** — structured output for confirmed hits, ambiguous cases, and false positives

### Tracking Number Patterns (Regex)

```typescript
const TRACKING_PATTERNS = {
  usps: /\b(9[24][0-9]{20}|9[234][0-9]{18}[0-9]{2})\b/,
  // USPS 22-digit numbers starting with 92, 94, 93, 95
  
  fedex: /\b([0-9]{12}|[0-9]{15}|[0-9]{20,22})\b/,
  // FedEx 12, 15, or 20-22 digit numbers

  ups: /\b(1Z[A-Z0-9]{16})\b/i,
  // UPS always starts with 1Z

  dhl: /\b([0-9]{10}|[0-9]{12}|JD[0-9]{18}|[A-Z]{3}[0-9]{10})\b/,
  
  amazon: /\bTBA[0-9]{9,12}\b/i,
  // Amazon Logistics
  
  ontrac: /\bC[0-9]{14}\b/,
};
```

### AI Extraction Prompt

```
You are a package detection assistant. Given the following message or email body, determine if it contains shipping or delivery information.

If it does, extract in JSON:
{
  "hasShipping": true,
  "trackingNumber": "...",          // null if not present
  "carrier": "usps|fedex|ups|dhl|amazon|ontrac|other",  // null if unknown
  "carrierConfidence": 0.9,         // how confident are you in carrier detection
  "description": "...",             // human description of what's being shipped
  "sender": "...",                  // merchant or person name
  "expectedArrival": "YYYY-MM-DD",  // null if not mentioned
  "expectedArrivalSource": "message_text",  // how you determined the date
  "expectedArrivalConfidence": 0.85,
  "shippingStatus": "shipped|in_transit|out_for_delivery|delivered|unknown"
}

If it does not contain shipping info, return: { "hasShipping": false }
```

### Confidence Thresholds

| Confidence | Action |
|------------|--------|
| ≥ 0.85     | Auto-create shipment, no user action needed |
| 0.60–0.84  | Create shipment with `needs_review` flag → surfaces in UI for confirmation |
| < 0.60     | Skip, but log to debug table |

---

## 5. Carrier APIs — Free Options

### Recommended: AfterShip (Primary)

- **Free tier**: 100 shipments/month (generous for personal use)
- **Carriers supported**: 1,000+
- **REST API**: Clean, well-documented
- **Auto-detection**: Send tracking number, it auto-detects carrier
- **Response fields**: `tag` (status), `expected_delivery`, `checkpoints[]`
- **Webhook support**: Can push updates instead of polling
- **Home Assistant**: Has an [official integration](https://www.home-assistant.io/integrations/aftership/) built in

```typescript
// AfterShip API call
const res = await fetch('https://api.aftership.com/v4/trackings', {
  method: 'POST',
  headers: {
    'as-api-key': process.env.AFTERSHIP_API_KEY,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    tracking: {
      tracking_number: trackingNumber,
      // optionally: slug: 'usps' to hint carrier
    }
  })
});
```

### Alternative: 17track

- **Free tier**: 100 requests/day
- **Carriers**: 2,500+, strong for international
- **API**: Requires registration at https://api.17track.net
- **Good for**: AliExpress, international orders where AfterShip struggles

### Alternative: Trackingmore

- **Free tier**: 300+ carriers, limited monthly queries
- **Good for**: Fallback when AfterShip limit is reached

### Direct Carrier APIs (Free, No Limits for Personal)

| Carrier | API | Notes |
|---------|-----|-------|
| USPS | [USPS Web Tools](https://www.usps.com/business/web-tools-apis/) | Completely free, just register |
| UPS | [UPS Developer Kit](https://developer.ups.com) | Free developer tier |
| FedEx | [FedEx API](https://developer.fedex.com) | Free sandbox + production |
| DHL | [DHL Express](https://developer.dhl.com) | Free for tracking |

**Recommendation**: Use AfterShip as the primary aggregator (auto-detects carrier, handles 1000+ carriers, has HA integration). Fall back to direct carrier APIs for USPS/UPS/FedEx to avoid hitting the AfterShip limit.

### Self-Hosted / Home Lab

- **n8n** (already in ecosystem): Build an n8n workflow that polls AfterShip/carrier APIs on a schedule and POSTs updates to a Mission Control webhook. This avoids embedding API polling logic in the Next.js app and gives you visual retry/error handling.
- **Node-RED**: Alternative workflow engine, similar capability, natively embedded in many home lab setups.

---

## 6. Deduplication Strategy

### Primary Dedup: Tracking Number Match

When a new extraction produces a tracking number, normalize it first:

```typescript
function normalizeTracking(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}
```

If a shipment with this normalized tracking number already exists:
- Add the new `alertId` to `sourceAlertIds[]`
- Update `description` if the new source has a better one (longer, more specific)
- Update `carrier` if current is `null` or `other`
- **Do not create a new record**

### Secondary Dedup: No Tracking Number

If no tracking number is detected but shipping info is present (e.g., "I mailed you something"), use AI similarity:
- Compare `sender` + approximate ship date within a 3-day window
- If similarity ≥ 0.8 → merge into existing record
- Otherwise → create new with a `needs_review` flag and surface for manual merge

### Dedup on Status Updates

If two alerts carry the same tracking number but different statuses (e.g., "shipped" email + "delivered" SMS), keep the most recent status and append both to `trackingHistory`.

---

## 7. Expected Arrival Inference

### Hierarchy (best to worst)

1. **Tracking API response** (`expected_delivery` field from AfterShip/carrier)
2. **Message text** (AI-extracted "arrives by Friday", "expected December 15")
3. **Carrier + service heuristics** (if we know the carrier and approximate ship date):

```typescript
const TRANSIT_DAYS: Record<string, Record<string, number>> = {
  usps: { 'priority_mail': 2, 'first_class': 3, 'parcel_select': 6, 'default': 5 },
  fedex: { 'overnight': 1, '2day': 2, 'ground': 5, 'default': 4 },
  ups: { 'next_day': 1, '2day': 2, 'ground': 5, 'default': 4 },
  dhl: { 'express': 2, 'default': 5 },
  amazon: { 'prime': 2, 'default': 4 },
};
```

4. **AI fallback**: Given sender, origin, item type — estimate transit (low confidence, shown as "~")

### Confidence Display

Show confidence visually in the UI:
- ✅ Green (high confidence): API-confirmed date
- 🟡 Yellow (medium): Extracted from message text
- 🔵 Blue (inferred): Carrier heuristic
- ⚪ Gray (low/unknown): AI estimate, show as "~Dec 20"

---

## 8. Home Assistant Integration

### Option A: AfterShip HA Integration (Easiest)

HA has a [built-in AfterShip integration](https://www.home-assistant.io/integrations/aftership/). If you're already using AfterShip for tracking in Mission Control, configure the same API key in HA:

```yaml
# configuration.yaml
sensor:
  - platform: aftership
    api_key: !secret aftership_key
```

This creates sensors like `sensor.aftership` with attributes per shipment.

**Limitation**: You have to manually add tracking numbers to AfterShip's dashboard (or via API). Mission Control can automate this — when it detects a new shipment, call the AfterShip API to register it, which then propagates to HA automatically.

### Option B: Mission Control → HA Webhook (Most Flexible)

Mission Control can push shipment state changes directly to HA via the HA REST API:

```typescript
// When a shipment status changes:
await fetch(`${HA_URL}/api/webhook/shipment_update`, {
  method: 'POST',
  headers: { Authorization: `****** },
  body: JSON.stringify({
    tracking_number: shipment.trackingNumber,
    carrier: shipment.carrier,
    status: shipment.status,
    expected_arrival: shipment.expectedArrival,
    description: shipment.description,
  })
});
```

In HA, create a webhook automation that:
- Creates/updates a helper entity per shipment
- Triggers the "porch light" automation when status is `out_for_delivery`
- Sends a TTS announcement when status changes to `delivered`

### Option C: n8n Bridge (Recommended for Reliability)

Since n8n is already in the Mission Control architecture:

```
MC shipment DB  →  n8n "Shipment Status" workflow
                      ├── Poll AfterShip API (every 30min)
                      ├── POST to MC webhook (/api/webhooks/shipments)
                      └── POST to HA webhook (on status change)
```

This keeps the polling logic outside the Next.js process (no cron in the app layer), and n8n handles retries and errors natively.

### HA Automations You Can Build

| Trigger | Action |
|---------|--------|
| Status → `out_for_delivery` | Turn on porch light, push notification |
| Status → `delivered` | Announce "A package was delivered" via TTS, lock/camera notification |
| Expected today + no one home | Reminder notification |
| Status → `exception` (delay) | Push alert to phone |
| Carrier arrives (time-window + status) | Arm ring doorbell snapshot |

---

## 9. UI Design

### 9.1 New Page: `/packages`

Full shipment management view — see mockup: `docs/mockups/mockup-shipments.html`

**Sections:**
- **Status tabs**: All | In Transit | Arriving Soon | Delivered
- **Active shipments list** with per-card: carrier badge, description, status, ETA, progress bar
- **Detail panel** (slide-in): full tracking history timeline, source messages, manual actions
- **Quick Add**: Paste a tracking number manually

### 9.2 Dashboard Widget

New "Packages" stat card on the dashboard (alongside Open Tasks, Overdue, etc.)

On the dashboard's right panel (or bottom section): "Arriving Soon" list showing packages expected in the next 3 days.

See mockup: `docs/mockups/mockup-dashboard-packages.html`

### 9.3 My Day Integration

"Arriving Today" section in the My Day view — shown only if ≥1 package is expected today. Styled like a calendar event block.

### 9.4 Alert Stream Integration

Status change events from the tracking service create system alerts with category `shipment`:

- 📦 "Out for delivery: MacBook Pro adapter" — severity: high (time-sensitive)
- ✅ "Delivered: Package from Dad" — severity: info
- ⚠️ "Delayed: iPhone case — new ETA Dec 22" — severity: medium

### 9.5 Navigation

Add a "📦 Packages" nav item between "Kanban" and "Timeline". Show a badge count for "arriving today" or "action needed" shipments.

---

## 10. Phased Implementation Plan

### Phase 1 — Detection & Storage (Week 1-2)

**Goal**: Passively detect shipments from existing sources, no tracking API yet.

- [ ] Add `shipments` table to Drizzle schema
- [ ] Create `ShipmentExtractor` service (`src/lib/shipments/extractor.ts`)
  - Regex pre-filter for tracking numbers
  - AI extraction prompt with structured output
  - Confidence thresholds
- [ ] Wire extractor into existing sync cycle (run after alert ingestion)
- [ ] Deduplication logic (normalize tracking number, merge sources)
- [ ] API route: `GET /api/shipments`, `POST /api/shipments` (manual add)
- [ ] Basic `/packages` page — list view only, no live tracking
- [ ] Mockup reviewed → final UI implementation

**Outcome**: You can see a list of detected packages with their AI-extracted descriptions and initial arrival estimates from message text. No live tracking yet.

---

### Phase 2 — Live Tracking (Week 3-4)

**Goal**: Connect to AfterShip (or direct carrier APIs) for real-time status.

- [ ] AfterShip connector (`src/lib/shipments/trackers/aftership.ts`)
  - Register new shipments on detection
  - Poll status (every 60 min while in transit, every 15 min when out for delivery)
  - Parse checkpoint history
- [ ] USPS direct API fallback (`src/lib/shipments/trackers/usps.ts`)
  - Free, no rate limits — use for all USPS packages
- [ ] `ShipmentTracker` polling service with adaptive intervals
- [ ] Status change detection → create system alerts
- [ ] Expected arrival updates when API provides new estimates
- [ ] Settings: AfterShip API key, polling intervals, per-carrier preference
- [ ] `/packages` page updated with live status, tracking timeline

**Outcome**: Full live tracking with status updates surfaced as alerts. Expected arrival date automatically updated when it changes.

---

### Phase 3 — Intelligence & Integration (Week 5-6)

**Goal**: Make the system proactively useful.

- [ ] "Arriving Today" widget in My Day view
- [ ] Dashboard stat card + "Arriving Soon" panel
- [ ] Alert stream integration (shipment status changes appear in main alert feed)
- [ ] AI arrival inference for packages without tracking API data
  - Use carrier + ship date + service level to estimate
  - Show confidence indicator
- [ ] n8n workflow for polling (replace in-process cron with n8n)
- [ ] Manual merge UI — for packages where auto-dedup couldn't match
- [ ] Date change tracking ("Originally expected Dec 18 → now Dec 22")

**Outcome**: Shipments are first-class citizens in Mission Control. Packages surfaced in My Day and dashboard.

---

### Phase 4 — Home Assistant & Automation (Week 7-8)

**Goal**: Bridge to HA and automate delivery responses.

- [ ] n8n → HA webhook bridge workflow
  - On `out_for_delivery`: trigger HA automation
  - On `delivered`: trigger HA automation, mark shipment as complete
- [ ] HA configuration template (YAML snippet) in docs
- [ ] AfterShip HA integration setup guide
- [ ] Mission Control → AfterShip auto-registration (so HA sensors stay in sync)
- [ ] "Delivered" confirmation flow — user can mark delivered + add notes
- [ ] Historical analytics: average delivery times per carrier, on-time rate

**Outcome**: Package delivery integrates with the physical home. Porch lights, notifications, doorbell camera triggers all automated.

---

## 11. Open Questions / Decisions Needed

1. **AfterShip free limit** (100/month): Sufficient for personal use? If regularly ordering more, prefer direct carrier APIs (USPS, UPS, FedEx are all free and unlimited for personal use).

2. **RyMessage action type for shipping**: Should the `ShipmentExtractor` add a `shipping` action type to the RyMessage `actionType` enum, or keep shipments a separate extraction layer? Recommendation: keep separate — shipments are a different entity from tasks/alerts.

3. **Polling in-app vs n8n**: Phase 2 can use the existing `node-cron` scheduler in the app. Phase 4 moves it to n8n. Is this sequencing acceptable?

4. **Manual tracking numbers**: Users often know a tracking number before Mission Control sees it. The `/packages` quick-add should accept a paste-in tracking number + optional description.

5. **Privacy of tracking history**: Tracking numbers, carrier data, and sender names are personal. The self-hosted relational backend keeps this data inside the configured deployment unless you opt into AfterShip or n8n.

---

## 12. Free Services Summary

| Service | Type | Free Tier | Best For |
|---------|------|-----------|----------|
| AfterShip | SaaS tracking aggregator | 100 shipments/month | Single API for 1000+ carriers |
| 17track | SaaS tracking aggregator | 100 req/day | International, AliExpress |
| USPS Web Tools | Direct carrier API | Unlimited (free registration) | All USPS packages |
| UPS Developer | Direct carrier API | Free tier | UPS packages |
| FedEx API | Direct carrier API | Free developer | FedEx packages |
| n8n (self-hosted) | Workflow engine | Free forever | Polling orchestration, HA bridge |
| Home Assistant | Home automation | Free (self-hosted) | HA sensor + automations |
| AfterShip HA integration | HA built-in | Free (needs AfterShip account) | Package sensors in HA |

**Recommended starting stack**: AfterShip API (free) + USPS Web Tools (free) + n8n for orchestration + HA AfterShip integration.
