---
title: "Mobile Phased Development — iOS Wrapper & Distribution"
status: active
created: 2026-07-25
last_reviewed: 2026-07-31
category: design
related:
  - "[Mobile Companion](mobile-companion.md)"
  - "[Mobile Remaining Gaps](mobile-remaining-gaps.md)"
  - "[Native Bridge and API Security Contract](../active/mobile-ios-native-security-contract.md)"
  - "[Competitive Analysis — Oriti/Anythings](../../research/COMPETITIVE-ANALYSIS-ORITI-ANYTHINGS.md)"
---

# Mission Control — Phased Mobile Development Plan  
## Including Native iOS Wrapper & Distribution

---

## Overview

Mission Control's mobile strategy follows a progressive enhancement model. The
responsive PWA is now mature enough for native work to begin; unfinished PWA
interaction enhancements are no longer a blanket prerequisite for the wrapper.

```
Completed baseline — Responsive PWA + PWA distribution
Release Phase 1  — Foundation and Readiness
Release Phase 2  — Wrapper and Native Integrations
Release Phase 3  — APNs and Notification Delivery
Release Phase 4  — TestFlight Beta
Release Phase 5  — App Store Release
Post-v1 roadmap — Native quick wins, core native, extended surfaces, deep intelligence
```

The iOS "wrapper" approach — a lightweight native Swift app that hosts the PWA inside a `WKWebView` — is not just about App Store presence. **The primary justification is deep system integration**: widgets, Apple Intelligence, Siri, watch complications, offline-first storage, Live Activities, and automation triggers that a PWA can never achieve. The wrapper is the fastest path to distribution *and* unlocks a native feature roadmap that compounds into a vastly superior mobile experience.

---

## Completed PWA Baseline

The completed PWA baseline makes the web app usable as a mobile-web and
installable experience. Key milestones:

- Responsive mobile navigation, compact header, and bottom tab bar
- Quick Capture page (`/capture`) with voice and context controls
- Mobile-optimized Today, Triage, Quick Sort, Houston, and supporting screens
- PWA manifest, install prompt, Web Push, offline queue, and share target
- Safe-area and responsive WebKit coverage across primary routes

Full details: [`mobile-remaining-gaps.md`](mobile-remaining-gaps.md)

---

## Five-Phase iOS v1.0 Release

### Phase 1 — Foundation and Readiness

- Restore the mobile test baseline and validate release-critical flows on a
  physical iPhone.
- Record the device, iOS version, build, results, and linked defects in the
  [physical-device validation record](../../development/mobile-ios-device-validation.md).
- Define the versioned bridge, trusted-origin navigation, authentication,
  Keychain/App Group, APNs registration, and capture API contracts.
  The canonical contract for #932-#935 is
  [`mobile-ios-native-security-contract.md`](../active/mobile-ios-native-security-contract.md).
- Provision Apple Developer, signing, APNs, App Store Connect, identifiers,
  entitlements, and the macOS CI runner.
- The Xcode scaffold and signed-build pipeline skeleton may begin in parallel
  once identifiers and contract boundaries are understood.

### Phase 2 — Wrapper and Native Integrations

- Build the hardened `WKWebView` host.
- Implement the typed, versioned JS/native bridge.
- Ship URL and text Share Sheet capture through
  `POST /api/triage/capture`.
- Defer image sharing until the image upload/storage work is complete. OCR is
  not implied by image ingestion.

### Phase 3 — APNs and Notification Delivery

- Complete the shared notification catalog/policy model.
- Complete the durable notification delivery outbox and dispatcher.
- Add APNs device registration and delivery as a channel behind those shared
  services rather than creating a second direct-send path.

### Phase 4 — TestFlight Beta

- Produce signed, reproducible release candidates.
- Run internal beta before any external beta.
- Validate core web flows, Share Sheet, APNs/deep links, external navigation,
  offline/reconnect, and logout/revocation on supported physical devices.
- Require explicit release-candidate approval and no unresolved
  release-blocking crashes, security defects, or data-loss defects.

### Phase 5 — App Store Release

- Complete privacy/compliance, assets, metadata, reviewer access, and release
  monitoring.
- Submit the approved TestFlight build and handle review feedback.
- Begin post-v1 native roadmap work only after release telemetry is stable.

---

## Native iOS Wrapper Technical Design

### 3.1 Strategy

A **WKWebView wrapper** is the right approach for this stage:

| Option | Effort | App Store | Native APIs | Verdict |
|--------|--------|-----------|-------------|---------|
| WKWebView wrapper (Swift) | **Low** | ✅ | Via JS bridge | ✅ **Recommended** |
| Capacitor | Medium | ✅ | Via plugin layer | ✅ Alternative |
| React Native | High | ✅ | Full | ❌ Overkill (separate codebase) |
| PWA only | None | ❌ iOS Safari only | Limited | ❌ No App Store |

