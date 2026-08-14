---
title: "Package Delivery Tracking"
status: proposed
created: 2026-07-10
last_reviewed: 2026-07-22
category: design
priority: "High-value quality-of-life integration"
recommendation: "Home Assistant `mail_and_packages` via n8n inbound webhook"
related:
  - "[Shipment Tracking](SHIPMENT-TRACKING-DESIGN.md)"
  - "[Dashboard KPI Customization](DASHBOARD-KPI-CUSTOMIZATION.md)"
  - "[Future Integrations](FUTURE-INTEGRATIONS.md)"
mockups:
  - "[mockup-dashboard-packages.html](../mockups/mockup-dashboard-packages.html)"
---

# Package Delivery Tracking Design

---

## Overview

Mission Control should track packages from order placement through delivery and surface the meaningful moments as alerts and optional tasks without the user needing to check carrier websites, retailer order pages, or email threads manually.

Core outcomes:

- Surface **"Order shipped"**
- Surface **"Package arriving today"**
- Surface **"Package delivered"**
- Surface **delivery exceptions** like delays, holds, or failed attempts
- Let the AI assistant answer questions like **"When is my Amazon order arriving?"**

The best version of this feature combines multiple sources over time, but the initial design should optimize for the easiest, most reliable integration path.

---

## Goals

- Create a unified shipment view across retailers and carriers
- Turn shipment state changes into Mission Control alerts
- Optionally create action-oriented tasks when delivery requires follow-up
- Support both direct integrations and n8n-relayed events
- Preserve enough metadata for AI queries and future automation

## Non-Goals

- Building full retailer-specific order management in phase 1
- Replacing carrier portals with pixel-perfect shipment history UIs
- Supporting every carrier API before initial rollout
- Requiring public internet exposure for Mission Control

---

## User Experience

### Example alert states

- `📦 Package arriving today from Amazon`
- `📦 Order shipped from Target`
- `⚠️ Package delivery exception — held at facility`
- `✅ Package delivered — FedEx at front door`

### Example optional tasks

- `Bring in package from porch`
- `Check mailbox for USPS delivery`
- `Reschedule held package pickup`

### Example AI queries

- `When is my Amazon order arriving?`
- `What packages are coming today?`
- `Did my FedEx package get delivered yet?`

---

## Data Sources (ranked by integration ease)

## 1) Home Assistant `mail_and_packages` integration (PRIMARY)

This is the recommended first integration point because it already consolidates multiple carrier systems and is available through a simple REST interface.

### Why it is the best phase 1 source

- Already tracks **USPS Informed Delivery**
- Already tracks **UPS My Choice**
- Already tracks **FedEx Delivery Manager**
- Centralizes package state into Home Assistant entities
- Avoids separate carrier API onboarding for the first release
- Works well with n8n as middleware if Mission Control should not talk to Home Assistant directly

### Expected entity patterns

- `sensor.mail_usps_packages`
- `sensor.mail_ups_packages`
- `sensor.mail_fedex_packages`
- Other `mail_and_packages` entities depending on Home Assistant configuration

### Home Assistant API access

- Endpoint: `GET /api/states/{entity_id}`
- Example: `http://{ha_url}/api/states/sensor.mail_usps_packages`
- Auth header: `Authorization: Bearer {token}`

### Data available from attributes

Typical attributes may include:

- Tracking numbers
- Carrier
- Delivery status
- Estimated delivery date
- Delivered date
- Package counts
- Human-readable descriptions from carrier feeds

### Recommendation

Start by mapping Home Assistant package entities into normalized shipment records. This provides immediate value with minimal custom parsing logic.

---

## 2) Email parsing (via existing Outlook connector)

Mission Control already ingests Outlook data, making order and shipping email parsing the next easiest expansion.

### Target email types

- Order confirmations
- Shipping confirmations
- Delivery updates
- Delivery exception notices

### Priority senders / ecosystems

- Amazon
- Walmart
- Target
- eBay
- Etsy
- Direct retailer emails

### Extraction targets

- Order number
- Estimated delivery date
- Tracking number
- Carrier
- Retailer
- Item description
- Order URL

### Extraction approach

- Use rules and sender heuristics for cheap pre-filtering
- Use the existing AI infrastructure for structured extraction from email body content
- Store raw extraction metadata for review and later reprocessing

### Value of this source

Email parsing captures shipment context earlier than carrier feeds, especially at the **ordered** and **shipped** stages.

---

## 3) Carrier APIs (future / advanced)

