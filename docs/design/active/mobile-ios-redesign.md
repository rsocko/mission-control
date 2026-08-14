---
title: "Mobile iOS Redesign"
status: active
created: 2026-07-28
last_reviewed: 2026-07-28
category: design
supersedes: "[Mobile Companion (proposed)](../proposed/mobile-companion.md)"
related:
  - "[Design System](../index.md)"
  - "[Triage Enhancements](../proposed/triage-enhancements.md)"
  - "[My Day Enhancements](../proposed/my-day-enhancements.md)"
  - "[Native Bridge and API Security Contract](mobile-ios-native-security-contract.md)"
mockups:
  - "[iOS Core Mockups (20 screens)](../../mockups/mockup-ios-iphone-core.html)"
---

# Mission Control - Mobile iOS Redesign Spec

## Summary

This document captures the finalized mobile iOS design decisions resulting from a
comprehensive review of the mockup file (`mockup-ios-iphone-core.html`). It supersedes
the earlier proposed mobile-companion spec with updated navigation, interaction patterns,
and screen inventory.

---

## Navigation Architecture

### Bottom Tab Bar (5 tabs)

| Position | Tab | Icon | Badge |
|----------|-----|------|-------|
| 1 | Today | Sun | -- |
| 2 | Triage | Layers | Red (unprocessed count) |
| 3 | Capture | Plus Circle (raised) | -- |
| 4 | Sort | Zap | Amber (queue count) |
| 5 | Houston | Rocket | -- |

**Key decisions:**
- Inbox tab removed; replaced by Quick Sort (AI-powered priority assignment)
- More tab removed; replaced by Houston AI assistant
- Capture button is elevated/raised center position for quick access

### Hamburger Menu (top-left, all screens)

Slide-out drawer with:
- User avatar + name
- Search bar
- Menu items: Dashboard, Projects, Goals, Notifications, Routines, Insights, Settings
- Sync status indicator at bottom
- Red notification dot on hamburger icon when urgent notifications exist

