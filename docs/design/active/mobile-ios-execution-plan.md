# Mobile PWA Redesign - Execution Plan

## Project: Mission Control Mobile PWA Redesign

This execution plan describes the responsive PWA work needed to bring Mission
Control's mobile app in line with the finalized iOS-oriented mockup design
(`docs/mockups/mockup-ios-iphone-core.html`). It is the completed web baseline,
not the native Swift release plan.

The native release now follows five phases in
[`mobile-ios-wrapper-distribution.md`](../proposed/mobile-ios-wrapper-distribution.md):

1. Foundation and Readiness
2. Wrapper and Native Integrations
3. APNs and Notification Delivery
4. TestFlight Beta
5. App Store Release

Issues #932-#935 share the versioned bridge, authentication, APNs, and Share
Sheet rules in
[`mobile-ios-native-security-contract.md`](mobile-ios-native-security-contract.md).

Open mobile triage and broader Quick Sort enhancements may proceed in parallel;
they do not block starting the hardened wrapper unless physical-device
validation identifies a release-blocking defect.

---

## Phase 1: Navigation Overhaul

### 1.1 Replace Bottom Tab Bar
- Update `MobileBottomNav.tsx` to new 5-tab layout: Today | Triage | Capture | Sort | Houston
- Replace "More" tab with Houston (rocket icon from Lucide)
- Replace "Inbox" tab with Sort (zap icon)
- Make Capture button elevated/raised center position
- Add badge support: red badge on Triage (unprocessed count), amber on Sort (queue count)
- Priority: Critical
- Effort: 3

### 1.2 Create Hamburger Menu Drawer
- Build slide-out drawer component (left side, overlays content)
- Include: user avatar, search bar, navigation items (Dashboard, Projects, Goals, Notifications, Routines, Insights, Settings), sync status
- Add hamburger icon to all screen headers (top-left position)
- Implement notification dot indicator on hamburger icon
- Animate with spring transition (slide + overlay fade)
- Priority: Critical
- Effort: 4

### 1.3 Standardize Header Pattern
- Create shared mobile header component with consistent layout
- Pattern: [Hamburger + dot] [Title] [Search icon] [Context action]
- Apply across all primary screens
- Priority: High
- Effort: 2

### 1.4 Add Search Entry Points
- Search icon in header (all primary screens)
- Search bar in hamburger drawer (focuses search screen)
- Priority: High
- Effort: 2

---

## Phase 2: Today Screen Redesign

### 2.1 Redesign Today to Priority-Sorted List
- Replace timeline-based layout with compact priority-sorted task list
- Group tasks: Overdue > Due Today > Scheduled > Unscheduled
- Each row: priority dot, title, project tag, due indicator
- Add AI suggestion chips below high-priority items
- Priority: Critical
- Effort: 4

### 2.2 Implement Bottom Sheet Task Detail
- Create bottom sheet drawer component (three snap points: 40%, 60%, 90%)
- Show task detail when tapping a list item
- Include: title, description, priority, project, due date, tags, actions
- Swipe-down to dismiss (no top-left close button)
- Priority: Critical
- Effort: 4

### 2.3 Implement Swipe Gestures on Today
- Left swipe: reveal "Not Today" action (short swipe reveals, full swipe executes)
- Right swipe: reveal scheduling tray
- Scheduling tray options: Tomorrow, Pick Day, Snooze (1hr/3hr/tonight)
- Tap dot/checkbox to complete
- Add haptic feedback on swipe threshold
- Priority: High
- Effort: 4

### 2.4 Today Empty State
- Design and implement zero-task motivational state
- Show suggestions: "Add tasks", "Check triage queue", "Ask Houston"
- Priority: Medium
- Effort: 1

---

## Phase 3: Triage Redesign

### 3.1 Build Triage Stream View
- Scrollable feed of triage items with source-branded cards
- Each card shows: source icon + color, title, preview, relevance score, timestamp
- Source colors match brand (Reddit orange, GitHub purple, YouTube red, etc.)
- Filter chips at top (by source, priority, type)
- Priority: Critical
- Effort: 4

### 3.2 Build Triage Focus Mode
- Full-screen swipeable card for rapid processing
- Swipe right = Done/Accept, left = Dismiss, up = Snooze
- Show AI-suggested action as primary button
- Display relevance score and source context
- Session stats overlay (processed count, remaining, streak)
- Priority: Critical
- Effort: 5

### 3.3 Implement Proper Routing Actions
- Replace generic Keep/Plan/Defer/Archive with actual routing actions
- Actions: Save to Karakeep, Save to Knowledge Base, Create Task (GitHub), Create Task (Todo), Save to Model Catalog, Trigger Workflow, Dismiss, Snooze
- Show relevant actions based on source type
- Priority: High
- Effort: 3

### 3.4 Triage Item Detail Expansion
- Expanded card view with full metadata
- Show: full content preview, source metadata, AI analysis, all available actions
- Accessible via tap on card in stream view
- Priority: Medium
- Effort: 2

### 3.5 Triage Empty State (Inbox Zero)
- Celebration state when queue is empty
- Show stats (items processed today, streak)
- Suggest: "Check back later" or "Browse archive"
- Priority: Low
- Effort: 1

---

## Phase 4: Quick Sort Enhancement

