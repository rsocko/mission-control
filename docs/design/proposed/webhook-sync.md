---
title: "Webhook Sync Architecture (Future)"
status: deferred
created: 2026-07-10
last_reviewed: 2026-07-22
category: design
scope: "Real-time inbound webhook sync from external providers"
recommendation: "Continue using polling, or use n8n as a public relay"
related:
  - "[Connector Settings](CONNECTOR-SETTINGS-DESIGN.md)"
  - "[Task Sync Integration](../reference/TASK-SYNC-INTEGRATION.md)"
  - "[Connector Expansion Review](CONNECTOR-EXPANSION-REVIEW.md)"
mockups: []
---

# Webhook Sync Architecture (Future)

---

## Overview

Mission Control currently works well as a locally run app because connectors poll external systems on an interval and do not require Mission Control itself to be reachable from the public internet.

This document captures a future architecture for **real-time sync via inbound webhooks** from providers like Microsoft Graph and GitHub. This is explicitly **future/advanced** functionality and should not be treated as a current implementation requirement.

---

## Current Architecture

Today, all connectors use polling.

### Characteristics

- Configurable sync interval
- Default polling cadence: **5 minutes**
- No inbound public endpoint required
- Works naturally for localhost and homelab deployments

### Why polling is acceptable now

- Simpler operational model
- No public network exposure
- Good enough latency for current Mission Control scale
- Easier local development and troubleshooting

For current usage patterns, polling is the right default.

---

## Future Webhook Architecture

Webhooks provide event-driven updates instead of periodic polling.

### The challenge

Webhook providers need to call **your** endpoint:

- Microsoft Graph change notifications:
  - `POST https://your-app/api/webhooks/microsoft`
- GitHub webhooks:
  - `POST https://your-app/api/webhooks/github`

Because Mission Control runs on localhost, this creates a deployment challenge: external systems cannot reach a local-only app without an internet-accessible bridge.

---

## Exposure Options

If direct webhook delivery is ever needed while Mission Control is local, one of these patterns is required.

## 1) Cloudflare Tunnel

Expose specific routes using `cloudflared`.

### Pros

- Strong production-grade tunnel option
- Can expose only selected routes
- Good long-running fit for homelab use

### Cons

- Extra infrastructure to configure and maintain
- Still means Mission Control has public ingress

---

## 2) Tailscale Funnel

Expose selected routes through Tailscale.

### Pros

- Nice fit for users already invested in Tailscale
- Good ergonomics for homelab environments

### Cons

- Additional networking dependency
- Public ingress considerations still apply

---

## 3) ngrok

Useful mainly for development and testing.

### Pros

- Fast to set up
- Good for validating webhook flows quickly

### Cons

- Best suited for temporary environments
- Less attractive as a long-term architecture

---

## 4) n8n as relay (RECOMMENDED)

```text
GitHub / Microsoft Graph → n8n (public endpoint) → Mission Control (localhost)
```

This is the best near-term answer for real-time behavior without changing Mission Control's deployment model.

### Why this is recommended

- n8n already handles webhook reception well
- n8n is already deployed in the HomeLab with public access
- n8n can transform, filter, and authenticate inbound events
- Mission Control only needs to receive a local POST on its existing n8n integration endpoint
- Avoids exposing Mission Control directly to the internet

### Recommended flow

1. Provider sends webhook to n8n public endpoint
2. n8n validates and parses provider payload
3. n8n extracts only the relevant event data
4. n8n forwards normalized payload to:
   - `POST /api/integrations/n8n/webhook`

### Practical benefit

No additional Mission Control webhook receiver surface is required beyond the n8n integration already planned or implemented.

---

## Alternative: Direct Webhook Receivers

If Mission Control is ever cloud-hosted, or if a durable tunnel becomes part of the product architecture, direct webhook receivers become more reasonable.

### Endpoints that would be needed

- `POST /api/webhooks/microsoft`
- `POST /api/webhooks/github`

These receivers should be considered optional future infrastructure, not current roadmap requirements.

---

## Microsoft Graph webhook specifics

If Mission Control ever handles Graph notifications directly, it will need to support the full Microsoft subscription lifecycle.

### Key requirements

- Create subscriptions via:
  - `POST https://graph.microsoft.com/v1.0/subscriptions`
- Support validation token echo during subscription setup
- Renew subscriptions on schedule because they expire
- Process change notifications that either:
  - include `resourceData`, or
  - require follow-up delta queries

### Operational complexity

- Subscription expiry is short for many resource types
- Renewal automation is mandatory
- Validation handshake must be implemented correctly
- Some notifications are only pointers, not full data payloads

### Important note

For many Graph resources, max subscription lifetime is about **3 days**, so Mission Control would need a reliable renewal cron and failure monitoring.

---

## GitHub webhook specifics

GitHub direct webhooks are simpler than Graph subscriptions but still require public ingress and signature verification.

### Configuration

- Configure in repository **Settings → Webhooks**

### Security

- Verify `X-Hub-Signature-256` using HMAC-SHA256

### Likely events

- `issues`
- `pull_request`
- `issue_comment`

### Receiver responsibilities

- validate signature
- parse event type
- normalize payload into Mission Control records
- deduplicate retries
- return fast acknowledgements

---

## Decision: Defer Implementation

Direct webhook receivers should be deferred.

### Reasons

- Polling works well at current scale
- Mission Control is optimized for local execution
- Public endpoint exposure adds operational and security overhead
- n8n relay already covers most real-time needs without custom receiver code

### Thresholds that would justify revisiting

Direct webhook support becomes more compelling if:

- polling latency becomes unacceptable
- Mission Control moves to cloud hosting
- a provider exposes critical data only via webhooks
- the product grows beyond current local-first assumptions

---

## Status

## DEFERRED

This document exists for future reference only.

The current recommendation is:

1. Keep polling as the default architecture
2. Use **n8n as a relay** when real-time behavior is needed
3. Only build direct webhook endpoints if Mission Control becomes internet-reachable by design

---

## Summary

Mission Control does **not** need direct webhook infrastructure today. Polling remains the correct architecture for a localhost-first app, and **n8n provides an adequate real-time bridge** without requiring Mission Control to expose public endpoints.