**Excluded from mobile** (desktop-only):
- Kanban (columns don't fit mobile)
- Timeline/Gantt (too complex for touch)
- Document Intelligence (niche workflow)
- My Day (redundant with Today tab)

### Header Pattern (all screens)

```
[Hamburger] [Screen Title] [Search icon] [Context action]
```

- Hamburger always top-left with notification dot
- Search icon top-right on primary screens
- Context actions vary by screen (filter, edit, etc.)

---

## Screen Inventory (20 screens)

### Core Screens (Tab Views)

1. **Today** - Priority-sorted compact task list (not timeline)
2. **Today Task Detail** - Bottom sheet drawer, swipe-down to dismiss
3. **Triage Stream** - Scrollable feed with source-branded cards
4. **Triage Focus** - Full-screen swipeable card for rapid decisions
5. **Capture** - Quick-add with voice, text, share-sheet support
6. **Quick Sort** - Card-stack UI for AI-suggested priority assignment
7. **Houston Home** - AI assistant with suggestions and quick actions

### Navigation & Feature Screens

8. **Hamburger Drawer** - Slide-out navigation menu
9. **Notifications** - Grouped by urgency with clear/snooze actions
10. **Global Search** - Full-text search with recent + filter chips
11. **Task Edit** - Bottom sheet editor for task properties
12. **Houston Chat** - Conversational AI thread
13. **Triage Item Detail** - Expanded card with full metadata + actions
14. **Empty State: Today** - Motivational zero-state with suggestions
15. **Empty State: Triage** - Celebration state for inbox-zero
16. **Onboarding** - First-run welcome flow

### Hamburger Sub-Screens

17. **Dashboard** - Mobile-optimized metrics and charts
18. **Projects** - Project list with progress indicators
19. **Goals** - Goal tracking with milestone progress
20. **Routines** - Routine schedule and streak tracking
21. **Insights** - AI-generated productivity insights
22. **Settings** - Account, preferences, notifications, sync

---

## Interaction Patterns

### Swipe Gestures

#### Today Screen
| Direction | Short Swipe | Full Swipe |
|-----------|-------------|------------|
| Left | Reveal "Not Today" | Execute Not Today |
| Right | Reveal scheduling tray | -- |

Scheduling tray options: Tomorrow, Pick Day, Snooze (1hr/3hr/tonight)

#### Triage Focus Mode
| Direction | Action |
|-----------|--------|
| Right | Done / Accept |
| Left | Dismiss |
| Up | Snooze |

#### Quick Sort
| Direction | Action |
|-----------|--------|
| Left | Accept AI suggestion |
| Right | Accept manual override |
| Up | Skip / Defer |

### Tap Interactions

- **Dot/checkbox**: Complete task (all list views)
- **List item tap**: Open bottom sheet detail
- **Priority badge tap**: Quick-change priority
- **Source icon tap**: Open source link

### Bottom Sheet Pattern

- Preferred over full-page navigation for detail views
- Swipe-down to dismiss (ergonomic, no reach to top-left)
- Three snap points: peek (40%), half (60%), full (90%)
- Task edit, task detail, scheduling tray all use this pattern

---

## Triage Design

### Multi-Source Content

Sources displayed with branded colors and icons:
- Reddit, GitHub, YouTube, Instagram, Facebook, Twitter/X
- TikTok, Pinterest, Email, Browser Tabs, iOS Share
- Document Intelligence, Web Scrape

### Routing Actions (replaces generic Keep/Plan/Defer/Archive)

| Action | Description |
|--------|-------------|
| Save to Karakeep | Bookmark/read-later service |
| Save to Knowledge Base | Internal KB storage |
| Create Task (GitHub) | Convert to GH issue |
| Create Task (Todo) | Convert to MC task |
| Save to Model Catalog | AI model reference |
| Trigger Workflow | Automation trigger |
| Dismiss | Remove from queue |
| Snooze | Resurface later |

### AI Features in Triage

- Relevance score (0-100) displayed on each card
- AI-suggested action shown as primary button
- Source-specific context extraction (e.g., Reddit upvotes, GH stars)

---

## Today Screen Design

### List View (default)

- Compact rows with: priority dot, title, project tag, due indicator
- AI suggestion chips below high-priority items
- Grouped by: Overdue > Due Today > Scheduled > Unscheduled
- Pull-to-refresh for sync

### NOT a timeline

The Today view is intentionally list-based rather than timeline-based because:
- User's tasks often lack time estimates or specific time slots
- Triage/priority workflow is more natural than time-blocking
- Timeline view remains available on desktop for users who want it

---

## Quick Sort Design

### Card Stack UI

- Top card shows: task title, current priority, AI suggestion, confidence %
- AI reasoning displayed below card
- Accept/reject/skip via swipe or button tap
- Progress indicator (items sorted / total)
- Session stats: time, accuracy, streak

---

## Houston AI Design

### Home Screen

- Greeting with daily summary
- Quick action chips: "What should I do next?", "Summarize my day", etc.
- Recent conversations list
- Proactive suggestions based on context

### Chat Thread

- Conversational UI with message bubbles
- Inline action cards (create task, schedule, etc.)
- Context-aware responses tied to current tasks/triage

---

## Visual Design (iOS Context)

While the web app uses Geist Sans + Lucide icons, the iOS native context uses:

| Aspect | iOS Value |
|--------|-----------|
| Font | SF Pro (system) |
| Icons | SF Symbols / Font Awesome |
| Primary Blue | #0a84ff (iOS system blue) |
| Background | Dark mode default |
| Effects | Glassmorphism, vibrancy |
| Radius | 12-16px (iOS standard) |
| Safe areas | Respected on all screens |

The design maintains brand consistency through:
- Same priority color system (red/amber/blue/gray)
- Same information hierarchy and card patterns
- Same dark-first aesthetic
- Consistent spacing and density

---

## Accessibility Requirements

- 44px minimum tap targets
- VoiceOver labels on all interactive elements
- Dynamic Type support
- High-contrast mode support
- Reduce Motion support (disable swipe animations)
- Haptic feedback on swipe actions

---

## Success Metrics

- Daily mobile active users / total active users
- Triage items processed per mobile session (target: 15+)
- Quick Sort sessions completed per week
- Time-to-inbox-zero (median, target: < 5 min)
- Houston engagement rate (conversations/week)
- Task completion rate delta (mobile users vs baseline)