**WKWebView** embeds the existing Next.js web app into a native Swift shell. The web app runs identically — no code changes to existing business logic, UI, or API. The native layer only adds what the browser cannot: push notifications, home screen widget, Share Sheet, and system chrome.

### 3.2 iOS Wrapper — Technical Design

#### Project Structure

```
ios/
├── MissionControl.xcodeproj
├── MissionControl/
│   ├── AppDelegate.swift
│   ├── SceneDelegate.swift
│   ├── ViewController.swift          ← WKWebView host
│   ├── WebBridge.swift               ← JS ↔ native message handler
│   ├── NotificationManager.swift     ← APNs registration + handling
│   ├── ShareExtension/               ← iOS Share Sheet target
│   │   ├── ShareViewController.swift
│   │   └── Info.plist
│   ├── WidgetExtension/              ← iOS 16+ interactive widget (Phase 4)
│   └── Assets.xcassets/
│       ├── AppIcon.appiconset/
│       └── LaunchScreen.storyboard
└── README.md
```

#### WKWebView Host (ViewController.swift)

Key configuration:
- Load the production MC URL (`https://mc.yourdomain.com`) — the app is a thin shell; all content is served from the web
- Enable `allowsBackForwardNavigationGestures` for swipe-to-go-back
- Handle deep links (`mc://`) and universal links to open the correct page
- Inject `window.isMCNativeApp = true` at document start so the web app can conditionally show/hide native-only UI elements
- Pass `User-Agent` override so the server can detect native app context

#### JS ↔ Native Bridge (WebBridge.swift)

The web app uses `window.webkit.messageHandlers.<name>.postMessage(payload)` for:

| Message | Direction | Purpose |
|---------|-----------|---------|
| `requestPushPermission` | Web → Native | Trigger APNs permission prompt |
| `pushToken` | Native → Web | Deliver APNs device token to server via REST |
| `shareSheetCapture` | Native → Web | Deliver shared content (URL/text/file) to Capture page |
| `hapticFeedback` | Web → Native | Trigger `UIImpactFeedbackGenerator` on swipe actions |
| `openURL` | Web → Native | Open external URLs in `SFSafariViewController` |
| `setBadge` | Web → Native | Set app icon badge count from triage queue depth |

#### Production vs. Dev

The web target URL is configurable at build time via a `BuildConfig.plist`:
```xml
<key>MCWebBaseURL</key>
<string>https://mc.yourdomain.com</string>
```

The Simulator may use a host-mapped local URL. A physical iPhone cannot reach
the Mac through its own `localhost`; device testing must use a reachable LAN
address or HTTPS development tunnel. Any App Transport Security exception must
be development-only and narrowly scoped.

The navigation delegate must allow privileged bridge access only for the
configured Mission Control origin. External links open outside the privileged
web view and never inherit injected native capabilities.

#### Offline Handling

When the device is offline:
- WKWebView shows the cached service worker offline page (`/offline`)
- The native layer monitors `NWPathMonitor` and posts a `networkStatus` bridge event
- The web app's offline queue (IndexedDB captures) continues to work as-is

### 3.3 Push Notifications (APNs)

APNs extends the shared notification delivery architecture:

```
persisted notification
  -> shared policy and suppression resolver
  -> durable delivery outbox
  -> channel dispatcher
       ├── Web Push subscription
       └── APNs device registration
```

**Flow:**
1. Show a contextual soft prompt before requesting system permission
2. Native layer registers for remote notifications → gets APNs device token
3. Native uses the authenticated registration contract to register or rotate the device
4. Server stores APNs-specific environment, topic, token, last-seen, and invalidation state
5. Eligible notifications create durable APNs delivery events
6. The dispatcher sends, retries transient failures, and retires invalid tokens

APNs tokens must not be forced into the current Web Push row shape, which
requires an endpoint and VAPID keys. Web Push and APNs use channel-specific
registration data while sharing policy, quiet hours, DND, deduplication, rate
limits, navigation validation, and delivery outcomes.

**Initial notification types:**
- Morning "Start My Day" prompt (8 AM, configurable)
- "Triage Queue > N items" midday nudge
- End-of-day carry-forward reminder

**Web push (Android / desktop PWA)** uses the existing Web Push API / VAPID path and is distinct from APNs.

### 3.4 iOS Share Sheet Extension

The Share Sheet extension initially allows sharing a URL or text from any iOS
app directly into MC's Capture queue.

**Extension flow:**
1. User shares content → selects "Mission Control" from iOS Share Sheet
2. `ShareViewController` extracts the shared URL or text
3. Posts to `/api/triage/capture` via URLSession using the least-privilege
   credential defined by the native security contract
4. Shows confirmation toast and dismisses