### 4.1 Redesign Quick Sort Card Stack
- Align card-stack UI to mockup design (larger cards, better spacing)
- Top card shows: task title, current priority, AI suggestion with confidence %
- AI reasoning text below card
- Progress indicator (sorted / total remaining)
- Priority: High
- Effort: 3

### 4.2 Quick Sort Swipe Actions
- Left swipe: Accept AI suggestion
- Right swipe: Accept manual override (opens priority picker)
- Up swipe: Skip/defer
- Add animation for card departure and next-card entry
- Priority: High
- Effort: 3

### 4.3 Quick Sort Session Stats
- Track and display: time spent, items sorted, AI accuracy, streak
- Show session summary on completion
- Priority: Medium
- Effort: 2

---

## Phase 5: Houston AI Screens

### 5.1 Houston Home Screen
- Greeting with personalized daily summary
- Quick action chips: "What should I do next?", "Summarize my day", "Help me plan"
- Recent conversations list
- Proactive suggestion cards based on current context
- Priority: High
- Effort: 4

### 5.2 Houston Chat Thread
- Conversational UI with message bubbles
- Support inline action cards (create task, schedule, show insights)
- Context-aware: tie responses to current tasks/triage state
- Typing indicator and streaming response support
- Priority: High
- Effort: 5

---

## Phase 6: Supporting Screens

### 6.1 Global Search Screen
- Full-text search across tasks, projects, triage items
- Recent searches and suggested queries
- Filter chips (type, project, date range, status)
- Real-time results as user types
- Priority: High
- Effort: 3

### 6.2 Notifications Screen
- Grouped by urgency (critical, standard, low)
- Each notification: icon, title, timestamp, source
- Swipe to dismiss, tap to navigate
- Clear all and mark-read actions
- Priority: High
- Effort: 3

### 6.3 Task Edit Bottom Sheet
- Full task editor in bottom sheet format
- Fields: title, description, priority, project, due date, tags, effort, energy
- Save/cancel actions
- Keyboard-aware positioning
- Priority: High
- Effort: 3

### 6.4 Onboarding/First-Run Flow
- Welcome screen with app overview
- Permission requests (notifications, calendar access)
- Quick preference setup (work hours, priority defaults)
- Connect accounts prompt
- Priority: Medium
- Effort: 3

---

## Phase 7: Hamburger Sub-Screens (Mobile-Optimized)

### 7.1 Dashboard (Mobile)
- Compact metrics grid (tasks completed, streak, triage processed)
- Mini charts (weekly trend, priority distribution)
- Quick links to detailed views
- Priority: Medium
- Effort: 3

### 7.2 Projects Screen
- Project list with progress bars and task counts
- Tap to expand project details
- Quick-add task to project
- Priority: Medium
- Effort: 3

### 7.3 Goals Screen
- Goal cards with milestone progress visualization
- Current period progress indicators
- Link to associated tasks/projects
- Priority: Medium
- Effort: 2

### 7.4 Routines Screen
- Routine schedule with daily/weekly view
- Streak indicators and completion history
- Quick-complete from list
- Priority: Low
- Effort: 2

### 7.5 Insights Screen
- AI-generated productivity insights
- Weekly summary cards
- Trend charts and patterns
- Actionable recommendations
- Priority: Low
- Effort: 3

### 7.6 Settings Screen
- Sections: Account, Preferences, Notifications, Connected Services, Sync, About
- Toggle-based preferences
- Sync status and manual trigger
- Priority: Medium
- Effort: 3

---

## Phase 8: Polish and Platform

### 8.1 Haptic Feedback System
- Add haptic responses to all swipe actions
- Light haptic on tap, medium on swipe threshold, heavy on destructive actions
- Respect system haptic preferences
- Priority: Medium
- Effort: 2

### 8.2 Offline Support
- Optimistic UI for all actions
- Queue actions when offline, sync on reconnect
- Show offline indicator in header
- Priority: High
- Effort: 5

### 8.3 Accessibility Pass
- VoiceOver labels on all interactive elements
- Dynamic Type support across all screens
- High-contrast mode testing
- Reduce Motion alternatives for all animations
- 44px minimum tap targets audit
- Priority: High
- Effort: 4

### 8.4 Performance Optimization
- First meaningful paint under 2 seconds on LTE
- Action feedback under 100ms (optimistic UI)
- Lazy-load sub-screens from hamburger
- Image/asset optimization for mobile
- Priority: High
- Effort: 3

### 8.5 Push Notifications Integration
- Morning "Start My Day" prompt
- Triage queue threshold nudge
- End-of-day carry-forward reminder
- Respect quiet hours and calendar busy blocks
- Priority: Medium
- Effort: 3

---

## Dependencies

- Navigation established the shared mobile shell.
- Today, Triage, Sort, Houston, and supporting screens then progressed in parallel.
- Offline, accessibility, safe-area, and performance work form the native wrapper baseline.
- Remaining gesture/test drift is tracked independently and is not a blanket native prerequisite.
- Native distribution dependencies are defined only in the five-phase native release plan.

## Estimated Total Effort

- Phase 1: 11 points
- Phase 2: 13 points
- Phase 3: 15 points
- Phase 4: 8 points
- Phase 5: 9 points
- Phase 6: 12 points
- Phase 7: 16 points
- Phase 8: 17 points
- **Total: ~101 story points**

## Tags

- `mobile-ios`, `redesign`, `navigation`, `swipe-gestures`, `bottom-sheet`, `houston-ai`, `triage`, `quick-sort`, `accessibility`