These add richer, more direct tracking but require more integration effort and credential management.

Potential sources:

- USPS Web Tools API
- UPS Tracking API
- FedEx Track API
- 17track / AfterShip aggregator APIs

### When to add them

- If Home Assistant coverage is incomplete
- If more granular real-time history is needed
- If email parsing finds tracking numbers before Home Assistant does
- If the user wants carriers not covered by current Home Assistant setup

---

## 4) Shopping site integrations (future)

Potential sources:

- Amazon order history
- SHOP app API, if available
- Other retailer-specific order feeds

### Tradeoffs

- Often require scraping or unofficial APIs
- More brittle than Home Assistant or email-based approaches
- Best treated as later-stage enrichment, not an initial dependency

---

## Canonical Data Model

Mission Control should normalize all shipment sources into a single table.

```sql
shipments table:
  id, carrier, trackingNumber, status (ordered|shipped|in_transit|out_for_delivery|delivered|exception)
  orderedAt, shippedAt, estimatedDelivery, deliveredAt
  retailer, orderNumber, orderUrl
  description (what was ordered)
  source (home-assistant|email-parse|manual|n8n)
  lastCheckedAt, metadata (JSON)
```

### Suggested field semantics

| Field | Purpose |
|---|---|
| `id` | Internal unique identifier |
| `carrier` | Normalized carrier slug such as `usps`, `ups`, `fedex`, `amazon-logistics`, `unknown` |
| `trackingNumber` | Canonical tracking number used for dedupe |
| `status` | User-facing lifecycle state |
| `orderedAt` | Order placed timestamp, usually from email parsing |
| `shippedAt` | First confirmed shipped timestamp |
| `estimatedDelivery` | Best-known expected delivery timestamp or date |
| `deliveredAt` | Final delivered timestamp |
| `retailer` | Merchant or source store |
| `orderNumber` | Merchant order ID |
| `orderUrl` | Link to order detail page if known |
| `description` | Human-readable item summary |
| `source` | Origin of the latest or canonical shipment record |
| `lastCheckedAt` | Most recent polling or reconciliation time |
| `metadata` | Raw source payloads, confidence scores, location text, proof-of-delivery notes, and merge history |

### Status normalization

Normalize provider-specific values into:

- `ordered`
- `shipped`
- `in_transit`
- `out_for_delivery`
- `delivered`
- `exception`

### Deduplication strategy

Primary key for matching:

1. Tracking number
2. Retailer + order number
3. Fuzzy match on retailer + description + estimated delivery date

Store source-specific payloads in `metadata` so multiple upstream records can collapse into a single shipment entity without data loss.

---

## Integration with Mission Control

Shipments should become first-class timeline and alert inputs.

## Alerts

Create shipment-backed alerts with category `shipment`.

Examples:

- `📦 Package arriving today from Amazon` — severity `info`
- `⚠️ Package delivery exception — held at facility` — severity `medium`
- `✅ Package delivered — FedEx at front door` — severity `info`, auto-dismiss after 24h

### Alert generation rules

- Emit on meaningful status transitions only
- Avoid repeating unchanged carrier states every poll
- Use delivery-date proximity to create proactive alerts, not only reactive ones
- Auto-dismiss informational delivered alerts after 24 hours

## Tasks

Optionally generate tasks for actionable delivery follow-up.

Examples:

- `Bring in package from porch`
- `Pick up package held at facility`

Task creation should be configurable because some users will want awareness-only notifications while others want explicit follow-up reminders.

## My Day timeline

Expected deliveries should appear in My Day as time-sensitive items, especially:

- arriving today
- arriving tomorrow
- delivered today
- exception / action needed

## AI assistant

Shipment data should be queryable by the assistant so it can answer:

- delivery ETA questions
- retailer-specific order questions
- what-is-arriving-today summaries
- whether a package was delivered

---

## Home Assistant Integration Specifics

## API shape

- Endpoint: `http://{ha_url}/api/states/{entity_id}`
- Auth: `Authorization: Bearer {token}`

## Polling behavior

- Default poll interval: every 30 minutes
- Faster updates can be achieved through n8n webhook relays on state change

## Entities to monitor

Configurable in Settings, with defaults based on:

- `sensor.mail_*_packages*`

### Connector behavior

1. Load configured entity IDs or patterns
2. Resolve matching entities
3. Fetch current state payloads
4. Extract individual package entries from entity attributes
5. Normalize into `shipments`
6. Compare with prior snapshot
7. Emit alerts/tasks for meaningful changes

