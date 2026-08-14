---
title: "Mobile UI — Remaining Gaps & Phase 2+ Roadmap"
status: superseded
created: 2026-07-23
last_reviewed: 2026-07-31
category: design
related:
  - "[Mobile Companion](mobile-companion.md)"
---

# Mobile UI — Remaining Gaps & Phase 2 Roadmap

> **Superseded:** Most items in this snapshot have been implemented. Current
> responsive-PWA scope is tracked in
> [`mobile-ios-execution-plan.md`](../active/mobile-ios-execution-plan.md), and
> the native five-phase release path is tracked in
> [`mobile-ios-wrapper-distribution.md`](mobile-ios-wrapper-distribution.md).
> Open triage/Quick Sort refinements are parallel enhancements rather than a
> blanket blocker for native scaffolding.

## Context

Phase 1 (implemented) made the app usable from mobile:
- Priority Wizard scrollable/dismissible on small screens
- Mobile bottom tab bar (Today / Triage / Capture / Inbox / More)
- Desktop chrome hidden on mobile (toolbar, sidebar, alerts panel)
- Quick Capture page (`/capture`)
- Today page stacks vertically, task detail in slide-up sheet
- Pull-to-refresh on Today view

This document catalogs everything still needed for a **polished mobile companion** experience.

---

## 1. Navigation & Routing Gaps

### 1.1 Inbox Tab Points to Full Dashboard
**Current:** Bottom tab "Inbox" routes to `/` which is the full desktop dashboard.
**Needed:** A dedicated mobile inbox view showing newly-synced and recently-captured items in a simple list. Touch-optimized, no sidebar.

### 1.2 "More" Tab Is Just Settings
**Current:** Routes to `/settings`.
**Needed:** A mobile "More" hub page with links to: Kanban, Goals, Insights, Timeline, Routines, AI Assistant, Settings. Similar to iOS Settings-style list.

---

## 2. Triage Page — Mobile Optimization

### 2.1 Card Stack Layout
**Current:** Desktop filter sidebar + gallery/list views render on mobile.
**Needed:** Single-card "stack" view optimized for mobile (one item at a time, full-width card).

### 2.2 Swipe Gesture Actions
**Current:** No gesture support.
**Needed:** Swipe up=Keep, right=Plan, left=Defer, down=Archive (per mockup). Use `motion/react` drag gestures.

### 2.3 Session Progress Bar
Show triage session progress (X/N processed) as a compact mobile-friendly bar.

---

## 3. Today Page — Mobile Enhancements

### 3.1 Suggestions Section
**Current:** Suggestions sidebar hidden on mobile.
**Needed:** A collapsible "Suggestions" section at the bottom of the Today list (Yesterday carry-forwards, Overdue, AI picks).

### 3.2 Mobile Task Rows
**Current:** Uses same density as desktop.
**Needed:** Slightly larger row height (min 48px), bigger checkbox hit area, swipe-right-to-complete gesture.

---

## 4. Capture Page — Enhancements

### 4.1 Voice Capture
Add a "Voice" button that uses Web Speech API or MediaRecorder for voice-to-text capture.

### 4.2 Share Target (PWA)
Register the app as a Web Share Target so content shared from other apps (browser, social, etc.) lands in the capture form.

### 4.3 Context Chips
Add optional quick-tag chips below the input: project selector, energy level, due date shortcut, "needs triage" flag.

### 4.4 Recent Captures List
Show the last 5-10 captured items below the form for quick review.

---

## 5. General Mobile UX

### 5.1 Mobile-Optimized Header
**Current:** Header shows Zen/Calm toggles, Daily Completion Counter, Health dot, Sync button — all waste space on mobile.
**Needed:** Compact mobile header showing only: app icon/title + sync indicator. Move other actions into "More" or long-press gestures.

### 5.2 Pull-to-Refresh Everywhere
**Current:** Only on Today.
**Needed:** Also on Triage, Dashboard/Inbox, and Capture (to refresh recent captures).

### 5.3 Mobile Quick-Add
**Current:** Quick-add bar is hidden on mobile with no replacement (except the Capture page).
**Needed:** A floating "+" FAB or the bottom tab Capture button that opens a lightweight inline modal (not full-page navigation).

### 5.4 Touch Target Audit
Ensure all interactive elements meet 44×44px minimum tap targets. Particularly: task checkboxes, filter chips, dropdown triggers.

---

## 6. PWA & Native-Feel

### 6.1 Install Prompt / Add to Home Screen
Show a one-time banner prompting mobile Safari/Chrome users to "Add to Home Screen" for app-like experience.

### 6.2 Push Notifications
- Morning "Start My Day" prompt
- "Triage Queue > N items" midday nudge
- End-of-day carry-forward reminder
- Requires service worker registration + backend push subscription management.

### 6.3 Offline Support for Capture
Queue captured items in IndexedDB when offline; sync when connectivity returns. Show pending-sync indicator.

### 6.4 App-Like Transitions
Page transitions between tabs should feel native (no full-page reload flash). Consider View Transitions API or shared-layout animations.

---

## 7. Priority & Phasing

| Priority | Items | Effort |
|----------|-------|--------|
| **P1 — Next sprint** | 1.1 (Inbox view), 2.1+2.2 (Triage cards+swipe), 5.1 (compact header) | Medium |
| **P2 — Soon** | 3.1 (suggestions), 4.1 (voice), 4.3 (context chips), 5.2 (PTR everywhere), 5.4 (tap target audit) | Medium |
| **P3 — Later** | 1.2 (More hub), 4.2 (share target), 4.4 (recent captures), 5.3 (FAB), 6.1-6.4 (PWA) | Large |

---

## Success Criteria

- All primary flows (view tasks, complete tasks, triage items, capture new items) achievable one-handed on a phone
- First meaningful paint < 2s on LTE
- No flow requires more than 3 taps to complete a primary action
- Zero "unusable" states (no overlays blocking content, no unscrollable pages)