**Auth:** Mission Control does not currently expose the generic session token
assumed by the original design. The main app and extension must use the agreed
revocable, least-privilege credential stored in a shared Keychain access group.
Logout and revocation remove that credential.

**Initial accepted input types:**
- `public.url` → URL captured with page title
- `public.plain-text` → text task

`public.image` is deferred until the image capture upload/storage endpoint is
complete. OCR remains separately scoped.

---

## Native Value Proposition

Going native is **not** just about App Store presence — the primary justification is deep system integration that a PWA can never achieve. The following capabilities represent the "native moat" that makes a Swift wrapper worthwhile:

```
┌─────────────────────────────────────────────────────────────┐
│                  WHY GO NATIVE?                              │
├─────────────────────────────────────────────────────────────┤
│  PWA cannot do:                                             │
│    • Home screen widgets with live data                     │
│    • Apple Watch complications & quick actions              │
│    • Siri / Apple Intelligence integration                  │
│    • Live Activities & Dynamic Island                       │
│    • Focus mode–aware behavior                              │
│    • Spotlight indexing of tasks                            │
│    • True offline with local database                       │
│    • Handoff / continuity between devices                   │
│    • Rich haptic patterns                                   │
│    • Time-sensitive / interruption-level notifications      │
│    • NFC/location/automation triggers via Shortcuts         │
└─────────────────────────────────────────────────────────────┘
```

The features below are organized into sub-phases **by value-to-effort ratio** — highest ROI first.

---

## Phase 4A — High Value, Low Effort (Ship with v1.1)

*These features are quick wins that dramatically increase daily engagement.
Target: 1–2 weeks after the v1.0 App Store release is stable.*

### 4A.1 Widgets (WidgetKit)

**Why:** Widgets keep Mission Control visible on the home screen all day — passive awareness without opening the app.

| Widget Size | Content | Interactivity |
|-------------|---------|---------------|
| **Small** (accessory) | Today count + current task title | Tap → opens Today view |
| **Medium** | Top 3 tasks with checkboxes | ✅ Interactive complete (iOS 17+ AppIntents) |
| **Large** | Today schedule with time blocks | Tap task → opens detail |
| **Lock Screen** (accessory) | Task count badge or next task | Tap → opens app |

**Technical approach:**
- `WidgetKit` + `AppIntents` for interactive widgets (iOS 17+)
- Shared **App Group container** (`group.com.yourname.missioncontrol`) for data exchange between main app and widget extension
- Widget timeline: reload every 15 min via `TimelineProvider` + on-demand reload via `WidgetCenter.shared.reloadAllTimelines()` when tasks change
- Data source: lightweight REST call to `/api/widgets/today` with aggressive local caching (stale-while-revalidate)
- Fallback for offline: render from last-cached data with "Last updated X min ago" footer

**Key considerations:**
- Widget memory budget is ~30MB — keep data fetching minimal
- `AppIntents` must be registered at build time (compile-time type safety)
- Test with `#Preview` in Xcode for rapid iteration
- Support StandBy mode (iOS 17+) for bedside/desk display

---

### 4A.2 Live Activities & Dynamic Island

**Why:** When a user is in a focused work session or triage flow, Live Activity keeps progress visible without unlocking.

**Use cases:**
- **Focus timer**: "Working on: Design homepage — 23 min elapsed"
- **Triage session**: "5 of 12 items triaged" with progress bar
- **Daily progress**: "6/9 tasks complete today"

**Technical approach:**
- `ActivityKit` framework for Live Activities
- Compact / minimal / expanded layouts for Dynamic Island (iPhone 14 Pro+)
- Start activity from web via bridge message (`startLiveActivity`) → native creates `ActivityAttributes`
- Update via push-to-talk token (APNs live activity push) for server-driven updates
- Auto-end when session completes or after 8-hour timeout (iOS limit)

**Key considerations:**
- Live Activities have a 4KB payload limit for updates
- Maximum 5 concurrent activities per app — use priority system
- Lock Screen appearance must be useful at a glance (no dense text)
- Graceful degradation on devices without Dynamic Island (still shows on Lock Screen)

---

### 4A.3 Spotlight Search Integration

**Why:** Users can find tasks instantly from the iOS home screen search without opening the app.

**Indexed content:**
- All task titles + descriptions → `CSSearchableItem`
- Project names
- Recent captures
- Saved views ("Today", "This Week", "Triage Queue")

**Technical approach:**
- `CoreSpotlight` framework for on-device indexing
- Index tasks on creation/update, expire completed tasks after 7 days
- `NSUserActivity` for recently viewed items (also powers Handoff + Siri suggestions)
- Deep links: `mc://task/{id}`, `mc://view/today`, `mc://capture`