### Notes on reliability

- Home Assistant may expose aggregate counts and per-package detail differently depending on integration version
- Mission Control should tolerate partial data and preserve raw payloads in `metadata`
- Entity-to-package parsing should be adapter-based so it can evolve without schema churn

---

## n8n Integration

n8n is a strong bridge for shipment events, especially when Home Assistant is already connected there.

## Event flow

```text
Home Assistant → n8n → Mission Control
```

### Pattern

- n8n watches Home Assistant state changes via webhook or polling
- When package status changes, n8n calls:
  - `POST /api/integrations/n8n/webhook`
- Payload type:
  - `shipment.update`

### Why this is attractive

- Avoids direct Mission Control ↔ Home Assistant connectivity
- Reuses the existing n8n integration model
- Enables near-real-time updates without shortening Mission Control polling intervals
- Lets n8n perform transformation and filtering before forwarding

### Suggested webhook payload

```json
{
  "type": "shipment.update",
  "source": "home-assistant",
  "occurredAt": "2026-07-05T18:30:00Z",
  "shipment": {
    "carrier": "fedex",
    "trackingNumber": "123456789012",
    "status": "out_for_delivery",
    "estimatedDelivery": "2026-07-05",
    "deliveredAt": null,
    "retailer": "Amazon",
    "description": "Office supplies"
  },
  "metadata": {
    "entityId": "sensor.mail_fedex_packages"
  }
}
```

---

## Recommended Architecture

### Phase 1 recommendation

Implement shipment ingestion through the existing n8n inbound webhook, using Home Assistant as the upstream source.

Why:

- Lowest implementation risk
- Fastest time to visible value
- No direct HA credentials required inside Mission Control if n8n is the relay
- Builds directly on the n8n integration already planned

### Direct Home Assistant connector

Add direct Home Assistant polling as the next step for users who want Mission Control to operate independently of n8n.

### Email parsing

Use email parsing to enrich early shipment lifecycle stages:

- `ordered`
- `shipped`
- estimated delivery
- retailer context

### Carrier APIs

Add only after the normalized shipment model and alert flow are stable.

---

## Implementation Phases

## Phase 1 — n8n inbound webhook for shipment events

- Build on the existing n8n integration
- Accept `shipment.update` payloads
- Upsert normalized shipment records
- Generate shipment alerts from status transitions

## Phase 2 — Home Assistant direct polling connector

- Add Home Assistant settings
- Poll configured `mail_and_packages` entities every 30 minutes
- Normalize entities into shipment records
- Reuse the same alert-generation pipeline as phase 1

## Phase 3 — Email parsing for order detection

- Detect order confirmation and shipping emails
- Extract structured shipment data with AI assistance
- Link email-derived shipments with carrier-derived shipments using dedupe rules

## Phase 4 — Carrier API lookups for richer real-time tracking

- Add optional carrier credentials
- Use direct carrier or aggregator APIs for advanced history and higher freshness
- Fill gaps where HA and email ingestion are insufficient

---

## Settings UI

Two configuration modes should be supported.

## Option A — Home Assistant direct connection

Settings fields:

- Home Assistant URL
- Home Assistant access token
- Entity ID patterns

Defaults:

- `sensor.mail_*_packages*`

## Option B — n8n relay only

No direct Home Assistant connection required.

Settings fields:

- n8n webhook integration enabled
- trusted source configuration / secret if applicable

This should likely be the default recommendation for users already running n8n in a homelab setup.

---

## Operational Considerations

### Freshness

- 30-minute polling is sufficient for most package awareness
- Use n8n or future push integrations for near-real-time delivery updates

### Security

- Store HA access tokens securely
- Validate n8n inbound webhook authenticity if exposed beyond localhost
- Preserve raw carrier metadata carefully but avoid leaking secrets into logs

### Resilience

- Treat missing fields as normal
- Make parsing adapters tolerant of Home Assistant integration changes
- Use idempotent upserts so duplicate webhook deliveries do not create duplicate alerts

---

## Success Criteria

This design is successful when Mission Control can:

- show what packages are expected today
- show when something shipped or was delivered
- capture delivery exceptions
- answer simple shipment questions in the assistant
- do all of the above without the user visiting individual carrier sites

---

## Final Recommendation

Start with **Home Assistant `mail_and_packages` as the primary source**, ideally relayed through **n8n inbound shipment webhooks** for the first implementation. Expand later with **email parsing** for early order visibility and **carrier APIs** only when deeper tracking fidelity is needed.