**Key considerations:**
- Index updates must be batched (don't index on every keystroke)
- Include `thumbnailData` for visual search results (task priority color dot)
- Respect user's data — don't index if user has privacy mode enabled
- Test with `mdutil` and Spotlight Diagnostics on device

---

### 4A.4 Enhanced Haptics

**Why:** Subtle haptic feedback makes triage gestures feel premium and reinforces actions.

| Action | Haptic Pattern |
|--------|---------------|
| Task complete | Success: `UINotificationFeedbackGenerator(.success)` |
| Swipe-to-defer | Light impact: `UIImpactFeedbackGenerator(.light)` |
| Swipe-to-priority | Medium impact with ramp |
| Pull-to-refresh | Soft tick at threshold |
| Task delete | Warning: `UINotificationFeedbackGenerator(.warning)` |
| Triage session complete | Custom `CHHapticEngine` celebration pattern (3-tap crescendo) |

**Technical approach:**
- Expose via bridge: `hapticFeedback({ type: 'success' | 'impact' | 'warning' | 'custom', intensity?: number })`
- Custom patterns authored in Core Haptics for milestone celebrations
- Web triggers haptics at interaction points already defined in gesture handlers

---

## Phase 4B — High Value, Medium Effort (v1.2, ~2–4 weeks)

*These features deepen the "always with you" experience and unlock voice/automation workflows.*

### 4B.1 Siri & App Intents (Full Integration)

**Why:** Voice capture is the fastest path from thought to inbox. Siri integration means zero-friction task creation from any context — driving, cooking, walking.

**Intents to implement:**

| Intent | Trigger Example | Response |
|--------|----------------|----------|
| `AddTaskIntent` | "Hey Siri, add 'Buy milk' to Mission Control" | "Added 'Buy milk' to your capture queue" |
| `ShowTodayIntent` | "What's on my plate today?" | Reads top 3 tasks + total count |
| `StartTriageIntent` | "Start triage" | Opens app to triage view |
| `CompleteTaskIntent` | "Mark 'Buy milk' as done" | Confirms completion |
| `QuickCaptureIntent` | "Remind me in Mission Control: call dentist" | Adds to queue with natural language |
| `ShowProgressIntent` | "How am I doing today?" | "You've completed 6 of 9 tasks" |

**Technical approach:**
- `AppIntents` framework (iOS 16+) — modern declarative API, replaces legacy SiriKit
- `AppShortcutsProvider` to auto-surface intents in Shortcuts app without user configuration
- Entity queries: `TaskEntity` conforming to `AppEntity` for task lookup by name
- Parameterized intents: accept task title, project, priority as parameters
- Siri Tip UI: show "Try saying..." prompts in onboarding

**Key considerations:**
- Intents must be fully functional even if app is in background (use `AppIntents` perform() method)
- Support disambiguation: "Which task do you mean?" when multiple match
- Localization: define `AppShortcutsProvider.localizedStrings` for each supported language
- Test with Shortcuts app — Siri is just one trigger; automations are equally powerful

---

### 4B.2 Apple Intelligence Integration

**Why:** Apple Intelligence (iOS 18.1+) makes Mission Control a first-class citizen in the system-wide AI experience — Siri can reason about your tasks, summarize your day, and take action on your behalf.

**Capabilities to adopt:**

#### Siri App Intents + Apple Intelligence reasoning
- With `AppIntents` properly defined, Apple Intelligence can **chain intents** — e.g., "What tasks did I defer this week?" → Siri queries your entities and responds
- **Proactive suggestions**: iOS learns task capture patterns and pre-surfaces "Add to Mission Control" at relevant times

#### Intelligent Notification Summaries
- Provide `subtitle` and `summaryArgument` in push payloads → iOS summarizes groups of MC notifications intelligently
- Mark notifications with proper `interruptionLevel`: `.timeSensitive` for morning nudge, `.active` for general, `.passive` for progress updates

#### Writing Tools Integration
- Task descriptions and notes can leverage system Writing Tools (Rewrite, Proofread, Summarize) if using standard `UITextView` / editable web fields
- Free enhancement — just ensure text fields are accessible to system

#### Semantic Search (on-device)
- Index tasks with rich metadata via `CSSearchableItem` attributes → Apple Intelligence can perform semantic (not just keyword) search across tasks
- "Find my tasks about the product launch" surfaces results even if "product launch" isn't in the title

**Technical approach:**
- Expose rich `AppEntity` definitions with relationships (task → project → area)
- Use `@AssistantIntent(schema: .system.search)` and other system schemas
- Provide `.systemImageName` and `.displayRepresentation` for all entities so Siri UI looks polished
- Adopt `SiriTipView` in onboarding to train users on capabilities

**Key considerations:**
- Apple Intelligence is opt-in by user (Settings > Apple Intelligence) — provide graceful fallback
- On-device processing means no data leaves the device for AI features — privacy selling point
- Available on iPhone 15 Pro+ and all iPhone 16+ — provide feature detection
- API surface is evolving — check WWDC 2025/2026 updates for new capabilities
- Test with Siri on-device (not Simulator, which lacks Apple Intelligence)

---

### 4B.3 Offline-First Local Storage

**Why:** A task manager must work everywhere — subway, airplane, dead zones. True offline means the app is always usable, not just "showing a cached page."

**Architecture:**

```
┌──────────────────────────────────────┐
│         SwiftData / CoreData         │
│  (local source of truth when offline)│
├──────────────────────────────────────┤
│         Sync Engine                   │
│  (bidirectional, conflict-aware)     │
├──────────────────────────────────────┤
│         REST API / WebSocket          │
│  (server is source of truth online)  │
└──────────────────────────────────────┘
```

**What's stored locally:**
- All tasks in active views (Today, This Week, Triage Queue)
- Last 100 tasks across all states for search
- All user preferences and view configurations
- Pending mutations queue (offline actions waiting to sync)

**Sync strategy:**
- **Optimistic local writes**: actions apply immediately to local DB, queue for server sync
- **Conflict resolution**: last-writer-wins with field-level merge (not document-level)
- **Idempotent replays**: each mutation has a client-generated UUID; server deduplicates
- **Delta sync**: on reconnect, fetch only changes since last sync token (`/api/sync?since=<timestamp>`)
- **Background sync**: `BGAppRefreshTask` to sync every 15 min even if app isn't open

**Offline-capable actions:**
- ✅ Complete/uncomplete tasks
- ✅ Triage full session (defer, prioritize, schedule, delete)
- ✅ Quick capture new tasks
- ✅ Reorder today's task list
- ✅ Edit task title/description/notes
- ⚠️ Create new projects (syncs on reconnect)
- ❌ Invite collaborators (requires server)

**Technical approach:**
- `SwiftData` (iOS 17+) with `@Model` classes mirroring server schema
- Shared App Group container for widget/extension access to same data
- `NWPathMonitor` for connectivity detection
- `BackgroundTasks` framework for periodic background sync
- Expose sync status to web layer via bridge: `{ status: 'synced' | 'pending' | 'offline', pendingCount: 3 }`

**Key considerations:**
- Storage budget: ~50MB for task data is well within iOS limits
- Migration strategy: version `SwiftData` schema; lightweight migrations for field additions
- Battery impact: don't sync more than every 15 min in background
- First-launch hydration: initial sync may take 5–10s for large accounts — show progress
- Web layer must respect sync state: show "pending" badge on unsynced items

---

### 4B.4 Focus Filters & Modes

**Why:** When a user sets "Work" Focus, Mission Control should only show work tasks. When "Personal" is active, hide work projects. This is system-level context awareness no PWA can achieve.

**Implementation:**
- `SetFocusFilterIntent` — user configures which projects/areas are visible per Focus mode
- App reads active Focus via `FocusStatusProvider`
- Filter task queries by allowed projects when Focus is active
- Notification filtering: only deliver notifications for tasks matching active Focus

**Technical approach:**
- Define `FocusFilterAppIntent` with parameters: `projects: [ProjectEntity]`, `showOnlyToday: Bool`
- Register in `AppIntents` so it appears in Focus Settings automatically
- Persist active filter in shared App Group so widget also respects it
- Bridge to web: `setFocusFilter({ projects: [...], todayOnly: bool })`

---

## Phase 4C — Medium Value, Medium Effort (v1.3, ~3–5 weeks)

*These extend Mission Control to more surfaces and contexts.*

### 4C.1 watchOS App & Complications

**Why:** The watch is the most personal device — glanceable task awareness and wrist-level quick actions reduce friction to near zero.

**Watch app features:**

| Surface | Content |
|---------|---------|
| **Complication (small)** | Today task count circle |
| **Complication (graphic)** | Current task title + progress ring |
| **App — Today view** | Scrollable today list with complete button |
| **App — Quick Capture** | Voice dictation → new task |
| **App — Timer** | Focus timer with haptic ticks |
| **Smart Stack widget** | Top task with "Done" button (watchOS 10+) |

**Technical approach:**
- watchOS target in Xcode project with SwiftUI views
- `WatchConnectivity` for real-time sync with iPhone app
- Independent networking: watch can fetch from API directly when iPhone isn't nearby
- `WidgetKit` for Smart Stack (watchOS 10+)
- `ExtendedRuntimeSession` for focus timer (keeps app alive during session)
- Haptic confirmation on task complete: `WKInterfaceDevice.current().play(.success)`

**Data flow:**
```
Server  ←→  iPhone App  ←→  Watch App
              ↕                 ↕
        App Group DB      Watch local cache
```

**Key considerations:**
- Watch has very limited memory (~30MB) — keep task list lean (today + next 5 triage items)
- Screen real estate is tiny — ruthless prioritization of information
- Battery: avoid frequent network calls; rely on `WatchConnectivity` transfers from phone
- Always-On Display: complication must be useful in dimmed state
- Test on physical device — Simulator doesn't capture real performance

---

### 4C.2 Shortcuts Automations (Advanced)

**Why:** Beyond Siri voice, Shortcuts enables powerful automations triggered by time, location, NFC, Focus changes, and more.

**Automation recipes to support:**

| Trigger | Automation |
|---------|-----------|
| **Arrive at office** (location) | Show today's work tasks as notification |
| **Leave work** (location) | Switch to personal Focus filter |
| **7:00 AM** (time) | Run "Start My Day" intent, surface morning nudge |
| **NFC tap** (tag on desk) | Start focus timer + show current task on Dynamic Island |
| **Focus changes to Work** | Auto-apply work project filter |
| **Low Power Mode on** | Reduce sync frequency |
| **CarPlay connects** | Read today's top 3 tasks aloud |

**Technical approach:**
- All powered by existing `AppIntents` — Shortcuts automations consume the same intents as Siri
- Provide `AppShortcutsProvider` with `.phrases` so iOS auto-suggests relevant automations
- Document suggested automations in onboarding / settings screen

---

### 4C.3 Handoff & Continuity

**Why:** Start triaging on iPhone during commute → sit down at Mac and continue exactly where you left off.

**Implementation:**
- `NSUserActivity` with task/view state → advertise via Handoff
- Mac/iPad running web app registers as Handoff receiver (universal links)
- Deep link format: `https://mc.yourdomain.com/task/{id}?handoff=true`
- Works between: iPhone ↔ iPad ↔ Mac (Safari/native)

**Supported handoff contexts:**
- Viewing a specific task → opens that task on the other device
- In triage → opens triage at the same position
- Writing a note → transfers cursor position + draft text

---

### 4C.4 EventKit & Reminders Integration

**Why:** Users already have tasks in Apple Reminders and events in Calendar. Bi-directional sync eliminates the "two systems" problem.

**Capabilities:**
- **Calendar → MC**: Import calendar events as time-blocked tasks (read-only mirror)
- **MC → Reminders**: Optionally mirror deadline tasks to Apple Reminders (appears in system widgets)
- **MC → Calendar**: Tasks with scheduled times appear as calendar events
- **Due date intelligence**: Parse "tomorrow" / "next Monday" and create with `EKEvent`

**Technical approach:**
- `EventKit` framework with proper permission prompts
- Sync only user-opted-in lists (don't import everything)
- Map MC priority → Reminders priority (1–9 scale)
- Conflict: MC is source of truth; Reminders is a read-only mirror

**Key considerations:**
- Permission is per-calendar — request minimally
- `EKEventStore` changes trigger `EKEventStoreChangedNotification` — react to external edits
- iCloud sync latency: Reminders may take 5–30s to sync across devices

---

## Phase 4D — High Value, High Effort (v2.0, ~6–8 weeks)

*These are substantial features that represent a major version milestone.*

### 4D.1 On-Device ML (Core ML)

**Why:** Smart task categorization, priority suggestions, and natural language parsing — all on-device, zero latency, full privacy.

**ML features:**

| Feature | Model | Input | Output |
|---------|-------|-------|--------|
| **Auto-categorize** | Text classifier (Create ML) | Task title + description | Project/area suggestion |
| **Priority prediction** | Tabular classifier | Task text + time + user patterns | High/Medium/Low suggestion |
| **Smart scheduling** | Regression | Task type + estimated duration + calendar | Suggested time slot |
| **NLP entity extraction** | NaturalLanguage framework | "Call dentist tomorrow at 3pm" | Entities: person, date, time |
| **Duplicate detection** | Sentence embeddings | New task text | Similar existing tasks |

**Technical approach:**
- Train models in Create ML using anonymized task data (or synthetic training data)
- `NaturalLanguage` framework for entity extraction (no custom model needed)
- Models run via `CoreML` — on Neural Engine, ~5ms inference per task
- Suggestions surfaced as non-blocking UI hints ("Did you mean project: Work?")
- User corrections retrain on-device via `MLUpdateTask` (personalization)

**Key considerations:**
- Model size budget: keep under 10MB for fast load and minimal storage impact
- Privacy: all inference on-device; no task data ever sent for ML training
- Graceful degradation: ML suggestions are always optional hints, never hard decisions
- A/B test: measure whether suggestions increase capture speed and correct categorization

---

### 4D.2 App Clips (Shared Lists)

**Why:** Let non-users interact with a shared task list without installing the full app — viral growth + frictionless collaboration.

**Use case:** A user shares a project checklist (e.g., trip planning) → recipient scans QR or taps link → App Clip loads a lightweight interactive checklist.

**Technical approach:**
- App Clip target: `< 15MB` (Apple requirement)
- Hosts a stripped-down SwiftUI view: shared list with complete/add actions
- App Clip Card in Messages / Safari / QR with branding
- Upsell to full app via `SKOverlay` after engagement

**Key considerations:**
- App Clips expire after 30 days of inactivity — this is for one-off collaboration
- No push notifications in App Clips — only in-app engagement
- Must handle auth gracefully (anonymous or Sign in with Apple)

---

### 4D.3 Drag & Drop (iPad Multitasking)

**Why:** On iPad, users run Mission Control in Split View alongside Safari, Mail, or Notes. Drag-and-drop makes capture effortless.

**Supported drops into MC:**
- URLs from Safari → new capture with URL + page title
- Text from any app → new text task
- Images → OCR capture (screenshot of whiteboard, etc.)
- Files → attached to task

**Supported drags from MC:**
- Task title → plain text to any app
- Task with URL → shares URL

**Technical approach:**
- `UIDropInteraction` / `UIDragInteraction` on relevant views
- For web content in WKWebView: intercept drops via native overlay views positioned over capture area
- Process supported dropped `NSItemProvider` items through the approved capture
  contracts; URL/text use `/api/triage/capture`, while images require the
  separate image upload endpoint

---

## Post-v1 Roadmap Sequencing

```
Five-phase iOS v1.0 release
    │
    ▼
Post-v1 Quick Wins                    ← v1.1, after stable release
    │   Widgets, Live Activities, Spotlight, Haptics
    │
    ▼
Post-v1 Core Native                   ← v1.2
    │   Siri/App Intents, Apple Intelligence, Offline Storage, Focus Filters
    │
    ▼
Post-v1 Extended Surfaces             ← v1.3
    │   watchOS, Shortcuts Automations, Handoff, EventKit
    │
    ▼
Post-v1 Deep Intelligence             ← v2.0
        Core ML, App Clips, iPad Drag & Drop
```

These epics are intentionally non-gating for the App Store v1.0 release.

---

## Native Features — Key Architectural Decisions

### Shared App Group

Extensions share non-secret data through a common App Group container. The
main app and Share Extension use a separate shared Keychain access group only
for the revocable, least-privilege capture credential defined by the
[native security contract](../active/mobile-ios-native-security-contract.md).
The owner selects the production identifiers using the conventions in the
[iOS distribution operations runbook](../../development/ios-distribution-operations.md);
examples here are placeholders, not reserved identifiers:

```
App Group: group.<production-bundle-id>
├── UserDefaults (preferences, sync cursor, last-updated timestamps)
└── SwiftData store (tasks, projects, cached entities)

Keychain access group: <production-keychain-access-group>
└── Revocable Share Extension capture credential
```

### AppIntents as the Foundation

`AppIntents` is the single framework that powers **five features simultaneously**:
1. Siri voice commands
2. Shortcuts automations
3. Interactive widgets (buttons/toggles)
4. Focus Filters
5. Apple Intelligence reasoning

**Invest heavily in rich `AppEntity` definitions early** — every entity you define compounds across all five surfaces.

### Bridge Protocol Versioning

As native features grow, the JS ↔ Native bridge protocol must be versioned:

```swift
struct BridgeMessage: Codable {
    let version: Int        // Protocol version
    let action: String      // e.g., "startLiveActivity"
    let payload: [String: AnyCodable]
}
```

Web app checks `window.mcNativeBridge.version` before calling newer bridge methods.

### Privacy-First Design

All native features follow a strict privacy posture:
- ML inference: on-device only (Core ML / NaturalLanguage)
- Spotlight indexing: local only, never uploaded
- Health/location data: never collected unless user explicitly enables
- Apple Intelligence: on-device processing, no server round-trip
- Offline data: encrypted at rest via iOS Data Protection (default for App Group)

---

## Distribution Plan

### 5.1 Apple Developer Program

**Requirements:**
- Apple Developer Program enrollment: $99/year
- Bundle ID: `<owner-selected-reversed-domain>.missioncontrol` (set in Xcode)
- Provisioning profiles: Development + Distribution
- Repository conventions, CI secret names, owner actions, and evidence:
  [`docs/development/ios-distribution-operations.md`](../../development/ios-distribution-operations.md)

### 5.2 Build & Release Pipeline

```
protected release workflow
       │
       ▼
GitHub Actions: build-ios.yml on a pinned macOS/Xcode runner
  ├─ xcodebuild -scheme MissionControl -destination generic/platform=iOS archive
  ├─ Export .ipa (App Store Connect distribution)
  └─ supported App Store Connect upload tooling
       │
       ▼
App Store Connect
  ├─ TestFlight (internal → external beta)
  └─ App Store submission (manual review trigger)
```

The exact environment variables and encrypted secrets are inventoried in the
[iOS distribution operations runbook](../../development/ios-distribution-operations.md).
Apple account passwords and recovery keys are never CI inputs.

### 5.3 TestFlight Beta (Release Phase 4 Gate)

1. Upload build to App Store Connect
2. Add internal testers (team members)
3. After 1–2 weeks of internal testing → open external beta group
4. Collect feedback; fix crash reports from Xcode Organizer / Crashlytics
5. Submit to App Store only after beta is stable

**TestFlight distribution link** can be shared with anyone without App Store review — ideal for early-access users.

### 5.4 App Store Submission Checklist

Before submitting for review:

- [ ] App icon: 1024×1024px in `AppIcon.appiconset` (no alpha channel)
- [ ] Launch screen configured (no placeholder)
- [ ] Privacy manifest (`PrivacyInfo.xcprivacy`) — declare API usage (push, keychain, network)
- [ ] App Store metadata: screenshots (6.7", 6.1", iPad if submitting universal), description, keywords
- [ ] Age rating completed in App Store Connect
- [ ] Export compliance: select "Yes" for HTTPS-only network calls (no custom encryption)
- [ ] App Review information: demo account credentials or reviewer notes
- [ ] Minimum iOS version: iOS 16.0 (covers 95%+ of active devices)

### 5.5 Versioning

Follow semantic versioning surfaced in the app:

| Field | Value | Notes |
|-------|-------|-------|
| `CFBundleShortVersionString` | `1.0.0` | User-visible version |
| `CFBundleVersion` | Auto-increment (build number) | Incremented per CI build |

Keep iOS wrapper version in sync with the web app's `package.json` version.

---

## Prerequisites & Dependencies

| Dependency | Status | Notes |
|------------|--------|-------|
| Responsive web PWA baseline | Ready | Remaining gesture refinements run in parallel |
| Mobile/device validation baseline | Required | Repair test drift and validate physical-device flows |
| Native security/auth contract | Required | Defines trusted origin, bridge, Keychain, APNs, and extension auth |
| Apple signing and App Store infrastructure | Required | Provision in release Phase 1 |
| Notification policy and durable outbox | Planned | Complete before adding the APNs dispatcher channel |
| APNs device registration | Planned | Uses a channel-specific model, not Web Push VAPID rows |
| Share Sheet URL/text endpoint | Available | Use `POST /api/triage/capture` |
| Share Sheet image endpoint | Deferred | Depends on image upload/storage; OCR is separate |
| Service worker / offline page | Available | Validate behavior inside `WKWebView` |
| `window.isMCNativeApp` detection flag | Planned | Inject only on the configured trusted origin |

---

## Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Apple review rejection | Medium | High | Follow HIG strictly; avoid "web-only" appearance critique by adding meaningful native features (push, share sheet) before submission |
| Push notification opt-out rate | High | Medium | Use soft prompt before native iOS prompt; explain value clearly in onboarding |
| WKWebView cookie / session expiry | Low | High | Test session persistence across app restarts; use persistent `WKWebsiteDataStore` |
| App Store connect API key rotation | Low | Medium | Store keys in GitHub Secrets; document rotation procedure |
| iOS version fragmentation | Low | Low | Target iOS 16+ (95%+ of active devices as of 2026) |

---

## Timeline (Rough Estimates)

| Milestone | Estimated Effort |
|-----------|-----------------|
| Release Phase 1: readiness, contracts, Apple infrastructure | 3–5 days |
| Release Phase 2: hardened wrapper, bridge, URL/text Share Sheet | 4–7 days |
| Release Phase 3: notification policy/outbox integration and APNs | 4–7 days |
| Release Phase 4: TestFlight pipeline and beta gate | 1–2 weeks |
| Release Phase 5: submission preparation and Apple review | 1–2 weeks |
| **iOS v1.0 release path** | **~4–6 weeks** |
| Post-v1 quick wins | 1–2 weeks |
| Post-v1 core native features | 2–4 weeks |
| Post-v1 extended surfaces | 3–5 weeks |
| Post-v1 deep intelligence | 6–8 weeks |

---

## Success Criteria

- [ ] App installable from App Store (or TestFlight)
- [ ] All Phase 1+2 mobile web flows work identically inside the wrapper
- [ ] Push notifications delivered for morning nudge and queue threshold
- [ ] Share Sheet successfully captures URL/text into triage queue
- [ ] No App Store crashes in first 30 days (< 1% crash-free sessions threshold)
- [ ] Install-to-daily-active rate ≥ 40% within first week of install

---

*Created: 2026-07-25 | Closes #783*
